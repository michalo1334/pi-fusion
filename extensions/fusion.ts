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
  getAgentDir,
  keyHint,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  checkZellij,
  resolveParentPaneId,
  runChildTask,
  type ChildRunResult,
} from "./child-runner.ts";
import {
  assertNoRecursiveFusionExtensions,
  assertNoRecursiveFusionTools,
} from "./sidekick-policy.ts";

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
  sessionFile?: string;
  validForFollowUp: boolean;
  status?: string;
  /** Retain the latest run surface and artifacts for FP-08 cleanup/resume. */
  lastRun?: ChildRunResult;
}

type Task = ChildTask;

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
): { model: unknown; thinkingLevel: string } | { error: string } {
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

function availableModelSpecs(ctx: ExtensionContext): string[] {
  return ctx.modelRegistry.getAvailable().flatMap((model) => {
    if (typeof model.provider !== "string" || !model.provider) return [];
    if (typeof model.id !== "string" || !model.id) return [];
    return [`${model.provider}/${model.id}`];
  }).sort((left, right) => left.localeCompare(right));
}

async function selectSidekickModel(ctx: ExtensionContext, currentModel: string): Promise<string | undefined> {
  const specs = availableModelSpecs(ctx);
  if (specs.length === 0) {
    ctx.ui.notify("No configured models are available for the sidekick.", "error");
    return undefined;
  }
  const providers = [...new Set(specs.map((spec) => spec.slice(0, spec.indexOf("/"))))];
  const provider = await ctx.ui.select(`Sidekick provider (current: ${currentModel})`, providers);
  if (!provider) return undefined;
  return ctx.ui.select(`Sidekick model (${provider})`, specs.filter((spec) => spec.startsWith(`${provider}/`)));
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
    },
  };
}

export default function (pi: ExtensionAPI) {
  const tasks = new Map<string, Task>();
  let modelOverride: string | undefined;
  let pendingCost = 0;

  pi.on("message_end", async (event) => {
    if (event.message.role !== "assistant" || pendingCost <= 0) return;
    const usage = (event.message as any).usage;
    // Keep the amount pending when a finalized lead message has no usage
    // object. The next usable assistant message must receive the roll-forward.
    if (!usage?.cost) return;
    const add = pendingCost;
    pendingCost = 0;
    return { message: { ...event.message, usage: { ...usage, cost: { ...usage.cost, total: usage.cost.total + add } } } };
  });

  pi.registerCommand("fusion-model", {
    description: "Select or set the sidekick model for this Pi process (provider/model[:thinking])",
    handler: async (args, ctx) => {
      const arg = args?.trim();
      if (!arg) {
        const currentModel = readConfig(ctx.cwd, modelOverride).sidekickModel;
        if (!ctx.hasUI) { ctx.ui.notify(`sidekick model: ${currentModel}`, "info"); return; }
        const selected = await selectSidekickModel(ctx, currentModel);
        if (!selected) return;
        modelOverride = selected;
        ctx.ui.notify(`Sidekick model set to ${selected} for this Pi process`, "info");
        return;
      }
      const resolved = resolveSidekickModel(ctx, arg);
      if ("error" in resolved) { ctx.ui.notify(`Cannot resolve "${arg}": ${resolved.error}`, "error"); return; }
      modelOverride = arg;
      ctx.ui.notify(`Sidekick model set to ${arg} for this session`, "info");
    },
  });

  pi.registerTool({
    name: "delegate",
    label: "Delegate to sidekick",
    description: "Delegate a task to a fresh restricted child Pi in an owned Zellij pane. The tool blocks until the child turn settles and returns its report plus a task_id.",
    parameters: Type.Object({ brief: Type.String({ description: "Task brief written like a spec: goal, constraints, edge cases, and definition of done." }) }),
    renderCall(args, theme, context) { return renderPromptCall("delegate", args.brief, theme, context); },
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      // Detection is deliberately before UUIDs, artifact directories, and pane creation.
      const detection = await checkZellij(process.env);
      const parentPaneId = resolveParentPaneId(process.env);
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
      const taskId = randomUUID();
      const sessionId = randomUUID();
      const sessionDir = path.join(artifactRoot(ctx), taskId, "session");
      const task: ChildTask = { kind: "child", id: taskId, sessionId, sessionDir, validForFollowUp: true };
      tasks.set(task.id, task);
      onUpdate?.({ content: [{ type: "text", text: `Starting child sidekick ${task.id} in ${parentPaneId}...` }], details: {} });
      const result = await runChildTask({
        taskId,
        runId: randomUUID(),
        cwd: ctx.cwd,
        artifactRoot: artifactRoot(ctx),
        sessionDir,
        sessionId,
        model: modelInput(resolved.model, resolved.thinkingLevel),
        tools,
        extensions,
        childRuntimePath: childRuntimePath(),
        systemPrompt: PREAMBLE,
        prompt: params.brief,
        parentPaneId,
        timeoutMs: cfg.timeoutMinutes * 60_000,
        signal,
      });
      task.sessionFile = result.sessionFile;
      task.validForFollowUp = result.taskValid;
      task.status = result.status;
      task.lastRun = result;
      // The runner has one finalizer. Fold this run exactly once into the lead.
      pendingCost += result.costUsd;
      onUpdate?.({ content: [{ type: "text", text: `Child ${task.id}: ${result.status}` }], details: {} });
      return formatResult(task, result);
    },
  });

  pi.registerTool({
    name: "follow_up",
    label: "Follow up with sidekick",
    description: "Continue an existing sidekick task. Child-session resume is being connected in FP-08; this transitional build returns a clear error instead of creating an in-process SDK sidekick.",
    parameters: Type.Object({
      task_id: Type.String({ description: "task_id returned by delegate" }),
      message: Type.String({ description: "Feedback or additional instructions for the sidekick" }),
    }),
    renderCall(args, theme, context) { return renderPromptCall(`follow_up ${args.task_id ?? ""}`, args.message, theme, context); },
    async execute(_toolCallId, params) {
      const task = tasks.get(params.task_id);
      if (!task) {
        const known = [...tasks.keys()].join(", ") || "none";
        throw new Error(`Unknown task_id "${params.task_id}". Live tasks: ${known}. Use delegate to start a new task.`);
      }
      if (task.kind === "child") {
        throw new Error(`follow_up for child task "${task.id}" is unavailable until FP-08 session resume integration; no SDK sidekick was started.`);
      }
      throw new Error(`Unsupported transitional task "${task.id}".`);
    },
  });

  pi.on("session_shutdown", async () => {
    // FP-08 owns the process-wide active-run registry and shutdown stop sequence.
    tasks.clear();
  });
}
