import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertNoRecursiveFusionExtensions, assertNoRecursiveFusionTools } from "./sidekick-policy.ts";

export interface ChildLaunchSpec {
  /** The original Fusion preamble is written by the caller to systemPromptPath. */
  taskId: string;
  runId: string;
  cwd: string;
  artifactRoot: string;
  sessionDir: string;
  sessionId: string;
  model: { provider: string; id: string; thinking: string };
  tools: string[];
  extensions: string[];
  promptPath: string;
  systemPromptPath: string;
  childRuntimePath: string;
  /** Keep failed panes inspectable when the wrapper runs in the production Zellij surface. */
  holdFailurePane?: boolean;
}

export interface RunArtifacts {
  taskDir: string;
  runDir: string;
  promptPath: string;
  systemPromptPath: string;
  pidPath: string;
  exitPath: string;
  runtimeErrorPath: string;
  cancelPath: string;
}

export interface ProcessIdentity {
  platform: "linux";
  pid: number;
  /** Linux /proc stat starttime. It is stable for one PID lifetime. */
  startTime: string;
  state?: string;
}

export interface PidRecord {
  runId: string;
  pid: number;
  identity: ProcessIdentity;
  /** Present only when a non-TTY launch created a private child process group. */
  processGroupId?: number;
}

export interface ExitRecord {
  runId: string;
  exitCode: number | null;
  finishedAt: string;
  error?: string;
  policyFailure?: boolean;
  childStart?: string;
}

export type PollOutcome =
  | { kind: "completed"; record: ExitRecord }
  | { kind: "aborted" }
  | { kind: "timeout" }
  | { kind: "pane-lost" }
  | { kind: "process-gone"; reason: "gone" | "stale-identity"; message: string }
  | { kind: "query-error"; error: Error };

export interface RunControl {
  pidPath: string;
  exitPath: string;
  runId: string;
  isPaneAlive?: () => Promise<boolean>;
  /** Test and integration seam for process probes. */
  probeChild?: () => Promise<"alive" | "gone" | "stale-identity">;
  /** Legacy seam for callers that only have a liveness query. */
  isChildAlive?: () => Promise<boolean>;
  queryIntervalMs?: number;
  /** Time to allow a child to flush its exit sidecar after it disappears. */
  flushGraceMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

function atomicWrite(file: string, contents: string): void {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, file);
}

function validRunId(runId: unknown): runId is string {
  return typeof runId === "string" && SAFE_ID.test(runId);
}

export function parseProcStat(stat: string): { pid: number; state: string; startTime: string } {
  // comm can contain spaces and parentheses. The final ')' is the delimiter.
  const match = /^(\d+) \((.*)\) ([\s\S]+)$/.exec(stat.trim());
  if (!match) throw new Error("Invalid Linux process identity record");
  const pid = Number(match[1]);
  const fields = match[3].trim().split(/\s+/);
  // fields[0] is stat field 3 (state), so field 22 is fields[19].
  if (!Number.isInteger(pid) || fields.length <= 19 || !/^\d+$/.test(fields[19])) {
    throw new Error("Incomplete Linux process identity record");
  }
  return { pid, state: fields[0], startTime: fields[19] };
}

export function readProcessIdentity(pid: number): ProcessIdentity {
  if (process.platform !== "linux") {
    throw new Error("Safe PID identity checks are supported only on Linux");
  }
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("Invalid process PID");
  const parsed = parseProcStat(fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
  if (parsed.pid !== pid) throw new Error(`PID identity record mismatch for ${pid}`);
  return { platform: "linux", pid, startTime: parsed.startTime, state: parsed.state };
}

function sameIdentity(expected: ProcessIdentity, actual: ProcessIdentity): boolean {
  return expected.platform === actual.platform && expected.pid === actual.pid && expected.startTime === actual.startTime;
}

export function writePidSidecar(file: string, runId: string, pid: number, identity = readProcessIdentity(pid), processGroupId?: number): void {
  if (!validRunId(runId)) throw new Error("Invalid run ID");
  if (!Number.isInteger(pid) || pid <= 0 || !sameIdentity({ platform: "linux", pid, startTime: identity.startTime }, identity)) {
    throw new Error("Invalid child PID identity");
  }
  if (identity.platform !== "linux" || identity.pid !== pid || !identity.startTime) {
    throw new Error("A Linux child PID identity fingerprint is required");
  }
  if (processGroupId !== undefined && (processGroupId !== pid || !Number.isInteger(processGroupId) || processGroupId <= 0)) {
    throw new Error("Invalid child process-group identity");
  }
  atomicWrite(file, JSON.stringify({ runId, pid, identity, ...(processGroupId ? { processGroupId } : {}) }) + "\n");
}

function readPidSidecar(file: string, runId: string): PidRecord {
  let value: unknown;
  try { value = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { throw new Error(`Cannot read child PID sidecar: ${error instanceof Error ? error.message : String(error)}`); }
  const record = value as Partial<PidRecord>;
  const identity = record.identity as Partial<ProcessIdentity> | undefined;
  if (!validRunId(record.runId) || record.runId !== runId || !Number.isInteger(record.pid) || (record.pid ?? 0) <= 0 ||
      identity?.platform !== "linux" || identity.pid !== record.pid || typeof identity.startTime !== "string" || !/^\d+$/.test(identity.startTime) ||
      (record.processGroupId !== undefined && (record.processGroupId !== record.pid || !Number.isInteger(record.processGroupId) || record.processGroupId <= 0))) {
    throw new Error("Child PID sidecar is missing a matching identity fingerprint");
  }
  return record as PidRecord;
}

export function writeExitSidecar(file: string, record: ExitRecord): void {
  if (!validRunId(record.runId) || typeof record.finishedAt !== "string" ||
      !(record.exitCode === null || (record.exitCode !== undefined && Number.isInteger(record.exitCode) && record.exitCode >= 0 && record.exitCode <= 255))) {
    throw new Error("Invalid child exit record");
  }
  atomicWrite(file, JSON.stringify(record) + "\n");
}

export function writeRuntimeError(file: string, runId: string, error: string): void {
  if (!validRunId(runId) || typeof error !== "string" || error.trim().length === 0) throw new Error("Invalid child runtime error");
  atomicWrite(file, JSON.stringify({ runId, error: error.trim() }) + "\n");
}

export function requestRunCancellation(file: string, runId: string): void {
  if (!validRunId(runId)) throw new Error("Invalid run ID");
  atomicWrite(file, `${runId}\n`);
}

function readExit(file: string, runId: string): ExitRecord | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ExitRecord>;
    if (value.runId !== runId || typeof value.finishedAt !== "string" ||
        !(value.exitCode === null || (value.exitCode !== undefined && Number.isInteger(value.exitCode) && value.exitCode >= 0 && value.exitCode <= 255)) ||
        (value.error !== undefined && typeof value.error !== "string") ||
        (value.policyFailure !== undefined && typeof value.policyFailure !== "boolean")) return undefined;
    return value as ExitRecord;
  } catch { return undefined; }
}

async function defaultProbeChild(pidPath: string, runId: string): Promise<"alive" | "gone" | "stale-identity"> {
  if (!fs.existsSync(pidPath)) return "alive";
  const record = readPidSidecar(pidPath, runId);
  try {
    const current = readProcessIdentity(record.pid);
    if (!sameIdentity(record.identity, current)) return "stale-identity";
    return current.state === "Z" ? "gone" : "alive";
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") return "gone";
    throw error;
  }
}

export async function pollRun(control: RunControl): Promise<PollOutcome> {
  const started = Date.now();
  const interval = Math.max(1, control.queryIntervalMs ?? 50);
  const flushGrace = Math.max(0, control.flushGraceMs ?? 250);
  let disappearanceAt: number | undefined;
  let disappearanceReason: "gone" | "stale-identity" = "gone";
  let paneGoneAt: number | undefined;
  while (true) {
    if (control.signal?.aborted) return { kind: "aborted" };
    const record = readExit(control.exitPath, control.runId);
    if (record) return { kind: "completed", record };
    if (control.timeoutMs !== undefined && Date.now() - started >= control.timeoutMs) return { kind: "timeout" };

    if (control.isPaneAlive) {
      try {
        if (!(await control.isPaneAlive())) {
          // Zellij can remove a terminal pane as soon as its wrapper exits.
          // Allow the wrapper to publish its atomic exit sidecar first. A pane
          // with no PID record is still an immediate surface-loss failure.
          if (!fs.existsSync(control.pidPath)) return { kind: "pane-lost" };
          paneGoneAt ??= Date.now();
          if (Date.now() - paneGoneAt >= flushGrace) return { kind: "pane-lost" };
        } else {
          paneGoneAt = undefined;
        }
      } catch (error) {
        return { kind: "query-error", error: error instanceof Error ? error : new Error(String(error)) };
      }
    }

    try {
      const state = control.probeChild
        ? await control.probeChild()
        : control.isChildAlive
          ? ((await control.isChildAlive()) ? "alive" : "gone")
          : await defaultProbeChild(control.pidPath, control.runId);
      if (state !== "alive") {
        disappearanceAt ??= Date.now();
        disappearanceReason = state;
        if (Date.now() - disappearanceAt >= flushGrace) {
          return { kind: "process-gone", reason: disappearanceReason, message: disappearanceReason === "stale-identity" ? "Child PID identity changed before exit sidecar was written" : "Child disappeared without a matching exit sidecar" };
        }
      } else {
        disappearanceAt = undefined;
      }
    } catch (error) {
      return { kind: "query-error", error: error instanceof Error ? error : new Error(String(error)) };
    }
    await new Promise(resolve => setTimeout(resolve, interval));
  }
}

function assertArtifactPaths(artifacts: RunArtifacts): void {
  const runDir = path.resolve(artifacts.runDir);
  if (fs.existsSync(runDir) && fs.lstatSync(runDir).isSymbolicLink()) throw new Error("Run artifact directory must not be a symlink");
  for (const file of [artifacts.promptPath, artifacts.systemPromptPath, artifacts.pidPath, artifacts.exitPath, artifacts.runtimeErrorPath, artifacts.cancelPath]) {
    const resolved = path.resolve(file);
    if (resolved !== runDir && !resolved.startsWith(`${runDir}${path.sep}`)) throw new Error("Run artifact path escapes its run directory");
  }
}

export function createLaunchWrapper(spec: ChildLaunchSpec, artifacts: RunArtifacts): string {
  assertArtifactPaths(artifacts);
  const launch = createLaunchSpec(spec);
  const wrapper = path.join(artifacts.runDir, "launch.mjs");
  const source = `import { spawn } from "node:child_process";
import { writeFileSync, renameSync, readFileSync } from "node:fs";
const runId = ${JSON.stringify(spec.runId)};
const pidPath = ${JSON.stringify(artifacts.pidPath)};
const errorPath = ${JSON.stringify(artifacts.runtimeErrorPath)};
const exitPath = ${JSON.stringify(artifacts.exitPath)};
const cancelPath = ${JSON.stringify(artifacts.cancelPath)};
const atomic = (file, value) => { const tmp = file + ".tmp-" + process.pid + "-" + Math.random().toString(36).slice(2); writeFileSync(tmp, JSON.stringify(value) + "\\n", { mode: 0o600 }); renameSync(tmp, file); };
const identity = (pid) => { if (process.platform !== "linux") throw new Error("Safe PID identity checks are supported only on Linux"); const stat = readFileSync("/proc/" + pid + "/stat", "utf8").trim(); const close = stat.lastIndexOf(")"); if (close < 0) throw new Error("Invalid Linux process identity record"); const fields = stat.slice(close + 2).trim().split(/\\s+/); if (fields.length <= 19 || !/^\\d+$/.test(fields[19])) throw new Error("Incomplete Linux process identity record"); return { platform: "linux", pid, startTime: fields[19], state: fields[0] }; };
const explicitEnv = ${JSON.stringify(launch.env)};
const childEnv = { ...process.env, ...explicitEnv, PI_FUSION_RUNTIME_ERROR_PATH: errorPath, PI_FUSION_CANCEL_PATH: cancelPath };
const cancellationRequested = () => { try { return readFileSync(cancelPath, "utf8").trim() === runId; } catch { return false; } };
let finalized = false;
let stopRequested = false;
let child;
let launchError;
const finish = (code, spawnError) => { if (finalized) return; finalized = true; let runtimeError; try { const value = JSON.parse(readFileSync(errorPath, "utf8")); if (value.runId === runId && typeof value.error === "string" && value.error.trim()) runtimeError = value.error.trim(); } catch {} const failure = spawnError || launchError; const failed = runtimeError !== undefined; const exitCode = failed ? 78 : (launchError && !spawnError ? 78 : code); atomic(exitPath, { runId, exitCode, finishedAt: new Date().toISOString(), ...(failure ? { error: failure } : {}), ...(failed ? { error: runtimeError, policyFailure: true } : {}) }); process.exitCode = exitCode === null ? 1 : exitCode; if (exitCode !== 0 && explicitEnv.PI_FUSION_HOLD_FAILURE === "1") { process.stdin.resume(); setInterval(() => {}, 1000); } };
const handleTerminalSignal = (signal) => { if (finalized) { if (explicitEnv.PI_FUSION_HOLD_FAILURE === "1") process.exit(signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1); return; } if (!child || child.killed) { stopRequested = true; return; } try { child.kill(signal); } catch {} };
process.on("SIGINT", () => handleTerminalSignal("SIGINT"));
process.on("SIGTERM", () => handleTerminalSignal("SIGTERM"));
process.on("SIGHUP", () => handleTerminalSignal("SIGHUP"));
try {
  if (stopRequested || cancellationRequested()) { finish(130); }
  else {
  const isolated = !process.stdin.isTTY && !process.stdout.isTTY;
  child = spawn(${JSON.stringify(launch.executable)}, ${JSON.stringify(launch.args)}, { cwd: ${JSON.stringify(spec.cwd)}, env: childEnv, stdio: "inherit", detached: isolated });
  child.once("error", error => finish(null, error.message));
  child.once("exit", (code, signal) => finish(code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1), launchError));
  if (Number.isInteger(child.pid) && child.pid > 0) {
    try { atomic(pidPath, { runId, pid: child.pid, identity: identity(child.pid), ...(isolated ? { processGroupId: child.pid } : {}) }); }
    catch (error) {
      launchError = "Could not record child PID identity: " + (error instanceof Error ? error.message : String(error));
      try { child.kill("SIGTERM"); } catch {}
      const forceStop = setTimeout(() => { if (!finalized) { try { child.kill("SIGKILL"); } catch {} } }, 250);
      forceStop.unref?.();
    }
    if (cancellationRequested()) { stopRequested = true; try { child.kill("SIGTERM"); } catch {} }
  } else {
    launchError = "Child process did not provide a PID; safe ownership could not be established";
    try { child.kill("SIGTERM"); } catch {}
  }
  }
} catch (error) { finish(null, error instanceof Error ? error.message : String(error)); }
`;
  fs.writeFileSync(wrapper, source, { encoding: "utf8", mode: 0o700 });
  return wrapper;
}

export function createLaunchCommand(spec: ChildLaunchSpec, artifacts: RunArtifacts): string[] {
  return [process.execPath, createLaunchWrapper(spec, artifacts)];
}

export interface StopOwnedChildControl {
  pidPath: string;
  runId: string;
  interrupt: () => Promise<void>;
  graceMs?: number;
  termGraceMs?: number;
  killGraceMs?: number;
  readIdentity?: (pid: number) => ProcessIdentity;
  sendSignal?: (target: number, signal: "SIGTERM" | "SIGKILL") => void;
  sleep?: (ms: number) => Promise<void>;
}

export async function stopOwnedChild(control: StopOwnedChildControl): Promise<void> {
  const record = readPidSidecar(control.pidPath, control.runId);
  const readIdentity = control.readIdentity ?? readProcessIdentity;
  const sleep = control.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const signal = control.sendSignal ?? ((target, name) => process.kill(target, name));
  const initial = (() => { try { return readIdentity(record.pid); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; } })();
  if (!initial) return;
  if (!sameIdentity(record.identity, initial)) throw new Error(`Refusing to stop PID ${record.pid}: identity fingerprint does not match`);
  if (initial.state === "Z") return;

  const ownedState = (): "alive" | "gone" => {
    try {
      const current = readIdentity(record.pid);
      if (!sameIdentity(record.identity, current)) throw new Error(`Refusing to signal PID ${record.pid}: identity fingerprint changed`);
      return current.state === "Z" ? "gone" : "alive";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "gone";
      throw error;
    }
  };
  const waitForGone = async (duration: number): Promise<boolean> => {
    const deadline = Date.now() + Math.max(0, duration);
    while (true) {
      if (ownedState() === "gone") return true;
      if (Date.now() >= deadline) return false;
      await sleep(Math.min(25, Math.max(1, deadline - Date.now())));
    }
  };
  // TTY children stay in the foreground group. Only non-TTY children may have a private group.
  const target = record.processGroupId && process.platform !== "win32" ? -record.processGroupId : record.pid;
  let interruptError: Error | undefined;
  try { await control.interrupt(); }
  catch (error) { interruptError = error instanceof Error ? error : new Error(String(error)); }
  if (await waitForGone(control.graceMs ?? 1000)) {
    if (interruptError) throw new Error(`Graceful child interrupt failed: ${interruptError.message}`);
    return;
  }

  let signalError: Error | undefined;
  const send = (name: "SIGTERM" | "SIGKILL") => {
    // Re-check identity immediately before every numeric signal.
    if (ownedState() === "gone") return false;
    try { signal(target, name); return true; }
    catch (error) { signalError = error instanceof Error ? error : new Error(String(error)); return false; }
  };
  send("SIGTERM");
  if (await waitForGone(control.termGraceMs ?? 1000)) {
    if (interruptError || signalError) throw new Error(`Child stop completed with errors: ${[interruptError, signalError].filter(Boolean).map(error => error!.message).join("; ")}`);
    return;
  }
  send("SIGKILL");
  if (!(await waitForGone(control.killGraceMs ?? 500))) {
    throw new Error(`Fusion child PID ${record.pid} did not terminate after SIGKILL${signalError ? `: ${signalError.message}` : ""}`);
  }
  if (interruptError || signalError) throw new Error(`Child stop completed with errors: ${[interruptError, signalError].filter(Boolean).map(error => error!.message).join("; ")}`);
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertSafe(value: string, label: string): void {
  if (!SAFE_ID.test(value)) throw new Error(`${label} must be a safe identifier`);
}

function isWithin(root: string, target: string): boolean {
  const base = path.resolve(root);
  const resolved = path.resolve(target);
  return resolved === base || resolved.startsWith(`${base}${path.sep}`);
}

export function allocateRunArtifacts(root: string, taskId: string, runId: string): RunArtifacts {
  assertSafe(taskId, "taskId");
  assertSafe(runId, "runId");
  const rootPath = path.resolve(root);
  fs.mkdirSync(rootPath, { recursive: true, mode: 0o700 });
  const rootStat = fs.lstatSync(rootPath);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Artifact root must be a real directory");
  fs.chmodSync(rootPath, 0o700);
  const taskDir = path.join(rootPath, taskId);
  const runsDir = path.join(taskDir, "runs");
  if (!isWithin(rootPath, taskDir) || !isWithin(rootPath, runsDir)) throw new Error("Artifact path escapes its root");
  for (const dir of [taskDir, runsDir]) {
    if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) throw new Error("Artifact path must not be a symlink");
  }
  fs.mkdirSync(taskDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(runsDir, { recursive: true, mode: 0o700 });
  for (const dir of [taskDir, runsDir]) {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Artifact path must not be a symlink");
    fs.chmodSync(dir, 0o700);
  }
  const runDir = path.join(runsDir, runId);
  if (!isWithin(rootPath, runDir)) throw new Error("Run artifact path escapes its root");
  try { fs.mkdirSync(runDir, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Run already exists: ${runId}`);
    throw error;
  }
  const artifacts = {
    taskDir, runDir,
    promptPath: path.join(runDir, "prompt.md"),
    systemPromptPath: path.join(runDir, "system.md"),
    pidPath: path.join(runDir, "pid"),
    exitPath: path.join(runDir, "exit.json"),
    runtimeErrorPath: path.join(runDir, "runtime-error.json"),
    cancelPath: path.join(runDir, "cancel"),
  };
  assertArtifactPaths(artifacts);
  return artifacts;
}

export function buildChildArgs(spec: ChildLaunchSpec): string[] {
  assertSafe(spec.taskId, "taskId");
  assertNoRecursiveFusionTools(spec.tools);
  assertNoRecursiveFusionExtensions(spec.extensions);
  assertSafe(spec.runId, "runId");
  assertSafe(spec.sessionId, "sessionId");
  if (!spec.model.provider || !spec.model.id || !spec.model.thinking) throw new Error("Complete model selection is required");
  return [
    "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-mcp",
    "--provider", spec.model.provider, "--model", spec.model.id, "--thinking", spec.model.thinking,
    "--session-dir", spec.sessionDir, "--session-id", spec.sessionId,
    "--tools", spec.tools.join(","),
    "--append-system-prompt", spec.systemPromptPath,
    "--extension", spec.childRuntimePath,
    ...spec.extensions.flatMap(extension => ["--extension", extension]),
    "--", `@${spec.promptPath}`,
  ];
}

export interface PiResolverProbes {
  which?: (name: string, env: NodeJS.ProcessEnv) => string | undefined;
  packageEntry?: () => string;
}

export function resolvePiExecutable(
  env: NodeJS.ProcessEnv = process.env,
  probes: PiResolverProbes = {},
): { file: string; prefix: string[] } {
  const configured = env.PI_FUSION_PI?.trim();
  if (configured) return { file: configured, prefix: [] };
  const which = probes.which ?? ((name, currentEnv) => {
    try { return execFileSync("which", [name], { encoding: "utf8", env: currentEnv }).trim() || undefined; } catch { return undefined; }
  });
  const bin = which("pi", env);
  if (bin) return { file: bin, prefix: [] };
  const entry = probes.packageEntry ?? (() => {
    const require = createRequire(import.meta.url);
    return require.resolve("@earendil-works/pi-coding-agent/dist/main.js");
  });
  try {
    const resolved = entry();
    return { file: process.execPath, prefix: [fileURLToPath(resolved.startsWith("file:") ? resolved : pathToFileURL(resolved))] };
  } catch {
    throw new Error("Cannot resolve the installed Pi runtime; set PI_FUSION_PI");
  }
}

export function createPromptArtifact(file: string, prompt: string): void {
  fs.writeFileSync(file, prompt, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

export function createLaunchSpec(spec: ChildLaunchSpec): { executable: string; args: string[]; env: NodeJS.ProcessEnv } {
  const executable = resolvePiExecutable();
  return {
    executable: executable.file,
    args: [...executable.prefix, ...buildChildArgs(spec)],
    // The wrapper merges these values with process.env when it runs in the pane.
    // Never snapshot credentials or ZELLIJ_PANE_ID in the parent process.
    env: { PI_FUSION_CHILD: "1", PI_FUSION_TASK_ID: spec.taskId, PI_FUSION_RUN_ID: spec.runId, PI_FUSION_TOOLS: spec.tools.join(","), ...(spec.holdFailurePane ? { PI_FUSION_HOLD_FAILURE: "1" } : {}) },
  };
}

export function defaultArtifactRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fusion-"));
  fs.chmodSync(root, 0o700);
  return root;
}

export {
  captureSessionCursor,
  createSessionCursor,
  validateSessionCursor,
  readIncrementalResult,
  readRunResult,
  SessionIntegrityError,
} from "./session-parser.ts";
export type {
  ExitStatus,
  ReadRunOptions,
  RunOutcome,
  RunResult,
  SessionCursor,
  Usage,
} from "./session-parser.ts";
