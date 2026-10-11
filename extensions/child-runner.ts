import * as fs from "node:fs";
import * as path from "node:path";
import {
  allocateRunArtifacts,
  captureSessionCursor,
  createLaunchCommand,
  createPromptArtifact,
  pollRun,
  readIncrementalResult,
  requestRunCancellation,
  stopOwnedChild,
  type ChildLaunchSpec,
  type ExitRecord,
  type RunArtifacts,
} from "./child-process.ts";
import { SessionIntegrityError, type SessionCursor } from "./session-parser.ts";
import {
  detectZellij,
  hasZellijExecutable,
  type Detection,
  type ZellijOperations,
  type ZellijSurface,
  ZellijController,
} from "./zellij.ts";

export type ChildRunStatus = "ok" | "error" | "aborted" | "timeout";

export interface ChildModel {
  provider: string;
  id: string;
  thinking: string;
}

export interface ChildRunInput {
  taskId: string;
  runId: string;
  cwd: string;
  artifactRoot: string;
  sessionDir: string;
  sessionId: string;
  model: ChildModel;
  tools: string[];
  extensions: string[];
  childRuntimePath: string;
  systemPrompt: string;
  prompt: string;
  parentPaneId: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ChildRunResult {
  taskId: string;
  runId: string;
  status: ChildRunStatus;
  report: string;
  costUsd: number;
  sessionFile?: string;
  sessionDir: string;
  cursor?: SessionCursor;
  artifacts: RunArtifacts;
  surface?: ZellijSurface;
  errorMessage?: string;
  taskValid: boolean;
}

export interface ChildRunnerDependencies {
  zellij?: ZellijOperations;
  sleep?: (ms: number) => Promise<void>;
  findSessionFile?: (sessionDir: string, sessionId: string) => string | undefined;
}

const FALLBACK_REPORT = "(sidekick produced no report)";

export function resolveParentPaneId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env.ZELLIJ_PANE_ID?.trim();
  if (!value || !/^\d+$/.test(value) || Number(value) <= 0) return undefined;
  return `terminal_${value}`;
}

export function zellijAvailability(env: NodeJS.ProcessEnv, hasBinary: boolean): Detection {
  return detectZellij(env, hasBinary);
}

function mkdirPrivate(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

function defaultFindSessionFile(sessionDir: string, sessionId: string): string | undefined {
  if (!fs.existsSync(sessionDir)) return undefined;
  const names = fs.readdirSync(sessionDir).filter((name) => name.endsWith(".jsonl"));
  for (const name of names) {
    const file = path.join(sessionDir, name);
    try {
      const first = fs.readFileSync(file, "utf8").split("\n", 1)[0];
      const header = JSON.parse(first) as { type?: string; id?: string };
      if (header.type === "session" && header.id === sessionId) return file;
    } catch {
      // Pi can create the file while the header is still being written.
    }
  }
  return undefined;
}

async function waitForSessionFile(
  sessionDir: string,
  sessionId: string,
  find: (sessionDir: string, sessionId: string) => string | undefined,
  sleep: (ms: number) => Promise<void>,
  timeoutMs = 1_000,
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const file = find(sessionDir, sessionId);
    if (file) return file;
    await sleep(10);
  }
  return find(sessionDir, sessionId);
}

function statusFromPoll(kind: string): ChildRunStatus {
  if (kind === "aborted") return "aborted";
  if (kind === "timeout") return "timeout";
  return "error";
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const partial = error && typeof error === "object" && "partial" in error
    ? (error as { partial?: { placement?: unknown; creationOutput?: string; reason?: string; surface?: ZellijSurface } }).partial
    : undefined;
  if (!partial) return message;
  return `${message}; partial surface evidence: placement=${JSON.stringify(partial.placement)}, output=${partial.creationOutput ?? ""}, reason=${partial.reason ?? "unknown"}`;
}

type Evidence = {
  report: string;
  costUsd: number;
  sessionFile?: string;
  cursor?: SessionCursor;
  errorMessage?: string;
  taskValid: boolean;
  outcome?: "success" | "error" | "aborted";
};

async function readAvailableEvidence(
  input: ChildRunInput,
  preRunCursor: SessionCursor,
  findSessionFile: (sessionDir: string, sessionId: string) => string | undefined,
  sleep: (ms: number) => Promise<void>,
  exitRecord?: ExitRecord,
): Promise<Evidence> {
  const sessionFile = await waitForSessionFile(input.sessionDir, input.sessionId, findSessionFile, sleep);
  if (!sessionFile) return { report: FALLBACK_REPORT, costUsd: 0, taskValid: true };
  try {
    const parsed = await readIncrementalResult(sessionFile, preRunCursor, {
      processExited: Boolean(exitRecord),
      exitStatus: exitRecord
        ? { exitCode: exitRecord.exitCode, error: exitRecord.error }
        : undefined,
      probeIntervalMs: 5,
      stabilityTimeoutMs: 750,
    });
    return {
      report: parsed.report || FALLBACK_REPORT,
      costUsd: parsed.usage.cost.total,
      sessionFile,
      cursor: parsed.partialTail ? undefined : parsed.cursor,
      taskValid: !parsed.partialTail,
      errorMessage: parsed.errorMessage,
      outcome: parsed.outcome,
    };
  } catch (error) {
    const integrity = error instanceof SessionIntegrityError ? error : undefined;
    return {
      report: integrity?.partialReport ?? FALLBACK_REPORT,
      costUsd: integrity?.partialUsage?.cost.total ?? 0,
      sessionFile,
      taskValid: false,
      errorMessage: errorText(error),
    };
  }
}

function joinErrors(...values: Array<string | undefined>): string | undefined {
  const messages = values.filter((value): value is string => Boolean(value && value.trim()));
  return messages.length > 0 ? messages.join("; ") : undefined;
}

/**
 * Run one child Pi turn in one owned Zellij surface. The caller must perform
 * environment detection before calling this function. The function owns one
 * finalization path and records cancellation intent in the run artifacts.
 */
export async function runChildTask(
  input: ChildRunInput,
  dependencies: ChildRunnerDependencies = {},
): Promise<ChildRunResult> {
  // This check must happen before UUID artifacts, wrappers, or pane creation.
  if (input.signal?.aborted) throw new Error("Child run was cancelled before allocation");

  const sleep = dependencies.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const controller = dependencies.zellij ?? new ZellijController();
  const findSessionFile = dependencies.findSessionFile ?? defaultFindSessionFile;
  const artifacts = allocateRunArtifacts(input.artifactRoot, input.taskId, input.runId);
  mkdirPrivate(input.sessionDir);
  const existingSessionFile = findSessionFile(input.sessionDir, input.sessionId);
  const preRunCursor: SessionCursor = existingSessionFile
    ? captureSessionCursor(existingSessionFile)
    : { byteOffset: 0 };

  const launchSpec: ChildLaunchSpec = {
    taskId: input.taskId,
    runId: input.runId,
    cwd: input.cwd,
    artifactRoot: input.artifactRoot,
    sessionDir: input.sessionDir,
    sessionId: input.sessionId,
    model: input.model,
    tools: input.tools,
    extensions: input.extensions,
    promptPath: artifacts.promptPath,
    systemPromptPath: artifacts.systemPromptPath,
    childRuntimePath: input.childRuntimePath,
    holdFailurePane: true,
  };
  createPromptArtifact(artifacts.promptPath, input.prompt);
  createPromptArtifact(artifacts.systemPromptPath, input.systemPrompt);

  let cancellationRequested = false;
  let abortObserved = false;
  let cancellationError: string | undefined;
  const requestCancellation = () => {
    if (cancellationRequested) return;
    cancellationRequested = true;
    try { requestRunCancellation(artifacts.cancelPath, input.runId); }
    catch (error) { cancellationError = `cancellation handshake failed: ${errorText(error)}`; }
  };
  const onAbort = () => { abortObserved = true; requestCancellation(); };
  input.signal?.addEventListener("abort", onAbort, { once: true });
  if (input.signal?.aborted) { abortObserved = true; requestCancellation(); }

  let surface: ZellijSurface | undefined;
  let stopStarted = false;
  let closeStarted = false;
  let finalized = false;
  let stopError: string | undefined;

  const stopChild = async (): Promise<string | undefined> => {
    if (stopStarted) return stopError;
    stopStarted = true;
    requestCancellation();
    const errors: string[] = [];
    if (cancellationError) errors.push(cancellationError);
    if (surface) {
      try { await controller.interrupt(surface); }
      catch (error) { errors.push(`pane interrupt failed: ${errorText(error)}`); }
    }
    // The wrapper checks the cancellation marker before spawn. If it is already
    // running, wait for ownership or its exit record, then stop the verified PID.
    const deadline = Date.now() + 1_500;
    while (!fs.existsSync(artifacts.pidPath) && !fs.existsSync(artifacts.exitPath) && Date.now() < deadline) {
      await sleep(10);
    }
    if (fs.existsSync(artifacts.pidPath) && !fs.existsSync(artifacts.exitPath)) {
      try {
        await stopOwnedChild({
          pidPath: artifacts.pidPath,
          runId: input.runId,
          interrupt: async () => {
            if (surface) {
              try { await controller.interrupt(surface); }
              catch (error) { errors.push(`pane interrupt retry failed: ${errorText(error)}`); }
            }
          },
        });
      } catch (error) {
        errors.push(`owned child termination failed: ${errorText(error)}`);
      }
    } else if (!fs.existsSync(artifacts.exitPath)) {
      errors.push("owned child did not establish a PID or exit record before the stop deadline");
    }
    stopError = errors.length > 0 ? errors.join("; ") : undefined;
    return stopError;
  };

  const closeSurface = async (): Promise<Error | undefined> => {
    if (!surface || closeStarted) return undefined;
    closeStarted = true;
    try { await controller.close(surface); return undefined; }
    catch (error) { return new Error(`Child completed but its Zellij pane could not close: ${errorText(error)}`); }
  };

  const baseResult = (status: ChildRunStatus, evidence: Evidence, errorMessage?: string): ChildRunResult => ({
    taskId: input.taskId,
    runId: input.runId,
    status,
    report: evidence.report || FALLBACK_REPORT,
    costUsd: evidence.costUsd,
    sessionFile: evidence.sessionFile,
    sessionDir: input.sessionDir,
    cursor: evidence.cursor,
    artifacts,
    surface,
    errorMessage: joinErrors(evidence.errorMessage, errorMessage),
    taskValid: evidence.taskValid,
  });

  try {
    if (cancellationRequested) {
      const evidence = await readAvailableEvidence(input, preRunCursor, findSessionFile, sleep);
      finalized = true;
      return baseResult("aborted", evidence, joinErrors(cancellationError, await stopChild()));
    }
    // createLaunchCommand only writes the wrapper. Do not create that wrapper
    // after cancellation has become observable.
    const command = createLaunchCommand(launchSpec, artifacts);
    if (cancellationRequested) {
      const evidence = await readAvailableEvidence(input, preRunCursor, findSessionFile, sleep);
      finalized = true;
      return baseResult("aborted", evidence, joinErrors(cancellationError, await stopChild()));
    }

    let creation: ZellijSurface;
    try {
      creation = await controller.createSurface({
        parentPaneId: input.parentPaneId,
        placement: { kind: "split", direction: "right" },
        command,
        cwd: input.cwd,
      });
      surface = creation;
    } catch (error) {
      // A focus-restore failure can occur after the pane and child already exist.
      // Trust only a structured surface supplied by the controller. Otherwise
      // stop through the run-owned PID/cancel artifacts, never a guessed pane ID.
      const partial = error && typeof error === "object" && "partial" in error
        ? (error as { partial?: { surface?: ZellijSurface } }).partial
        : undefined;
      if (partial?.surface) surface = partial.surface;
      const stopped = await stopChild();
      const evidence = await readAvailableEvidence(input, preRunCursor, findSessionFile, sleep);
      finalized = true;
      return baseResult("error", evidence, joinErrors(errorText(error), stopped));
    }

    const polled = await pollRun({
      ...artifacts,
      runId: input.runId,
      isPaneAlive: () => controller.paneExists(creation),
      queryIntervalMs: 25,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
    });

    if (polled.kind !== "completed") {
      const stopped = await stopChild();
      const evidence = await readAvailableEvidence(input, preRunCursor, findSessionFile, sleep);
      const status = abortObserved ? "aborted" : statusFromPoll(polled.kind);
      const reason = polled.kind === "query-error" ? polled.error.message : `Child run ${polled.kind}`;
      finalized = true;
      return baseResult(status, evidence, joinErrors(reason, cancellationError, stopped));
    }

    const evidence = await readAvailableEvidence(input, preRunCursor, findSessionFile, sleep, polled.record);
    const cancelledBeforeClose = abortObserved || input.signal?.aborted;
    if (cancelledBeforeClose) {
      const stopped = await stopChild();
      finalized = true;
      return baseResult("aborted", evidence, stopped);
    }
    const parsedStatus: ChildRunStatus = evidence.outcome === "aborted"
      ? "aborted"
      : evidence.outcome === "error" || evidence.errorMessage || polled.record.exitCode !== 0
        ? "error"
        : "ok";
    const closeError = parsedStatus === "ok" && !abortObserved && !input.signal?.aborted
      ? await closeSurface()
      : undefined;
    const finalStatus = closeError ? "error" : parsedStatus;
    finalized = true;
    return baseResult(finalStatus, evidence, joinErrors(closeError?.message, cancellationError, polled.record.error));
  } catch (error) {
    const partial = error && typeof error === "object" && "partial" in error
      ? (error as { partial?: { surface?: ZellijSurface } }).partial
      : undefined;
    if (partial?.surface) surface = partial.surface;
    const stopped = await stopChild();
    const evidence = await readAvailableEvidence(input, preRunCursor, findSessionFile, sleep);
    finalized = true;
    return baseResult(abortObserved || input.signal?.aborted ? "aborted" : "error", evidence, joinErrors(errorText(error), cancellationError, stopped));
  } finally {
    input.signal?.removeEventListener("abort", onAbort);
    // `finalized` is intentionally local to this one terminal path. The flag
    // documents the invariant and prevents future cleanup additions from
    // introducing a second result path.
    void finalized;
  }
}

export async function checkZellij(
  env: NodeJS.ProcessEnv = process.env,
  executableProbe: () => Promise<boolean> = () => hasZellijExecutable(),
): Promise<Detection> {
  return zellijAvailability(env, await executableProbe());
}
