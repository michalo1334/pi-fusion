import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Stop only a Pi process explicitly marked as a Fusion child.
 *
 * This module is loaded by the child command, not by Fusion's public extension.
 */
export default function childRuntime(pi: ExtensionAPI): void {
  if (process.env.PI_FUSION_CHILD !== "1") return;

  let shutdownRequested = false;
  pi.on("agent_settled", (_event, ctx) => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    ctx.shutdown();
  });
}
