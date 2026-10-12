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

export function choosePlacement(layout: LayoutSnapshot): Placement {
  const validGeometry = Number.isFinite(layout.columns)
    && Number.isFinite(layout.rows)
    && layout.columns > 0
    && layout.rows > 0;
  if (!validGeometry) return { kind: "tab" };
  if (layout.columns >= 160 && layout.rows >= 24) {
    return { kind: "split", direction: "right" };
  }
  if (layout.rows >= 48 && layout.columns >= 80) {
    return { kind: "split", direction: "down" };
  }
  if (layout.columns >= 80 && layout.rows >= 24 && (layout.paneCount ?? 0) > 0) {
    return { kind: "stacked" };
  }
  return { kind: "tab" };
}

export interface CommandResult { stdout: string; stderr: string; }
export interface CommandOptions {
  env?: NodeJS.ProcessEnv;
}
export interface CommandExecutor {
  (file: string, args: readonly string[], options?: CommandOptions): Promise<CommandResult>;
}
const defaultExecutor: CommandExecutor = async (file, args, options) =>
  execFileAsync(file, args, { env: options?.env ?? process.env });

export async function hasZellijExecutable(
  executor: CommandExecutor = defaultExecutor,
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

export async function withPlacementLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = globalState[placementLockKey]!;
  let release!: () => void;
  globalState[placementLockKey] = new Promise(resolve => { release = resolve; });
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

export interface ZellijSurface {
  paneId: string;
  parentPaneId: string;
}

export interface CreateSurfaceInput {
  parentPaneId: string;
  placement: Placement;
  command?: readonly string[];
  cwd?: string;
}

export interface PartialCreatedSurface {
  parentPaneId: string;
  placement: Placement;
  creationOutput: string;
  reason: string;
  /** Trusted only when the controller identified the returned terminal pane. */
  surface?: ZellijSurface;
}

export class SurfaceCreationError extends Error {
  readonly partial?: PartialCreatedSurface;
  constructor(message: string, partial?: PartialCreatedSurface) {
    super(message);
    this.name = "SurfaceCreationError";
    this.partial = partial;
  }
}

export interface ZellijOperations {
  createSurface(input: CreateSurfaceInput): Promise<ZellijSurface>;
  sendCommand(surface: ZellijSurface, scriptPath: string): Promise<void>;
  interrupt(surface: ZellijSurface): Promise<void>;
  close(surface: ZellijSurface): Promise<void>;
  paneExists(surface: ZellijSurface): Promise<boolean>;
  screen(surface: ZellijSurface, full?: boolean): Promise<string>;
}

function actionArgs(action: string, ...args: string[]): string[] {
  return ["action", action, ...args];
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function isTerminalPaneId(value: string): boolean {
  return /^terminal_\d+$/.test(value);
}

function parsePaneId(output: string): string | undefined {
  const match = output.match(/\bterminal_\d+\b/);
  return match?.[0];
}

function parseTabId(output: string): number {
  const value = Number.parseInt(output.trim(), 10);
  if (!Number.isInteger(value) || value < 0) throw new Error(`Invalid Zellij tab ID: ${output}`);
  return value;
}

interface PaneInfo {
  id: number;
  is_focused: boolean;
  exited: boolean;
  is_plugin: boolean;
  tab_id: number;
  pane_rows?: number;
  pane_columns?: number;
}

function parsePanes(stdout: string): PaneInfo[] {
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) throw new Error("Zellij list-panes returned non-array JSON");
  return parsed.filter((pane): pane is PaneInfo => {
    if (!pane || typeof pane !== "object") return false;
    const value = pane as Record<string, unknown>;
    return typeof value.id === "number"
      && typeof value.is_plugin === "boolean"
      && typeof value.is_focused === "boolean"
      && typeof value.exited === "boolean"
      && typeof value.tab_id === "number";
  });
}

function paneIdFromInfo(pane: PaneInfo): string | undefined {
  if (pane.is_plugin) return undefined;
  return `terminal_${pane.id}`;
}

/** Zellij CLI boundary. Every operation uses an explicit terminal pane ID. */
export class ZellijController implements ZellijOperations {
  private readonly execute: CommandExecutor;

  constructor(execute: CommandExecutor = defaultExecutor) {
    this.execute = execute;
  }

  async createSurface(input: CreateSurfaceInput): Promise<ZellijSurface> {
    if (!isTerminalPaneId(input.parentPaneId)) {
      throw new Error(`Invalid parent terminal pane ID: ${input.parentPaneId}`);
    }

    return withPlacementLock(async () => {
      const before = await this.listPanes();
      let createdSurface: ZellijSurface | undefined;
      try {
        createdSurface = await this.tryPlacement(input, before);
        await this.restoreFocus(input.parentPaneId);
        return createdSurface;
      } catch (error) {
        try {
          await this.restoreFocus(input.parentPaneId);
        } catch (restoreError) {
          const partial = error instanceof SurfaceCreationError ? error.partial : undefined;
          throw new SurfaceCreationError(
            `Zellij surface creation failed (${error instanceof Error ? error.message : String(error)}); `
            + `focus restoration failed (${restoreError instanceof Error ? restoreError.message : String(restoreError)})`,
            {
              parentPaneId: input.parentPaneId,
              placement: partial?.placement ?? input.placement,
              creationOutput: partial?.creationOutput ?? "",
              reason: restoreError instanceof Error ? restoreError.message : String(restoreError),
              surface: createdSurface ?? partial?.surface,
            },
          );
        }
        throw error;
      }
    });
  }

  private async tryPlacement(
    input: CreateSurfaceInput,
    before: PaneInfo[],
  ): Promise<ZellijSurface> {
    const parent = before.find(pane => !pane.is_plugin && paneIdFromInfo(pane) === input.parentPaneId);
    if (!parent) throw new Error(`Parent pane is not present: ${input.parentPaneId}`);
    const selected = choosePlacement({
      columns: parent.pane_columns ?? 0,
      rows: parent.pane_rows ?? 0,
      paneCount: before.filter(pane => !pane.is_plugin && pane.tab_id === parent.tab_id).length,
    });
    const requested = input.placement.kind === "tab"
      ? input.placement
      : selected.kind === "tab" ? ({ kind: "tab" } as const) : input.placement;
    const attempts: Placement[] = requested.kind === "split"
      ? [requested, { kind: "stacked" }, { kind: "tab" }]
      : requested.kind === "stacked" ? [requested, { kind: "tab" }] : [requested];
    for (const placement of attempts) {
      let result: CommandResult;
      try {
        result = await this.runPlacement(input, placement);
      } catch (error) {
        continue;
      }
      try {
        const paneId = placement.kind === "tab"
          ? await this.findNewTerminalInTab(before, parseTabId(result.stdout))
          : parsePaneId(result.stdout) ?? await this.findNewTerminal(before, parent.tab_id);
        return { paneId, parentPaneId: input.parentPaneId };
      } catch (error) {
        throw new SurfaceCreationError(
          `Zellij created a ${placement.kind} surface but identity could not be established`,
          { parentPaneId: input.parentPaneId, placement, creationOutput: result.stdout, reason: String(error) },
        );
      }
    }
    throw new Error("Zellij could not create a surface using the safe placement sequence");
  }

  private async runPlacement(
    input: CreateSurfaceInput,
    placement: Placement,
  ): Promise<CommandResult> {
    const command = input.command ?? ["sh"];
    if (placement.kind === "tab") {
      const args = ["action", "new-tab", "--no-focus"];
      if (input.cwd) args.push("--cwd", input.cwd);
      args.push("--", ...command);
      return this.execute("zellij", args);
    }
    const args = ["action", "new-pane", "--no-focus", "--near-current-pane",
      "--direction", placement.kind === "split" ? placement.direction : "right"];
    if (placement.kind === "stacked") args.push("--stacked");
    if (input.cwd) args.push("--cwd", input.cwd);
    args.push("--", ...command);
    const parentNumericId = input.parentPaneId.slice("terminal_".length);
    const env = { ...process.env, ZELLIJ_PANE_ID: parentNumericId };
    return this.execute("zellij", args, { env });
  }

  private async listPanes(): Promise<PaneInfo[]> {
    const result = await this.execute("zellij", actionArgs("list-panes", "--json", "--all"));
    return parsePanes(result.stdout);
  }

  private async findNewTerminal(before: PaneInfo[], tabId: number): Promise<string> {
    const after = await this.listPanes();
    const oldIds = new Set(before.filter(pane => !pane.is_plugin).map(paneIdFromInfo));
    const created = after.filter(pane => !pane.is_plugin && !pane.exited && pane.tab_id === tabId
      && !oldIds.has(paneIdFromInfo(pane)));
    if (created.length !== 1) throw new Error(`Zellij reported ${created.length} ambiguous terminal panes in parent tab`);
    return paneIdFromInfo(created[0])!;
  }

  private async findNewTerminalInTab(before: PaneInfo[], tabId: number): Promise<string> {
    const after = await this.listPanes();
    const oldIds = new Set(before.filter(pane => !pane.is_plugin).map(paneIdFromInfo));
    const created = after.filter(pane => !pane.is_plugin && !pane.exited && pane.tab_id === tabId
      && !oldIds.has(paneIdFromInfo(pane)));
    if (created.length !== 1) throw new Error(`Zellij reported ${created.length} ambiguous terminal panes in new tab ${tabId}`);
    return paneIdFromInfo(created[0])!;
  }

  private async restoreFocus(parentPaneId: string): Promise<void> {
    try {
      await this.execute("zellij", actionArgs("focus-pane-id", parentPaneId));
    } catch (error) {
      // Zellij returns an error when the requested terminal already has focus.
      // Confirm that state before treating the action as a real failure.
      const message = error instanceof Error ? error.message : String(error);
      if (!message.toLowerCase().includes("already focused")) throw error;
      const panes = await this.listPanes();
      const parent = panes.find(pane => !pane.is_plugin && paneIdFromInfo(pane) === parentPaneId);
      if (parent?.is_focused) return;
      throw error;
    }
  }

  async sendCommand(surface: ZellijSurface, scriptPath: string): Promise<void> {
    this.assertSurface(surface);
    await this.execute("zellij", actionArgs(
      "write-chars", "--pane-id", surface.paneId, shellQuote(scriptPath),
    ));
    await this.execute("zellij", actionArgs("write", "--pane-id", surface.paneId, "13"));
  }

  async interrupt(surface: ZellijSurface): Promise<void> {
    this.assertSurface(surface);
    try {
      await this.execute("zellij", actionArgs(
        "send-keys", "--pane-id", surface.paneId, "Ctrl c",
      ));
    } catch (error) {
      if (await this.paneExists(surface)) throw error;
    }
  }

  async close(surface: ZellijSurface): Promise<void> {
    this.assertSurface(surface);
    try {
      await this.execute("zellij", actionArgs("close-pane", "--pane-id", surface.paneId));
    } catch (error) {
      if (await this.paneExists(surface)) throw error;
    }
  }

  async paneExists(surface: ZellijSurface): Promise<boolean> {
    this.assertSurface(surface);
    const panes = await this.listPanes();
    return panes.some(pane => !pane.is_plugin && !pane.exited && paneIdFromInfo(pane) === surface.paneId);
  }

  async screen(surface: ZellijSurface, full = false): Promise<string> {
    this.assertSurface(surface);
    const args = actionArgs("dump-screen", "--pane-id", surface.paneId);
    if (full) args.push("--full");
    return (await this.execute("zellij", args)).stdout;
  }

  private assertSurface(surface: ZellijSurface): void {
    if (!isTerminalPaneId(surface.paneId)) {
      throw new Error(`Invalid terminal pane ID: ${surface.paneId}`);
    }
  }
}
