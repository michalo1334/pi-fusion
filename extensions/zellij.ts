import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type Placement =
  | { kind: "split"; direction: "right" | "down" }
  | { kind: "stacked" }
  | { kind: "tab" };

export interface LayoutSnapshot {
  columns: number;
  rows: number;
  paneCount?: number;
}

export interface Detection {
  available: boolean;
  reason?: "inactive" | "missing-executable";
  setupHint: string;
}

export const ZELLIJ_SETUP_HINT =
  "Pi Fusion requires an active Zellij session. Start Zellij, then run Pi again.";

export function detectZellij(
  env: NodeJS.ProcessEnv = process.env,
  hasBinary: boolean,
): Detection {
  if (!env.ZELLIJ && !env.ZELLIJ_SESSION_NAME) {
    return { available: false, reason: "inactive", setupHint: ZELLIJ_SETUP_HINT };
  }
  if (!hasBinary) {
    return { available: false, reason: "missing-executable", setupHint: ZELLIJ_SETUP_HINT };
  }
  return { available: true, setupHint: ZELLIJ_SETUP_HINT };
}

/** Choose a placement without querying or mutating Zellij. */
export function choosePlacement(layout: LayoutSnapshot): Placement {
  const minimumSplitColumns = 80;
  const minimumSplitRows = 24;
  const validGeometry = Number.isFinite(layout.columns)
    && Number.isFinite(layout.rows)
    && layout.columns > 0
    && layout.rows > 0;
  if (!validGeometry) return { kind: "tab" };
  if (layout.columns >= minimumSplitColumns * 2 && layout.rows >= minimumSplitRows) {
    return { kind: "split", direction: "right" };
  }
  if (layout.rows >= minimumSplitRows * 2 && layout.columns >= minimumSplitColumns) {
    return { kind: "split", direction: "down" };
  }
  if (layout.columns >= minimumSplitColumns && layout.rows >= minimumSplitRows && (layout.paneCount ?? 0) >= 1) {
    return { kind: "stacked" };
  }
  return { kind: "tab" };
}

export interface CommandExecutor {
  (file: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }>;
}

export async function hasZellijExecutable(
  executor: CommandExecutor = async (file, args) => execFileAsync(file, args),
): Promise<boolean> {
  try {
    await executor("zellij", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

const placementLockKey = Symbol.for("pi-fusion.zellij.placement-lock");
const globalState = globalThis as typeof globalThis & {
  [placementLockKey]?: Promise<void>;
};

globalState[placementLockKey] ??= Promise.resolve();

/** Serialize placement decisions across module instances and reloads. */
export async function withPlacementLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = globalState[placementLockKey]!;
  let release!: () => void;
  globalState[placementLockKey] = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

export function setupGuidance(detection: Detection): string {
  return detection.available ? "" : detection.setupHint;
}
