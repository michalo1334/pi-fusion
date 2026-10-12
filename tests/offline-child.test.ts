import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  allocateRunArtifacts,
  buildChildArgs,
  captureSessionCursor,
  createLaunchCommand,
  createPromptArtifact,
  readIncrementalResult,
  type ChildLaunchSpec,
  type RunArtifacts,
  type SessionCursor,
} from "../extensions/child-process.ts";
import { seedChildSessionFile } from "../extensions/session-lineage.ts";

const fixture = path.resolve("tests/fixtures/offline-provider.ts");
const repo = path.resolve(".");

function waitFor(file: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = () => {
      if (fs.existsSync(file)) return resolve();
      if (Date.now() >= deadline) return reject(new Error(`Timed out waiting for ${file}`));
      setTimeout(check, 10);
    };
    check();
  });
}

function sessionFile(sessionDir: string, sessionId: string): string {
  for (const name of fs.readdirSync(sessionDir)) {
    if (!name.endsWith(".jsonl")) continue;
    const file = path.join(sessionDir, name);
    try {
      const header = JSON.parse(fs.readFileSync(file, "utf8").split("\n", 1)[0]) as { type?: string; id?: string };
      if (header.type === "session" && header.id === sessionId) return file;
    } catch {
      // The child can write its header while this probe runs.
    }
  }
  throw new Error(`Session ${sessionId} was not created`);
}

function runDirArtifacts(root: string, taskId: string, runId: string): RunArtifacts {
  return allocateRunArtifacts(root, taskId, runId);
}

function launchSpec(root: string, taskId: string, runId: string, sessionDir: string, artifacts: RunArtifacts, tools = ["read"]): ChildLaunchSpec {
  return {
    taskId,
    runId,
    cwd: root,
    artifactRoot: root,
    sessionDir,
    sessionId: "offline-session",
    model: { provider: "offline-faux", id: "offline", thinking: "off" },
    tools,
    extensions: [fixture],
    promptPath: artifacts.promptPath,
    systemPromptPath: artifacts.systemPromptPath,
    childRuntimePath: path.resolve("extensions/child-runtime.ts"),
  };
}

async function runChild(
  spec: ChildLaunchSpec,
  artifacts: RunArtifacts,
  environment: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const command = createLaunchCommand(spec, artifacts);
  const child = spawn(command[0], command.slice(1), {
    cwd: spec.cwd,
    env: { ...process.env, PI_OFFLINE: "1", ...environment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", chunk => { stdout += chunk; });
  child.stderr?.on("data", chunk => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  await waitFor(artifacts.exitPath);
  return { code, stdout, stderr };
}

function assertArg(args: string[], ...expected: string[]): void {
  assert.ok(expected.every(value => args.includes(value)), `missing ${expected.join(", ")} in ${args.join(" ")}`);
}

test("FP09-01 Integration: WHEN a generated child runs with the local faux provider, THEN the real subprocess SHALL settle with policy, sidecar, session, and report evidence", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fusion-fp09-child-"));
  const taskId = `task-${randomUUID()}`;
  const runId = `run-${randomUUID()}`;
  const sessionDir = path.join(root, "sessions");
  const evidencePath = path.join(root, "fixture-evidence.json");
  fs.mkdirSync(path.join(root, ".pi", "skills"), { recursive: true });
  fs.mkdirSync(path.join(root, ".pi", "themes"), { recursive: true });
  fs.mkdirSync(path.join(root, ".pi", "prompts"), { recursive: true });
  fs.writeFileSync(path.join(root, ".pi", "malicious-extension.ts"), `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(path.join(root, "discovery-loaded"))}, "bad");`);
  fs.writeFileSync(path.join(root, ".pi", "skills", "malicious.md"), "must not load");
  fs.writeFileSync(path.join(root, ".pi", "themes", "malicious.json"), "{}");
  fs.writeFileSync(path.join(root, ".pi", "prompts", "malicious.md"), "must not load");
  fs.writeFileSync(path.join(root, "AGENTS.md"), "must not load");

  const artifacts = runDirArtifacts(root, taskId, runId);
  const spec = launchSpec(root, taskId, runId, sessionDir, artifacts);
  createPromptArtifact(artifacts.promptPath, "Initial prompt content: fp09-child-input");
  createPromptArtifact(artifacts.systemPromptPath, "Child system policy: fp09-system-input");
  const args = buildChildArgs(spec);
  assertArg(args, "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-mcp", "--provider", "offline-faux", "--model", "offline", "--thinking", "off", "--session-dir", sessionDir, "--session-id", "offline-session", "--tools", "read", "--extension", path.resolve("extensions/child-runtime.ts"), "--extension", fixture, "--", `@${artifacts.promptPath}`);
  assert.equal(args.some(value => value.includes("fp09-child-input")), false, "prompt content must stay in the artifact");

  const run = await runChild(spec, artifacts, { PI_FUSION_FIXTURE_EVIDENCE: evidencePath });
  assert.equal(run.code, 0, run.stderr);
  const exit = JSON.parse(fs.readFileSync(artifacts.exitPath, "utf8")) as { runId: string; exitCode: number | null; finishedAt: string };
  assert.deepEqual(exit, { runId, exitCode: 0, finishedAt: exit.finishedAt });
  assert.equal(fs.existsSync(artifacts.pidPath), true);
  assert.equal(fs.existsSync(path.join(root, "discovery-loaded")), false);
  assert.match(run.stdout, /offline-first/);
  const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8")) as { provider: string; model: string; messages: Array<{ role: string; content: unknown }>; allTools: string[]; activeTools: string[]; response: string; stdioTTY: boolean };
  assert.equal(evidence.provider, "offline-faux");
  assert.equal(evidence.model, "offline");
  assert.equal(evidence.response, "offline-first");
  assert.equal(evidence.stdioTTY, false, "captured stdout is print-mode evidence, not TUI evidence");
  assert.deepEqual(evidence.allTools, ["read"]);
  assert.deepEqual(evidence.activeTools, ["read"]);
  assert.ok(evidence.messages.some(message => message.role === "user" && JSON.stringify(message.content).includes("fp09-child-input")));
  const file = sessionFile(sessionDir, "offline-session");
  const result = await readIncrementalResult(file, { byteOffset: 0 }, { processExited: true, exitStatus: { exitCode: 0 } });
  assert.equal(result.report, "offline-first");
  assert.ok(result.usage.totalTokens > 0);
  // Faux provider usage is non-zero, but its cost is intentionally zero.
  // This test does not use zero cost as evidence for production cost arithmetic.
  assert.equal(result.usage.cost.total, 0);
});

test("FP09-02 Integration: WHEN a new generated child resumes the stored session, THEN it SHALL append only the follow-up report and usage", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fusion-fp09-followup-"));
  const taskId = `task-${randomUUID()}`;
  const sessionDir = path.join(root, "sessions");
  const evidencePath = path.join(root, "fixture-evidence.json");
  const firstRunId = `run-${randomUUID()}`;
  const firstArtifacts = runDirArtifacts(root, taskId, firstRunId);
  const firstSpec = launchSpec(root, taskId, firstRunId, sessionDir, firstArtifacts);
  createPromptArtifact(firstArtifacts.promptPath, "first process prompt");
  createPromptArtifact(firstArtifacts.systemPromptPath, "system policy");
  const first = await runChild(firstSpec, firstArtifacts, { PI_FUSION_FIXTURE_EVIDENCE: evidencePath });
  assert.equal(first.code, 0, first.stderr);
  const file = sessionFile(sessionDir, "offline-session");
  const cursor: SessionCursor = captureSessionCursor(file);
  const before = await readIncrementalResult(file, { byteOffset: 0 }, { processExited: true, exitStatus: { exitCode: 0 } });
  const secondRunId = `run-${randomUUID()}`;
  const secondArtifacts = runDirArtifacts(root, taskId, secondRunId);
  const secondSpec = launchSpec(root, taskId, secondRunId, sessionDir, secondArtifacts);
  createPromptArtifact(secondArtifacts.promptPath, "follow-up process prompt");
  createPromptArtifact(secondArtifacts.systemPromptPath, "system policy");
  const second = await runChild(secondSpec, secondArtifacts, { PI_FUSION_FIXTURE_EVIDENCE: evidencePath });
  assert.equal(second.code, 0, second.stderr);
  const after = await readIncrementalResult(file, cursor, { processExited: true, exitStatus: { exitCode: 0 } });
  assert.equal(before.report, "offline-first");
  assert.equal(after.report, "offline-follow-up");
  assert.ok(after.usage.totalTokens > 0);
  assert.notEqual(after.usage.totalTokens, before.usage.totalTokens);
  assert.equal(after.usage.cost.total, 0);
  const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8")) as { response: string; messages: Array<{ role: string; content: unknown }> };
  assert.equal(evidence.response, "offline-follow-up");
  assert.ok(evidence.messages.some(message => JSON.stringify(message.content).includes("offline-first")), "second process must see prior conversation");
});

test("LINEAGE-03 Integration: WHEN two offline child processes run, THE exact --session path SHALL preserve one seeded parent header and one follow-up file", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fusion-lineage-offline-"));
  const taskId = `task-${randomUUID()}`;
  const sessionDir = path.join(root, "sessions");
  fs.mkdirSync(sessionDir, { recursive: true });
  const parent = SessionManager.create(root, sessionDir, { id: "lead-session" });
  const parentFile = parent.getSessionFile()!;
  fs.writeFileSync(parentFile, `${JSON.stringify(parent.getHeader())}\n`, { mode: 0o600 });
  const childFile = seedChildSessionFile({ parentSessionFile: parentFile, childCwd: root, sessionDir, childSessionId: "offline-lineage" });
  const firstRunId = `run-${randomUUID()}`;
  const firstArtifacts = runDirArtifacts(root, taskId, firstRunId);
  const firstSpec = { ...launchSpec(root, taskId, firstRunId, sessionDir, firstArtifacts), sessionFile: childFile };
  createPromptArtifact(firstArtifacts.promptPath, "lineage first process");
  createPromptArtifact(firstArtifacts.systemPromptPath, "system policy");
  const firstArgs = buildChildArgs(firstSpec);
  assert.ok(firstArgs.includes("--session"));
  assert.ok(firstArgs.includes(childFile));
  assert.equal(firstArgs.includes("--session-dir"), false);
  assert.equal(firstArgs.includes("--session-id"), false);
  const first = await runChild(firstSpec, firstArtifacts, {});
  assert.equal(first.code, 0, first.stderr);
  const headerBefore = fs.readFileSync(childFile, "utf8").split("\n", 1)[0];
  const cursor = captureSessionCursor(childFile);
  const secondRunId = `run-${randomUUID()}`;
  const secondArtifacts = runDirArtifacts(root, taskId, secondRunId);
  const secondSpec = { ...launchSpec(root, taskId, secondRunId, sessionDir, secondArtifacts), sessionFile: childFile };
  createPromptArtifact(secondArtifacts.promptPath, "lineage follow-up process");
  createPromptArtifact(secondArtifacts.systemPromptPath, "system policy");
  const second = await runChild(secondSpec, secondArtifacts, {});
  assert.equal(second.code, 0, second.stderr);
  assert.equal(secondSpec.sessionFile, childFile);
  assert.equal(fs.readFileSync(childFile, "utf8").split("\n", 1)[0], headerBefore);
  const followup = await readIncrementalResult(childFile, cursor, { processExited: true, exitStatus: { exitCode: 0 } });
  assert.equal(followup.report, "offline-follow-up");
  assert.equal(JSON.parse(headerBefore).parentSession, parentFile);
});

test("FP09-03 Integration: WHEN the child runtime policy fails before a model turn, THEN the wrapper SHALL write runtime-error and a non-success exit record", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fusion-fp09-policy-"));
  const taskId = `task-${randomUUID()}`;
  const runId = `run-${randomUUID()}`;
  const sessionDir = path.join(root, "sessions");
  const artifacts = runDirArtifacts(root, taskId, runId);
  const spec = launchSpec(root, taskId, runId, sessionDir, artifacts, []);
  createPromptArtifact(artifacts.promptPath, "policy failure must not reach faux provider");
  createPromptArtifact(artifacts.systemPromptPath, "system policy");
  const run = await runChild(spec, artifacts, { PI_FUSION_FIXTURE_EVIDENCE: path.join(root, "evidence.json") });
  assert.equal(run.code, 78, run.stderr);
  const runtimeError = JSON.parse(fs.readFileSync(artifacts.runtimeErrorPath, "utf8")) as { runId: string; error: string };
  assert.equal(runtimeError.runId, runId);
  assert.match(runtimeError.error, /missing PI_FUSION_TOOLS|policy/);
  const exit = JSON.parse(fs.readFileSync(artifacts.exitPath, "utf8")) as { runId: string; exitCode: number | null; policyFailure?: boolean };
  assert.equal(exit.runId, runId);
  assert.equal(exit.exitCode, 78);
  assert.equal(exit.policyFailure, true);
  assert.equal(fs.existsSync(path.join(root, "evidence.json")), false, "a policy failure must not make a model turn");
});
