/**
 * pi-fusion — lead/sidekick multi-model harness.
 *
 * The lead (this pi session, frontier model) gets two tools:
 *   - delegate(brief): spawn a fresh sidekick agent (cheap model) that runs the
 *     full task loop in its own persistent, cached context and reports back.
 *   - follow_up(task_id, message): continue an existing sidekick's context.
 *
 * Sidekick sessions run in-process via the pi SDK, persist to normal session
 * files (inspect with `pi --resume`), and inherit project AGENTS.md context.
 * See skills/fusion/SKILL.md for the delegation playbook.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  type AgentSession,
  CONFIG_DIR_NAME,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  keyHint,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
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

const PREAMBLE = `You are a sidekick agent executing a task brief from a lead engineer.

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

interface Task {
  id: string;
  session: AgentSession;
  log: string[];
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
      // Missing or invalid file: use the current values.
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
  if (slash <= 0 || slash === spec.length - 1) {
    return { error: "Use provider/model[:thinking]" };
  }

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
  return ctx.modelRegistry
    .getAvailable()
    .flatMap((model) => {
      if (typeof model.provider !== "string" || !model.provider) return [];
      if (typeof model.id !== "string" || !model.id) return [];
      return [`${model.provider}/${model.id}`];
    })
    .sort((left, right) => left.localeCompare(right));
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

  return ctx.ui.select(
    `Sidekick model (${provider})`,
    specs.filter((spec) => spec.startsWith(`${provider}/`)),
  );
}

function selectedSidekickTools(tools: string[], extensionIds: string[]): string[] {
  assertNoRecursiveFusionTools(tools);
  const invalid = tools.filter((tool) => !SUPPORTED_SIDEKICK_TOOLS.has(tool));
  if (invalid.length > 0) {
    throw new Error(`Unsupported fusion.sidekickTools values: ${invalid.join(", ")}`);
  }
  const usesMcp = tools.some((tool) => MCP_SIDEKICK_TOOLS.includes(tool as never));
  if (usesMcp && !extensionIds.includes("pi-mcp-adapter")) {
    throw new Error("fusion.sidekickTools includes MCP tools but fusion.sidekickExtensions omits pi-mcp-adapter");
  }
  return tools;
}

function selectedExtensionPaths(cwd: string, extensionIds: string[]): string[] {
  assertNoRecursiveFusionExtensions(extensionIds);
  const invalid = extensionIds.filter((extension) => !SUPPORTED_SIDEKICK_EXTENSIONS.has(extension));
  if (invalid.length > 0) {
    throw new Error(`Unsupported fusion.sidekickExtensions values: ${invalid.join(", ")}`);
  }
  const packages = path.join(cwd, CONFIG_DIR_NAME, "npm", "node_modules");
  const paths = extensionIds.map((extension) => {
    if (extension === "pi-mcp-adapter") return path.join(packages, extension, "index.ts");
    return path.join(packages, extension, "build", "adapters", "pi", "extension.js");
  });
  const missing = paths.filter((extensionPath) => !fs.existsSync(extensionPath));
  if (missing.length > 0) {
    throw new Error(`pi-fusion cannot load selected extensions: ${missing.join(", ")}`);
  }
  return paths;
}

function messageText(message: any): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block: any) => block?.type === "text" && typeof block.text === "string")
      .map((block: any) => block.text)
      .join("\n");
  }
  return "";
}

/** Final report = last assistant text; if trivially short, include the last few. */
function extractReport(session: AgentSession, sinceIndex: number): string {
  const texts = session.messages
    .slice(sinceIndex)
    .filter((m: any) => m.role === "assistant")
    .map(messageText)
    .map((t) => t.trim())
    .filter(Boolean);
  if (texts.length === 0) return "(sidekick produced no report)";
  const last = texts[texts.length - 1];
  if (last.length >= SHORT_REPORT_CHARS) return last;
  return texts.slice(-3).join("\n\n");
}

function summarizeArgs(toolName: string, args: any): string {
  let detail = "";
  if (args && typeof args === "object") {
    detail =
      args.command ??
      args.path ??
      args.pattern ??
      args.query ??
      Object.values(args).find((v) => typeof v === "string") ??
      "";
  }
  detail = String(detail).replace(/\s+/g, " ").trim();
  if (detail.length > 80) detail = `${detail.slice(0, 77)}...`;
  return detail ? `${toolName}: ${detail}` : toolName;
}

const HEAD_LINES = 6;

/** Tool-call header: tool name + head of the lead's prompt, expandable to full text. */
function renderPromptCall(name: string, prompt: string | undefined, theme: any, context: any): Text {
  const lines = (prompt ?? "").trimEnd().split("\n");
  const collapsed = !context.expanded && lines.length > HEAD_LINES;
  const shown = collapsed ? lines.slice(0, HEAD_LINES) : lines;
  let out = theme.fg("toolTitle", theme.bold(name));
  for (const line of shown) out += `\n  ${theme.fg("muted", line)}`;
  if (collapsed) {
    out += `\n  ${theme.fg("dim", `… +${lines.length - HEAD_LINES} lines (${keyHint("app.tools.expand", "to expand")})`)}`;
  }
  return new Text(out, 0, 0);
}

async function spawnSidekick(ctx: ExtensionContext, cfg: FusionConfig): Promise<AgentSession> {
  const resolved = resolveSidekickModel(ctx, cfg.sidekickModel);
  if ("error" in resolved) {
    throw new Error(
      `pi-fusion: cannot resolve sidekick model "${cfg.sidekickModel}": ${resolved.error}. Set "fusion": { "sidekickModel": "provider/model[:thinking]" } in settings.json.`,
    );
  }

  const tools = selectedSidekickTools(cfg.sidekickTools, cfg.sidekickExtensions);

  // Keep project context files such as AGENTS.md. Load only the selected package
  // extensions. The tool allowlist prevents recursive delegation and keeps the
  // unattended sidekick's capability surface explicit.
  const loader = new DefaultResourceLoader({
    cwd: ctx.cwd,
    agentDir: getAgentDir(),
    noExtensions: true,
    additionalExtensionPaths: selectedExtensionPaths(ctx.cwd, cfg.sidekickExtensions),
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
  });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd: ctx.cwd,
    model: resolved.model as never,
    thinkingLevel: resolved.thinkingLevel as never,
    tools,
    resourceLoader: loader,
    sessionManager: SessionManager.create(ctx.cwd),
  });
  return session;
}

/** Run one prompt against a sidekick with live log streaming, timeout, and lead-abort wiring. */
async function runSidekick(options: {
  task: Task;
  message: string;
  timeoutMs: number;
  signal: AbortSignal | undefined;
  onUpdate: ((partial: { content: [{ type: "text"; text: string }]; details: any }) => void) | undefined;
}): Promise<{ report: string; status: string; costUsd: number }> {
  const { task, message, timeoutMs, signal, onUpdate } = options;
  const sinceIndex = task.session.messages.length;
  let status = "ok";

  const pushLog = (line: string) => {
    task.log.push(line);
    onUpdate?.({
      content: [{ type: "text", text: task.log.slice(-MAX_LOG_LINES).join("\n") }],
      details: {},
    });
  };

  const unsubscribe = task.session.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      pushLog(`→ ${summarizeArgs(event.toolName, (event as any).args)}`);
    }
  });

  const timer = setTimeout(() => {
    status = "timeout";
    void task.session.abort();
  }, timeoutMs);
  const onAbort = () => {
    status = "aborted";
    void task.session.abort();
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    await task.session.prompt(message);
  } catch (error) {
    if (status === "ok") status = "error";
    pushLog(`sidekick error: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    unsubscribe();
  }

  const errorMessage = task.session.agent.state.errorMessage;
  if (status === "ok" && errorMessage) status = `error: ${errorMessage}`;

  const costUsd = task.session.messages
    .slice(sinceIndex)
    .reduce((sum, m: any) => sum + (m.role === "assistant" ? (m.usage?.cost?.total ?? 0) : 0), 0);

  return { report: extractReport(task.session, sinceIndex), status, costUsd };
}

function formatResult(
  task: Task,
  status: string,
  report: string,
  costUsd: number,
): { content: [{ type: "text"; text: string }]; details: any } {
  const header = [
    `task_id: ${task.id}`,
    `status: ${status}`,
    `cost_usd: ${costUsd.toFixed(4)} (included in session total)`,
    task.session.sessionFile ? `sidekick session: ${task.session.sessionFile}` : undefined,
    status !== "ok"
      ? "The sidekick was interrupted; the report below may be partial. Judge whether to follow_up, re-delegate, or handle it yourself."
      : undefined,
  ]
    .filter(Boolean)
    .join("\n");
  return {
    content: [{ type: "text", text: `${header}\n\n${report}` }],
    details: { taskId: task.id, status, sessionFile: task.session.sessionFile },
  };
}

export default function (pi: ExtensionAPI) {
  const tasks = new Map<string, Task>();
  let nextId = 1;
  let modelOverride: string | undefined;
  // Sidekick cost not yet folded into the lead session's usage totals.
  let pendingCost = 0;

  // Fold accumulated sidekick cost into the next finalized lead assistant
  // message — the footer and /session sum usage.cost.total over these.
  pi.on("message_end", async (event) => {
    if (event.message.role !== "assistant" || pendingCost <= 0) return;
    const add = pendingCost;
    pendingCost = 0;
    const usage = (event.message as any).usage;
    if (!usage?.cost) return;
    return {
      message: {
        ...event.message,
        usage: {
          ...usage,
          cost: { ...usage.cost, total: usage.cost.total + add },
        },
      },
    };
  });

  pi.registerCommand("fusion-model", {
    description: "Select or set the sidekick model for this Pi process (provider/model[:thinking])",
    handler: async (args, ctx) => {
      const arg = args?.trim();
      if (!arg) {
        const currentModel = readConfig(ctx.cwd, modelOverride).sidekickModel;
        if (!ctx.hasUI) {
          ctx.ui.notify(`sidekick model: ${currentModel}`, "info");
          return;
        }
        const selected = await selectSidekickModel(ctx, currentModel);
        if (!selected) return;
        modelOverride = selected;
        ctx.ui.notify(`Sidekick model set to ${selected} for this Pi process`, "info");
        return;
      }
      const resolved = resolveSidekickModel(ctx, arg);
      if ("error" in resolved) {
        ctx.ui.notify(`Cannot resolve "${arg}": ${resolved.error}`, "error");
        return;
      }
      modelOverride = arg;
      ctx.ui.notify(`Sidekick model set to ${arg} for this session`, "info");
    },
  });

  pi.registerTool({
    name: "delegate",
    label: "Delegate to sidekick",
    description:
      "Delegate a task to a fresh sidekick agent (cheaper model, full toolset, own context). Returns its report plus a task_id for follow_up. Load the 'fusion' skill before first use for the delegation playbook.",
    parameters: Type.Object({
      brief: Type.String({
        description:
          "Task brief written like a spec, not step-by-step instructions: goal, explicit constraints and edge cases, definition of done (e.g. tests/lint that must pass). An unstated constraint is a lost constraint.",
      }),
    }),
    renderCall(args, theme, context) {
      return renderPromptCall("delegate", args.brief, theme, context);
    },
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const cfg = readConfig(ctx.cwd, modelOverride);
      const session = await spawnSidekick(ctx, cfg);
      const task: Task = { id: `t${nextId++}`, session, log: [] };
      tasks.set(task.id, task);
      const { report, status, costUsd } = await runSidekick({
        task,
        message: PREAMBLE + params.brief,
        timeoutMs: cfg.timeoutMinutes * 60_000,
        signal,
        onUpdate,
      });
      pendingCost += costUsd;
      return formatResult(task, status, report, costUsd);
    },
  });

  pi.registerTool({
    name: "follow_up",
    label: "Follow up with sidekick",
    description:
      "Continue an existing sidekick task in its same context — it already knows the brief and everything it did so far. Use for review feedback or scope additions instead of redoing the work yourself.",
    parameters: Type.Object({
      task_id: Type.String({ description: "task_id returned by delegate" }),
      message: Type.String({
        description: "Feedback or additional instructions for the sidekick",
      }),
    }),
    renderCall(args, theme, context) {
      return renderPromptCall(`follow_up ${args.task_id ?? ""}`, args.message, theme, context);
    },
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const task = tasks.get(params.task_id);
      if (!task) {
        const known = [...tasks.keys()].join(", ") || "none";
        throw new Error(`Unknown task_id "${params.task_id}". Live tasks: ${known}. Use delegate to start a new task.`);
      }
      const cfg = readConfig(ctx.cwd, modelOverride);
      const { report, status, costUsd } = await runSidekick({
        task,
        message: params.message,
        timeoutMs: cfg.timeoutMinutes * 60_000,
        signal,
        onUpdate,
      });
      pendingCost += costUsd;
      return formatResult(task, status, report, costUsd);
    },
  });

  pi.on("session_shutdown", async () => {
    for (const task of tasks.values()) {
      try {
        task.session.dispose();
      } catch {
        // best effort
      }
    }
    tasks.clear();
  });
}
