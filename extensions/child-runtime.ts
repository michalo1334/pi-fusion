import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { assertNoRecursiveFusionTools } from "./sidekick-policy.ts";

export interface ChildPolicyFailure { message: string; }

export function disableChildTools(pi: Pick<ExtensionAPI, "setActiveTools">): void {
  pi.setActiveTools([]);
}

export function validateChildTools(pi: Pick<ExtensionAPI, "getAllTools" | "getActiveTools" | "setActiveTools">, requested: readonly string[]): void {
  try {
    assertNoRecursiveFusionTools(requested);
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
  if (!value) throw new Error("Fusion child policy is missing PI_FUSION_TOOLS");
  return value.split(",").map(tool => tool.trim()).filter(Boolean);
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
  let shuttingDown = false;
  const fail = (ctx: { shutdown: () => void }, error: unknown) => {
    if (policyFailure) return;
    policyFailure = { message: error instanceof Error ? error.message : String(error) };
    process.exitCode = 78;
    disableChildTools(pi);
    if (!shuttingDown) { shuttingDown = true; ctx.shutdown(); }
  };
  pi.on("session_start", () => {
    disableChildTools(pi);
  });
  pi.on("input", async (_event, ctx) => {
    if (policyFailure) return { action: "handled" as const };
    let requested: string[];
    try { requested = requestedTools(); }
    catch (error) { fail(ctx, error); return { action: "handled" as const }; }
    try { await waitForTools(pi, requested); validateChildTools(pi, requested); }
    catch (error) { fail(ctx, error); return { action: "handled" as const }; }
    return policyFailure ? { action: "handled" as const } : { action: "continue" as const };
  });
  pi.on("tool_call", (event, ctx) => {
    if (policyFailure || !process.env.PI_FUSION_TOOLS?.split(",").includes(event.toolName)) {
      return { block: true, reason: policyFailure?.message ?? "Fusion child policy denied this tool" };
    }
    return undefined;
  });

  let shutdownRequested = false;
  pi.on("agent_settled", (_event, ctx) => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    ctx.shutdown();
  });
}
