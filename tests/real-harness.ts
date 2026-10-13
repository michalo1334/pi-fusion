import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { checkZellij, resolveParentPaneId } from "../extensions/child-runner.ts";

const execFileAsync = promisify(execFile);

export interface RealAvailability {
  reason?: string;
  parentPaneId?: string;
}

export async function realZellijAvailability(): Promise<RealAvailability> {
  const detection = await checkZellij(process.env);
  if (!detection.available) return { reason: `Zellij integration skipped: ${detection.reason ?? "inactive"}. ${detection.setupHint}` };
  const parentPaneId = resolveParentPaneId(process.env);
  if (!parentPaneId) return { reason: "Zellij integration skipped: ZELLIJ_PANE_ID is missing or is not a nonnegative safe numeric terminal ID." };
  try {
    const panes = await listPanes();
    const parent = panes.find(pane => !pane.is_plugin && !pane.exited && `terminal_${pane.id}` === parentPaneId);
    if (!parent) return { reason: `Zellij integration skipped: owned parent ${parentPaneId} is not present as a live terminal pane.` };
  } catch (error) {
    return { reason: `Zellij integration skipped: cannot inspect the active session (${error instanceof Error ? error.message : String(error)}).` };
  }
  return { parentPaneId };
}

export interface PaneInfo {
  id: number;
  is_plugin: boolean;
  is_focused: boolean;
  exited: boolean;
  tab_id: number;
  pane_rows?: number;
  pane_columns?: number;
}

export async function listPanes(): Promise<PaneInfo[]> {
  const result = await execFileAsync("zellij", ["action", "list-panes", "--json", "--all"], { env: process.env });
  const parsed: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(parsed)) throw new Error("Zellij list-panes did not return an array");
  return parsed.filter((value): value is PaneInfo => {
    if (!value || typeof value !== "object") return false;
    const pane = value as Record<string, unknown>;
    return typeof pane.id === "number" && typeof pane.is_plugin === "boolean"
      && typeof pane.is_focused === "boolean" && typeof pane.exited === "boolean"
      && typeof pane.tab_id === "number";
  });
}

export async function focusPane(paneId: string): Promise<void> {
  await execFileAsync("zellij", ["action", "focus-pane-id", paneId], { env: process.env });
}

export async function waitForFile(file: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${file}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

export function temporaryRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join("/tmp", `pi-fusion-${prefix}-`));
  fs.chmodSync(root, 0o700);
  return root;
}
