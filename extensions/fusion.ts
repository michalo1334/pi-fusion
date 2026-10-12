/**
 * pi-fusion — lead/sidekick multi-model harness.
 *
 * Sidekicks run as restricted child Pi TUIs in owned Zellij panes. The public
 * tools remain blocking: delegate returns only after the child turn settles.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
  type ExtensionContext,
  ModelSelectorComponent,
  getAgentDir,
  keyHint,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  checkZellij,
  resolveParentPaneId,
  runChildTask,
  type ChildModel,
  type ChildRunResult,
} from "./child-runner.ts";
import {
  assertNoRecursiveFusionExtensions,
  assertNoRecursiveFusionTools,
} from "./sidekick-policy.ts";
import { SessionIntegrityError } from "./session-parser.ts";
import { seedChildSessionFile } from "./session-lineage.ts";
import { normalizeFusionModel, persistFusionModel } from "./fusion-settings.ts";

const MAX_LOG_LINES = 30;
const SHORT_REPORT_CHARS = 200;
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const BUILTIN_SIDEKICK_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
const MCP_SIDEKICK_TOOLS = ["mcp", "mcpScript", "mcp__blender_mcp", "mcp__svelte", "mcp__web_search"] as const;
const DEFAULT_SIDEKICK_TOOLS = [...BUILTIN_SIDEKICK_TOOLS, ...MCP_SIDEKICK_TOOLS];
const SUPPORTED_SIDEKICK_TOOLS = new Set<string>(DEFAULT_SIDEKICK_TOOLS);
const SUPPORTED_SIDEKICK_EXTENSIONS = new Set(["pi-mcp-adapter", "context-mode"]);

export const PREAMBLE = `You are a sidekick agent executing a task brief from a lead engineer.

Rules:
- Carry out the complete task yourself: implement, verify (run tests/linters where applicable), and iterate until it works.
- Work autonomously. Make reasonable decisions when details are ambiguous.
- Do not commit unless the brief explicitly asks you to; the lead owns commits.
- Your FINAL message must be a complete report: what you did and why, files changed, commands run with their results, and any decisions made or open questions. Never end with a bare "Done."

TASK BRIEF
----------
`;

interface FusionConfig {
  sidekickModel: string;
  timeoutMinutes: number;
  sidekickTools: string[];
  sidekickExtensions: string[];
}

const DEFAULTS: FusionConfig = {
  sidekickModel: "anthropic/claude-sonnet-4-6:high",
  timeoutMinutes: 10,
  sidekickTools: [...DEFAULT_SIDEKICK_TOOLS],
  sidekickExtensions: ["pi-mcp-adapter", "context-mode"],
};

interface ChildTask {
  kind: "child";
  id: string;
  sessionId: string;
  sessionDir: string;
  sessionFile: string;
  parentSessionFile: string;
  cwd: string;
  artifactRoot: string;
  model: ChildModel;
  tools: string[];
  extensions: string[];
  childRuntimePath: string;
  timeoutMs: number;
  parentSessionKey: string;
  validForFollowUp: boolean;
  status?: string;
  activeRun?: { runId: string };
  cleanupPending?: boolean;
  cleanupError?: string;
  resumeAfterCleanup?: boolean;
  /** Retain the latest run surface, cursor, and evidence for follow-up. */
  lastRun?: ChildRunResult;
}

type Task = ChildTask;

type ActiveChild = {
  taskId: string;
  runId: string;
  generation: number;
  controller: AbortController;
  promise: Promise<ChildRunResult>;
  settled: boolean;
  artifactDir: string;
  cleanupPending: boolean;
  retryCleanup?: () => Promise<{ pending: boolean; errorMessage?: string }>;
  cleanupPromise?: Promise<{ pending: boolean; errorMessage?: string }>;
  lastResult?: ChildRunResult;
  onCleanup?: (state: { pending: boolean; errorMessage?: string }) => void;
};

type SessionLedger = { pendingCost: number; accountedRuns: Set<string> };

const lifecycleKey = Symbol.for("pi-fusion.child-lifecycle");
const lifecycleGlobal = globalThis as typeof globalThis & {
  [lifecycleKey]?: { generation: number; active: Map<string, ActiveChild>; ledgers: Map<string, SessionLedger> };
};
const lifecycle = lifecycleGlobal[lifecycleKey] ??= { generation: 0, active: new Map(), ledgers: new Map() };
lifecycle.ledgers ??= new Map();

function sessionLedger(key: string): SessionLedger {
  let ledger = lifecycle.ledgers.get(key);
  if (!ledger) {
    ledger = { pendingCost: 0, accountedRuns: new Set() };
    lifecycle.ledgers.set(key, ledger);
  }
  return ledger;
}

function recordRunCost(key: string, runId: string, costUsd: number): void {
  const ledger = sessionLedger(key);
  if (ledger.accountedRuns.has(runId)) return;
  ledger.accountedRuns.add(runId);
  if (Number.isFinite(costUsd) && costUsd > 0) ledger.pendingCost += costUsd;
}

function sessionKey(ctx: ExtensionContext): string {
  return `${path.resolve(ctx.sessionManager.getSessionDir())}\u0000${ctx.sessionManager.getSessionId()}`;
}

function writeCleanupEvidence(active: ActiveChild, pending: boolean, errorMessage?: string): void {
  const runDir = active.lastResult?.artifacts.runDir ?? active.artifactDir;
  if (!runDir) return;
  try {
    fs.writeFileSync(path.join(runDir, "cleanup-state.json"), JSON.stringify({
      taskId: active.taskId,
      runId: active.runId,
      pending,
      error: errorMessage,
      updatedAt: new Date().toISOString(),
    }) + "\n", { encoding: "utf8", mode: 0o600 });
  } catch {
    // The active registry remains the authoritative in-memory control record.
  }
}

/**
 * Resource reload can replace this module without dispatching session_shutdown.
 * Keep ownership in the process-global registry and cancel the old generation.
 */
async function retryActiveCleanup(run: ActiveChild): Promise<{ pending: boolean; errorMessage?: string }> {
  if (!run.retryCleanup) return { pending: run.cleanupPending, errorMessage: "No cleanup control is available" };
  if (run.cleanupPromise) return run.cleanupPromise;
  run.cleanupPromise = run.retryCleanup();
  try {
    return await run.cleanupPromise;
  } finally {
    run.cleanupPromise = undefined;
  }
}

function beginLifecycle(): number {
  lifecycle.generation += 1;
  for (const run of lifecycle.active.values()) run.controller.abort();
  void stopActiveChildren();
  return lifecycle.generation;
}

async function stopActiveChildren(): Promise<void> {
  const active = [...lifecycle.active.values()];
  for (const run of active) run.controller.abort();
  const settled = await new Promise<boolean>(resolve => {
    const timer = setTimeout(() => resolve(false), 5_000);
    Promise.allSettled(active.map(run => run.promise)).then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  if (!settled) {
    for (const run of active) writeCleanupEvidence(run, true, "Child cleanup did not settle before the bounded shutdown deadline");
    return;
  }
  for (const run of active) {
    if (lifecycle.active.get(`${run.taskId}:${run.runId}`) !== run || !run.cleanupPending || !run.retryCleanup) continue;
    try {
      const state = await retryActiveCleanup(run);
      run.cleanupPending = state.pending;
      run.onCleanup?.(state);
      writeCleanupEvidence(run, state.pending, state.errorMessage);
      if (!state.pending && lifecycle.active.get(`${run.taskId}:${run.runId}`) === run) lifecycle.active.delete(`${run.taskId}:${run.runId}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      writeCleanupEvidence(run, true, errorMessage);
    }
  }
}

type ChildTaskRunner = (input: Parameters<typeof runChildTask>[0]) => ReturnType<typeof runChildTask>;

async function runOwnedChild(
  input: Omit<Parameters<typeof runChildTask>[0], "signal">,
  parentSignal: AbortSignal | undefined,
  expectedGeneration: number,
  childRunner: ChildTaskRunner = runChildTask,
  onCleanup?: (state: { pending: boolean; errorMessage?: string }) => void,
): Promise<ChildRunResult> {
  if (lifecycle.generation !== expectedGeneration) throw new Error("Fusion lifecycle changed before child launch");
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  if (parentSignal?.aborted) controller.abort();
  else parentSignal?.addEventListener("abort", forwardAbort, { once: true });
  const key = `${input.taskId}:${input.runId}`;
  let resolveCompletion!: (result: ChildRunResult) => void;
  let rejectCompletion!: (error: unknown) => void;
  const completion = new Promise<ChildRunResult>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  // The registry observes this promise during shutdown. Consume rejection as
  // well so a synchronous launch failure cannot create an unhandled rejection.
  completion.catch(() => undefined);
  const active: ActiveChild = {
    taskId: input.taskId,
    runId: input.runId,
    generation: expectedGeneration,
    controller,
    promise: completion,
    settled: false,
    artifactDir: path.join(input.artifactRoot, input.taskId, "runs", input.runId),
    cleanupPending: false,
    onCleanup,
  };
  lifecycle.active.set(key, active);
  try {
    if (lifecycle.generation !== expectedGeneration) throw new Error("Fusion lifecycle changed before child launch");
    let promise: ReturnType<typeof childRunner>;
    try {
      promise = childRunner({ ...input, signal: controller.signal });
    } catch (error) {
      rejectCompletion(error);
      throw error;
    }
    promise.then(result => {
      active.settled = true;
      active.lastResult = result;
      active.cleanupPending = Boolean(result.cleanupPending);
      active.retryCleanup = result.retryCleanup;
      onCleanup?.({ pending: active.cleanupPending, errorMessage: result.errorMessage });
      resolveCompletion(result);
      if (!active.cleanupPending && lifecycle.active.get(key) === active) lifecycle.active.delete(key);
    }, error => {
      active.settled = true;
      rejectCompletion(error);
      if (lifecycle.active.get(key) === active) lifecycle.active.delete(key);
    });
    return await promise;
  } finally {
    parentSignal?.removeEventListener("abort", forwardAbort);
    if (!active.cleanupPending && lifecycle.active.get(key) === active) lifecycle.active.delete(key);
  }
}

function readStringArray(value: unknown, fallback: readonly string[]): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return [...fallback];
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
}

function readConfig(cwd: string, modelOverride?: string): FusionConfig {
  const cfg: FusionConfig = {
    ...DEFAULTS,
    sidekickTools: [...DEFAULTS.sidekickTools],
    sidekickExtensions: [...DEFAULTS.sidekickExtensions],
  };
  for (const file of [path.join(getAgentDir(), "settings.json"), path.join(cwd, CONFIG_DIR_NAME, "settings.json")]) {
    try {
      const json = JSON.parse(fs.readFileSync(file, "utf8"));
      if (json.fusion && typeof json.fusion === "object") Object.assign(cfg, json.fusion);
    } catch {
      // Missing or invalid settings use the current defaults.
    }
  }
  if (process.env.PI_FUSION_MODEL) cfg.sidekickModel = process.env.PI_FUSION_MODEL;
  if (modelOverride) cfg.sidekickModel = modelOverride;
  return {
    sidekickModel:
      typeof cfg.sidekickModel === "string" && cfg.sidekickModel.trim() ? cfg.sidekickModel : DEFAULTS.sidekickModel,
    timeoutMinutes:
      typeof cfg.timeoutMinutes === "number" && Number.isFinite(cfg.timeoutMinutes) && cfg.timeoutMinutes > 0
        ? cfg.timeoutMinutes
        : DEFAULTS.timeoutMinutes,
    sidekickTools: readStringArray(cfg.sidekickTools, DEFAULTS.sidekickTools),
    sidekickExtensions: readStringArray(cfg.sidekickExtensions, DEFAULTS.sidekickExtensions),
  };
}

function resolveSidekickModel(
  ctx: ExtensionContext,
  value: string,
): { model: ReturnType<ExtensionContext["modelRegistry"]["find"]>; thinkingLevel: string } | { error: string } {
  const spec = value.trim();
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash === spec.length - 1) return { error: "Use provider/model[:thinking]" };
  const provider = spec.slice(0, slash);
  let modelId = spec.slice(slash + 1);
  let thinkingLevel = "off";
  const colon = modelId.lastIndexOf(":");
  if (colon > 0) {
    const candidate = modelId.slice(colon + 1);
    if (THINKING_LEVELS.has(candidate)) {
      modelId = modelId.slice(0, colon);
      thinkingLevel = candidate;
    }
  }
  const model = ctx.modelRegistry.find(provider, modelId);
  if (!model) return { error: `Model "${provider}/${modelId}" is not available` };
  return { model, thinkingLevel };
}

function selectorRuntime(ctx: ExtensionContext): ConstructorParameters<typeof ModelSelectorComponent>[2] {
  const runtime = {
    getAvailableSnapshot: () => ctx.modelRegistry.getAvailable(),
    getModel: (provider: string, id: string) => ctx.modelRegistry.find(provider, id),
    getError: () => ctx.modelRegistry.getError(),
    refresh: (options?: { signal?: AbortSignal }) => ctx.modelRegistry.refresh(options),
  };
  // Pi exposes ModelRegistry to extensions, while the public selector expects ModelRuntime.
  return runtime as unknown as ConstructorParameters<typeof ModelSelectorComponent>[2];
}

async function selectThinking(ctx: ExtensionContext, current: string): Promise<string | undefined> {
  return ctx.ui.select(`Sidekick thinking (current: ${current})`, [...THINKING_LEVELS]);
}

export function selectedSidekickTools(tools: string[], extensionIds: string[]): string[] {
  assertNoRecursiveFusionTools(tools);
  const invalid = tools.filter((tool) => !SUPPORTED_SIDEKICK_TOOLS.has(tool));
  if (invalid.length > 0) throw new Error(`Unsupported fusion.sidekickTools values: ${invalid.join(", ")}`);
  const usesMcp = tools.some((tool) => MCP_SIDEKICK_TOOLS.includes(tool as never));
  if (usesMcp && !extensionIds.includes("pi-mcp-adapter")) {
    throw new Error("fusion.sidekickTools includes MCP tools but fusion.sidekickExtensions omits pi-mcp-adapter");
  }
  return tools;
}

export function selectedExtensionPaths(cwd: string, extensionIds: string[]): string[] {
  assertNoRecursiveFusionExtensions(extensionIds);
  const invalid = extensionIds.filter((extension) => !SUPPORTED_SIDEKICK_EXTENSIONS.has(extension));
  if (invalid.length > 0) throw new Error(`Unsupported fusion.sidekickExtensions values: ${invalid.join(", ")}`);
  const packages = path.join(cwd, CONFIG_DIR_NAME, "npm", "node_modules");
  const paths = extensionIds.map((extension) => extension === "pi-mcp-adapter"
    ? path.join(packages, extension, "index.ts")
    : path.join(packages, extension, "build", "adapters", "pi", "extension.js"));
  const missing = paths.filter((extensionPath) => !fs.existsSync(extensionPath));
  if (missing.length > 0) throw new Error(`pi-fusion cannot load selected extensions: ${missing.join(", ")}`);
  return paths;
}

function summarizeArgs(toolName: string, args: any): string {
  let detail = "";
  if (args && typeof args === "object") {
    detail = args.command ?? args.path ?? args.pattern ?? args.query ?? Object.values(args).find((v) => typeof v === "string") ?? "";
  }
  detail = String(detail).replace(/\s+/g, " ").trim();
  if (detail.length > 80) detail = `${detail.slice(0, 77)}...`;
  return detail ? `${toolName}: ${detail}` : toolName;
}

const HEAD_LINES = 6;
function renderPromptCall(name: string, prompt: string | undefined, theme: any, context: any): Text {
  const lines = (prompt ?? "").trimEnd().split("\n");
  const collapsed = !context.expanded && lines.length > HEAD_LINES;
  const shown = collapsed ? lines.slice(0, HEAD_LINES) : lines;
  let out = theme.fg("toolTitle", theme.bold(name));
  for (const line of shown) out += `\n  ${theme.fg("muted", line)}`;
  if (collapsed) out += `\n  ${theme.fg("dim", `… +${lines.length - HEAD_LINES} lines (${keyHint("app.tools.expand", "to expand")})`)}`;
  return new Text(out, 0, 0);
}

function modelInput(value: unknown, thinking: string): { provider: string; id: string; thinking: string } {
  const model = value as { provider?: unknown; id?: unknown };
  if (typeof model.provider !== "string" || typeof model.id !== "string") throw new Error("Resolved sidekick model is invalid");
  return { provider: model.provider, id: model.id, thinking };
}

function artifactRoot(ctx: ExtensionContext): string {
  // SessionManager is the installed Pi contract for the host session location.
  return path.join(ctx.sessionManager.getSessionDir(), "artifacts", ctx.sessionManager.getSessionId());
}

function childRuntimePath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "child-runtime.ts");
}

function statusMessage(result: ChildRunResult): string | undefined {
  return result.errorMessage ? `${result.status}: ${result.errorMessage}` : undefined;
}

function formatResult(task: ChildTask, result: ChildRunResult): { content: [{ type: "text"; text: string }]; details: any } {
  const header = [
    `task_id: ${task.id}`,
    `status: ${result.status}`,
    `cost_usd: ${result.costUsd.toFixed(4)} (included in session total)`,
    result.sessionFile ? `sidekick session: ${result.sessionFile}` : `sidekick session directory: ${task.sessionDir}`,
    result.status !== "ok"
      ? "The sidekick did not complete successfully; the pane and partial evidence were retained. Use follow_up only when the task is valid."
      : undefined,
    statusMessage(result),
  ].filter(Boolean).join("\n");
  return {
    content: [{ type: "text", text: `${header}\n\n${result.report}` }],
    details: {
      taskId: task.id,
      status: result.status,
      sessionFile: result.sessionFile,
      sessionDir: task.sessionDir,
      costUsd: result.costUsd,
      cleanupPending: result.cleanupPending ?? false,
      cleanupError: result.errorMessage,
    },
  };
}

export interface FusionRuntimeDependencies {
  /** Test seam. Production uses the blocking child runner. */
  runChildTask?: ChildTaskRunner;
  /** Test seams avoid probing or mutating the host Zellij session. */
  checkZellij?: typeof checkZellij;
  resolveParentPaneId?: typeof resolveParentPaneId;
}

export function createFusionExtension(pi: ExtensionAPI, dependencies: FusionRuntimeDependencies = {}): void {
  const childRunner = dependencies.runChildTask ?? runChildTask;
  const detectZellij = dependencies.checkZellij ?? checkZellij;
  const getParentPaneId = dependencies.resolveParentPaneId ?? resolveParentPaneId;
  const generation = beginLifecycle();
  const tasks = new Map<string, Task>();
  let modelOverride: string | undefined;
  let parentSessionKey: string | undefined;
  let disposed = false;
  const current = () => !disposed && lifecycle.generation === generation;

  pi.on("session_start", async (_event, ctx) => {
    parentSessionKey = sessionKey(ctx);
    sessionLedger(parentSessionKey);
  });

  pi.on("message_end", async (event) => {
    const ledger = parentSessionKey ? lifecycle.ledgers.get(parentSessionKey) : undefined;
    if (!current() || event.message.role !== "assistant" || !ledger || ledger.pendingCost <= 0) return;
    const usage = (event.message as any).usage;
    // Keep the amount pending when a finalized lead message has no usage
    // object. The next usable assistant message receives the roll-forward.
    if (!usage?.cost) return;
    const add = ledger.pendingCost;
    ledger.pendingCost = 0;
    return { message: { ...event.message, usage: { ...usage, cost: { ...usage.cost, total: usage.cost.total + add } } } };
  });

  const runTask = async (
    task: ChildTask,
    prompt: string,
    parentPaneId: string,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    requireExistingSession = false,
  ): Promise<ChildRunResult> => {
    if (!current()) throw new Error("Fusion lifecycle changed before child launch");
    if (task.activeRun) throw new Error(`Task "${task.id}" is busy with run "${task.activeRun.runId}".`);
    const runId = randomUUID();
    task.activeRun = { runId };
    try {
      return await runOwnedChild({
        taskId: task.id,
        runId,
        cwd: task.cwd,
        artifactRoot: task.artifactRoot,
        sessionDir: task.sessionDir,
        sessionId: task.sessionId,
        sessionFile: task.sessionFile,
        parentSessionFile: task.parentSessionFile,
        model: task.model,
        tools: task.tools,
        extensions: task.extensions,
        childRuntimePath: task.childRuntimePath,
        systemPrompt: PREAMBLE,
        prompt,
        parentPaneId,
        timeoutMs,
        requireExistingSession,
        expectedSessionCursor: requireExistingSession ? task.lastRun?.cursor : undefined,
      }, signal, generation, childRunner, state => {
        if (!current()) return;
        task.cleanupPending = state.pending;
        task.cleanupError = state.errorMessage;
        if (!state.pending && task.resumeAfterCleanup) task.validForFollowUp = true;
      });
    } finally {
      if (task.activeRun?.runId === runId) delete task.activeRun;
    }
  };

  const acceptResult = (task: ChildTask, result: ChildRunResult, onUpdate?: (update: any) => void): void => {
    recordRunCost(task.parentSessionKey, result.runId, result.costUsd);
    if (!current()) return;
    task.cleanupPending = result.cleanupPending;
    task.cleanupError = result.errorMessage;
    if (result.sessionFile && path.resolve(result.sessionFile) !== path.resolve(task.sessionFile)) {
      task.validForFollowUp = false;
      task.resumeAfterCleanup = false;
      task.cleanupError = `Child runner returned an unexpected session file: ${result.sessionFile}`;
    }
    // A complete cursor and a matching session file are required. This keeps
    // malformed or partial records from being resumed unsafely.
    const exactSession = !result.sessionFile || path.resolve(result.sessionFile) === path.resolve(task.sessionFile);
    task.resumeAfterCleanup = exactSession && result.taskValid && Boolean(result.sessionFile && result.cursor);
    task.validForFollowUp = task.resumeAfterCleanup && !result.cleanupPending;
    task.status = result.status;
    task.lastRun = result;
    // The process-global session ledger owns cost attribution.
    onUpdate?.({ content: [{ type: "text", text: `Child ${task.id}: ${result.status}` }], details: {} });
  };

  pi.registerCommand("fusion-model", {
    description: "Select or set the sidekick model (provider/model[:thinking])",
    handler: async (args, ctx) => {
      const arg = args?.trim();
      const current = readConfig(ctx.cwd, modelOverride).sidekickModel;
      let currentNormalized: string | undefined;
      let candidate: string | undefined;
      if (!arg) {
        try { currentNormalized = normalizeFusionModel(current); }
        catch (error) {
          ctx.ui.notify(`Cannot use saved Fusion model "${current}": ${error instanceof Error ? error.message : String(error)}. Provide a complete provider/model[:thinking] value to repair it.`, "error");
          return;
        }
        if (!ctx.hasUI) { ctx.ui.notify(`sidekick model: ${currentNormalized}`, "info"); return; }
        if (ctx.mode !== "tui") {
          ctx.ui.notify("The no-argument model picker requires TUI mode. Pass provider/model[:thinking] directly in RPC or other non-TUI modes.", "error");
          return;
        }
        if (typeof ctx.ui.custom !== "function") { ctx.ui.notify("Model selector is unavailable in this Pi UI.", "error"); return; }
        const selected = await ctx.ui.custom((tui, _theme, _keys, done) => {
          const currentModel = resolveSidekickModel(ctx, currentNormalized!);
          const selector = new ModelSelectorComponent(
            tui,
            "error" in currentModel ? undefined : currentModel.model,
            selectorRuntime(ctx),
            ctx.scopedModels,
            model => done(`${model.provider}/${model.id}`),
            () => done(undefined),
          );
          return selector;
        });
        if (!selected) return;
        const thinking = await selectThinking(ctx, currentNormalized.slice(currentNormalized.lastIndexOf(":") + 1));
        if (!thinking) return;
        candidate = `${selected}:${thinking}`;
      } else {
        try {
          const normalized = normalizeFusionModel(arg);
          const colon = normalized.lastIndexOf(":");
          const resolved = resolveSidekickModel(ctx, normalized);
          if ("error" in resolved) throw new Error(resolved.error);
          candidate = normalized;
          if (!arg.includes(":") && ctx.hasUI) {
            try { currentNormalized ??= normalizeFusionModel(current); }
            catch (error) { throw new Error(`Saved Fusion model is invalid (${error instanceof Error ? error.message : String(error)}); provide a complete provider/model:thinking value`); }
            const thinking = await selectThinking(ctx, currentNormalized.slice(currentNormalized.lastIndexOf(":") + 1));
            if (!thinking) return;
            candidate = `${normalized.slice(0, colon)}:${thinking}`;
          }
        } catch (error) {
          ctx.ui.notify(`Cannot resolve "${arg}": ${error instanceof Error ? error.message : String(error)}`, "error");
          return;
        }
      }
      const normalized = normalizeFusionModel(candidate!);
      const resolved = resolveSidekickModel(ctx, normalized);
      if ("error" in resolved) { ctx.ui.notify(`Cannot resolve "${normalized}": ${resolved.error}`, "error"); return; }
      const settingsFile = path.join(ctx.cwd, CONFIG_DIR_NAME, "settings.json");
      try { persistFusionModel(settingsFile, normalized); }
      catch (error) { ctx.ui.notify(`Cannot persist Fusion model: ${error instanceof Error ? error.message : String(error)}`, "error"); return; }
      modelOverride = normalized;
      ctx.ui.notify(`Sidekick model set to ${normalized}; saved to ${settingsFile}`, "info");
    },
  });

  pi.registerTool({
    name: "delegate",
    label: "Delegate to sidekick",
    description: "Delegate a task to a fresh restricted child Pi in an owned Zellij pane. The tool blocks until the child turn settles and returns its report plus a task_id.",
    parameters: Type.Object({ brief: Type.String({ description: "Task brief written like a spec: goal, constraints, edge cases, and definition of done." }) }),
    renderCall(args, theme, context) { return renderPromptCall("delegate", args.brief, theme, context); },
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      // Detection and launch preparation must not create persistent child state.
      // Keep this guard before the first awaited operation.
      if (signal?.aborted) throw new Error("Child run was cancelled before allocation");
      const detection = await detectZellij(process.env);
      if (!current()) throw new Error("Fusion lifecycle changed before child launch");
      if (signal?.aborted) throw new Error("Child run was cancelled before allocation");
      const parentPaneId = getParentPaneId(process.env);
      if (!detection.available || !parentPaneId) {
        throw new Error(detection.setupHint + (parentPaneId ? "" : " ZELLIJ_PANE_ID is missing from the host Pi environment."));
      }
      const cfg = readConfig(ctx.cwd, modelOverride);
      const resolved = resolveSidekickModel(ctx, cfg.sidekickModel);
      if ("error" in resolved) {
        throw new Error(`pi-fusion: cannot resolve sidekick model "${cfg.sidekickModel}": ${resolved.error}`);
      }
      const tools = selectedSidekickTools(cfg.sidekickTools, cfg.sidekickExtensions);
      const extensions = selectedExtensionPaths(ctx.cwd, cfg.sidekickExtensions);
      if (signal?.aborted) throw new Error("Child run was cancelled before allocation");
      const taskId = randomUUID();
      const sessionId = randomUUID();
      if (!current()) throw new Error("Fusion lifecycle changed before child launch");
      const parentSessionFile = ctx.sessionManager.getSessionFile();
      if (signal?.aborted) throw new Error("Child run was cancelled before allocation");
      if (!parentSessionFile) {
        throw new Error("pi-fusion cannot group the child under the lead: the lead session has no persisted session file");
      }
      parentSessionKey = sessionKey(ctx);
      sessionLedger(parentSessionKey);
      const root = artifactRoot(ctx);
      // Keep run artifacts private under artifacts. Keep the child session in
      // the lead directory so Pi's normal session list can discover it.
      const sessionDir = ctx.sessionManager.getSessionDir();
      const sessionFile = seedChildSessionFile({
        parentSessionFile,
        childCwd: ctx.cwd,
        sessionDir,
        childSessionId: sessionId,
      });
      const task: ChildTask = {
        kind: "child", id: taskId, sessionId, sessionDir, sessionFile, parentSessionFile, cwd: ctx.cwd, artifactRoot: root,
        model: modelInput(resolved.model, resolved.thinkingLevel), tools: [...tools], extensions: [...extensions],
        childRuntimePath: childRuntimePath(), timeoutMs: cfg.timeoutMinutes * 60_000,
        parentSessionKey, validForFollowUp: true,
      };
      tasks.set(task.id, task);
      onUpdate?.({ content: [{ type: "text", text: `Starting child sidekick ${task.id} in ${parentPaneId}...` }], details: {} });
      const result = await runTask(task, params.brief, parentPaneId, task.timeoutMs, signal);
      acceptResult(task, result, onUpdate);
      return formatResult(task, result);
    },
  });

  pi.registerTool({
    name: "follow_up",
    label: "Follow up with sidekick",
    description: "Continue an existing sidekick task in a new restricted child Pi pane. The child resumes the saved session and the tool blocks until the new turn settles.",
    parameters: Type.Object({
      task_id: Type.String({ description: "task_id returned by delegate" }),
      message: Type.String({ description: "Feedback or additional instructions for the sidekick" }),
    }),
    renderCall(args, theme, context) { return renderPromptCall(`follow_up ${args.task_id ?? ""}`, args.message, theme, context); },
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const task = tasks.get(params.task_id);
      if (!task) {
        const known = [...tasks.keys()].join(", ") || "none";
        throw new Error(`Unknown task_id "${params.task_id}". Live tasks: ${known}. Use delegate to start a new task.`);
      }
      if (task.activeRun) throw new Error(`Task "${task.id}" is busy with run "${task.activeRun.runId}".`);
      if (task.cleanupPending) throw new Error(`Task "${task.id}" has unresolved child cleanup${task.cleanupError ? `: ${task.cleanupError}` : ""}.`);
      if (!task.validForFollowUp || !task.sessionFile || !task.lastRun?.cursor) {
        throw new Error(`Task "${task.id}" cannot resume because its session record is missing or invalid.`);
      }
      const detection = await detectZellij(process.env);
      if (!current()) throw new Error("Fusion lifecycle changed before child launch");
      const parentPaneId = getParentPaneId(process.env);
      if (!detection.available || !parentPaneId) {
        throw new Error(detection.setupHint + (parentPaneId ? "" : " ZELLIJ_PANE_ID is missing from the host Pi environment."));
      }
      // Resolve defaults at follow-up launch time. The task's model remains
      // diagnostic history only; it must not become a stale default source.
      const cfg = readConfig(ctx.cwd, modelOverride);
      const resolved = resolveSidekickModel(ctx, cfg.sidekickModel);
      if ("error" in resolved) {
        throw new Error(`pi-fusion: cannot resolve sidekick model "${cfg.sidekickModel}": ${resolved.error}`);
      }
      task.model = modelInput(resolved.model, resolved.thinkingLevel);
      let result: ChildRunResult;
      try {
        result = await runTask(task, params.message, parentPaneId, task.timeoutMs, signal, true);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof SessionIntegrityError || /saved child session|session prefix|session cursor/i.test(message)) {
          task.validForFollowUp = false;
        }
        throw error;
      }
      acceptResult(task, result, onUpdate);
      return formatResult(task, result);
    },
  });

  pi.on("session_shutdown", async () => {
    if (lifecycle.generation !== generation) return;
    disposed = true;
    // Abort first, then await the runner's bounded handshake. The runner owns
    // PID fingerprints and never closes an inspection pane on this path.
    await stopActiveChildren();
    tasks.clear();
  });
}

export default function (pi: ExtensionAPI) {
  createFusionExtension(pi);
}
