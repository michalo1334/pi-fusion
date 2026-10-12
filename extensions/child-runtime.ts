import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { assertNoRecursiveFusionTools } from "./sidekick-policy.ts";
import { writeRuntimeError } from "./child-process.ts";

export interface ChildPolicyFailure { message: string; }

export function disableChildTools(pi: Pick<ExtensionAPI, "setActiveTools">): void {
  pi.setActiveTools([]);
}

export function validateChildTools(pi: Pick<ExtensionAPI, "getAllTools" | "getActiveTools" | "setActiveTools">, requested: readonly string[]): void {
  try {
    assertNoRecursiveFusionTools(requested);
    // This checks the names declared to Pi. An opaque adapter name can still
    // reach capabilities controlled by that adapter or its server.
    const available = new Set(pi.getAllTools().map(tool => tool.name));
    const missing = requested.filter(tool => !available.has(tool));
    if (missing.length > 0) throw new Error(`Fusion child policy rejected missing tools: ${missing.join(", ")}`);
    pi.setActiveTools([...requested]);
    const active = pi.getActiveTools();
    const extra = active.filter(tool => !requested.includes(tool));
    const absent = requested.filter(tool => !active.includes(tool));
    if (extra.length > 0 || absent.length > 0) {
      throw new Error(`Fusion child policy could not enforce exact tools (missing: ${absent.join(", ") || "none"}; extra: ${extra.join(", ") || "none"})`);
    }
  } catch (error) {
    disableChildTools(pi);
    throw error;
  }
}

function requestedTools(): string[] {
  const value = process.env.PI_FUSION_TOOLS;
  if (!value || value.trim() === "") throw new Error("Fusion child policy is missing PI_FUSION_TOOLS");
  const tools = value.split(",").map(tool => tool.trim());
  if (tools.some(tool => !tool)) throw new Error("Fusion child policy has a malformed PI_FUSION_TOOLS list");
  if (new Set(tools).size !== tools.length) throw new Error("Fusion child policy has duplicate PI_FUSION_TOOLS entries");
  assertNoRecursiveFusionTools(tools);
  return tools;
}

function deadlineMs(): number {
  const value = Number(process.env.PI_FUSION_POLICY_DEADLINE_MS ?? "2000");
  return Number.isFinite(value) && value >= 0 && value <= 10000 ? value : 2000;
}

async function waitForTools(pi: Pick<ExtensionAPI, "getAllTools">, requested: readonly string[], now = () => Date.now(), sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))): Promise<void> {
  const deadline = now() + deadlineMs();
  while (true) {
    const available = new Set(pi.getAllTools().map(tool => tool.name));
    const missing = requested.filter(tool => !available.has(tool));
    if (missing.length === 0) return;
    if (now() >= deadline) throw new Error(`Fusion child policy rejected missing tools after readiness deadline: ${missing.join(", ")}`);
    await sleep(Math.min(10, Math.max(1, deadline - now())));
  }
}

/**
 * Stop only a Pi process explicitly marked as a Fusion child.
 *
 * This module is loaded by the child command, not by Fusion's public extension.
 */
export default function childRuntime(pi: ExtensionAPI): void {
  if (process.env.PI_FUSION_CHILD !== "1") return;

  let policyFailure: ChildPolicyFailure | undefined;
  let requested: string[] | undefined;
  let pendingRuntimeError: string | undefined;
  let shuttingDown = false;
  const recordRuntimeError = (message: string) => {
    const runId = process.env.PI_FUSION_RUN_ID;
    const file = process.env.PI_FUSION_RUNTIME_ERROR_PATH;
    if (!runId || !file) return;
    try { writeRuntimeError(file, runId, message); }
    catch (error) {
      // Keep the child non-zero if the diagnostic sidecar cannot be written.
      process.exitCode = 78;
      pendingRuntimeError = `${message}; could not write runtime error sidecar: ${error instanceof Error ? error.message : String(error)}`;
    }
  };
  const fail = (ctx: { abort?: () => void; shutdown: () => void }, error: unknown) => {
    if (policyFailure) return;
    policyFailure = { message: error instanceof Error ? error.message : String(error) };
    process.exitCode = 78;
    disableChildTools(pi);
    recordRuntimeError(`Fusion child policy failure: ${policyFailure.message}`);
    // A before_agent_start shutdown alone is not a model-turn cancellation.
    // Abort first, then request process shutdown after the aborted turn settles.
    ctx.abort?.();
    if (!shuttingDown) { shuttingDown = true; ctx.shutdown(); }
  };
  pi.on("session_start", () => {
    disableChildTools(pi);
  });
  pi.on("input", (_event, ctx) => {
    if (policyFailure) return { action: "handled" as const };
    try { requested = requestedTools(); }
    catch (error) { fail(ctx, error); return { action: "handled" as const }; }
    // Do not await lazy extension tools here. Pi waits for input handlers before
    // it emits before_agent_start, where context-mode starts its bridge.
    return { action: "continue" as const };
  });
  pi.on("before_agent_start", async (_event, ctx) => {
    if (policyFailure) return;
    if (!requested) {
      fail(ctx, new Error("Fusion child policy was not validated during input"));
      return;
    }
    try {
      // Child argv loads configured trusted extensions before this runtime, so
      // their before_agent_start hooks can register lazy tools before validation.
      await waitForTools(pi, requested);
      validateChildTools(pi, requested);
    } catch (error) { fail(ctx, error); }
  });
  // Pi starts the agent after before_agent_start. A failed validation must also
  // abort that newly active run, before it can dispatch a provider request.
  pi.on("agent_start", (_event, ctx) => {
    if (policyFailure) ctx.abort();
  });
  pi.on("tool_call", (event, ctx) => {
    if (policyFailure || !requested?.includes(event.toolName)) {
      return { block: true, reason: policyFailure?.message ?? "Fusion child policy denied this tool" };
    }
    return undefined;
  });

  pi.on("agent_end", (event) => {
    const failures = event.messages
      .map(message => {
        const value = message as unknown as { stopReason?: string; errorMessage?: string };
        if (value.stopReason !== "error") return undefined;
        return value.errorMessage?.trim() || "Child Pi reported a provider or runtime error";
      })
      .filter((message): message is string => Boolean(message));
    pendingRuntimeError = failures.at(-1);
  });

  let shutdownRequested = false;
  pi.on("agent_settled", (event, ctx) => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    if (!event.aborted && pendingRuntimeError) recordRuntimeError(`Fusion child runtime failure: ${pendingRuntimeError}`);
    ctx.shutdown();
  });
}
