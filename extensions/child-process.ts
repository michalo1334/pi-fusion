import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
}

export interface RunArtifacts {
  taskDir: string;
  runDir: string;
  promptPath: string;
  systemPromptPath: string;
  pidPath: string;
  exitPath: string;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertSafe(value: string, label: string): void {
  if (!SAFE_ID.test(value)) throw new Error(`${label} must be a safe identifier`);
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
  for (const dir of [taskDir, runsDir]) {
    if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) throw new Error("Artifact path must not be a symlink");
  }
  fs.mkdirSync(taskDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(runsDir, { recursive: true, mode: 0o700 });
  for (const dir of [taskDir, runsDir]) {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Artifact path must not be a symlink");
  }
  const runDir = path.join(runsDir, runId);
  try { fs.mkdirSync(runDir, { mode: 0o700 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Run already exists: ${runId}`);
    throw error;
  }
  return {
    taskDir,
    runDir,
    promptPath: path.join(runDir, "prompt.md"),
    systemPromptPath: path.join(runDir, "system.md"),
    pidPath: path.join(runDir, "pid"),
    exitPath: path.join(runDir, "exit.json"),
  };
}

export function buildChildArgs(spec: ChildLaunchSpec): string[] {
  assertSafe(spec.taskId, "taskId");
  assertNoRecursiveFusionTools(spec.tools);
  assertNoRecursiveFusionExtensions(spec.extensions);
  assertSafe(spec.runId, "runId");
  assertSafe(spec.sessionId, "sessionId");
  if (!spec.model.provider || !spec.model.id || !spec.model.thinking) throw new Error("Complete model selection is required");
  const args = [
    "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-mcp",
    "--provider", spec.model.provider, "--model", spec.model.id, "--thinking", spec.model.thinking,
    "--session-dir", spec.sessionDir, "--session-id", spec.sessionId,
    "--tools", spec.tools.join(","),
    "--append-system-prompt", spec.systemPromptPath,
    "--extension", spec.childRuntimePath,
    ...spec.extensions.flatMap(extension => ["--extension", extension]),
    "--", `@${spec.promptPath}`,
  ];
  return args;
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
}

export function createLaunchSpec(spec: ChildLaunchSpec): { executable: string; args: string[]; env: NodeJS.ProcessEnv } {
  const executable = resolvePiExecutable();
  return {
    executable: executable.file,
    args: [...executable.prefix, ...buildChildArgs(spec)],
    env: { ...process.env, PI_FUSION_CHILD: "1", PI_FUSION_TASK_ID: spec.taskId, PI_FUSION_RUN_ID: spec.runId, PI_FUSION_TOOLS: spec.tools.join(",") },
  };
}

export function defaultArtifactRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fusion-"));
  fs.chmodSync(root, 0o700);
  return root;
}
