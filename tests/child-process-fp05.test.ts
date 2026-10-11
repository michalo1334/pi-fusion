import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { allocateRunArtifacts, createLaunchCommand, pollRun, writeExitSidecar, writePidSidecar } from "../extensions/child-process.ts";

test("FP-05: sidecars round-trip with actual newlines and stale runs are ignored", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fp05-"));
  const artifacts = allocateRunArtifacts(root, "task", "run");
  writePidSidecar(artifacts.pidPath, "run", process.pid);
  assert.equal(fs.readFileSync(artifacts.pidPath, "utf8").endsWith("\n"), true);
  writeExitSidecar(artifacts.exitPath, { runId: "old", exitCode: 0, finishedAt: new Date().toISOString() });
  const pending = pollRun({ ...artifacts, runId: "run", timeoutMs: 20, queryIntervalMs: 2 });
  assert.equal((await pending).kind, "timeout");
});

test("FP-05: generation creates a pane command and does not spawn the child", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fp05-"));
  const artifacts = allocateRunArtifacts(root, "task", "run");
  const command = createLaunchCommand({ taskId: "task", runId: "run", cwd: root, artifactRoot: root, sessionDir: root, sessionId: "session", model: { provider: "p", id: "m", thinking: "off" }, tools: [], extensions: [], promptPath: "/tmp/p", systemPromptPath: "/tmp/s", childRuntimePath: "/tmp/r" }, artifacts);
  assert.equal(command[0], process.execPath);
  assert.equal(fs.existsSync(artifacts.pidPath), false);
  assert.equal(fs.existsSync(artifacts.exitPath), false);
});

test("FP-07: generated wrapper reads the run cancellation marker before and after PID ownership", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fp07-wrapper-"));
  const artifacts = allocateRunArtifacts(root, "task", "run");
  const command = createLaunchCommand({ taskId: "task", runId: "run", cwd: root, artifactRoot: root, sessionDir: root, sessionId: "session", model: { provider: "p", id: "m", thinking: "off" }, tools: [], extensions: [], promptPath: "/tmp/p", systemPromptPath: "/tmp/s", childRuntimePath: "/tmp/r", holdFailurePane: true }, artifacts);
  const source = fs.readFileSync(command[1], "utf8");
  assert.match(source, /cancellationRequested/);
  assert.match(source, /atomic\(pidPath/);
  assert.match(source, /child\.kill\("SIGTERM"\)/);
});
