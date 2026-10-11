import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { runChildTask } from "../extensions/child-runner.ts";
import { writeExitSidecar, type RunArtifacts } from "../extensions/child-process.ts";
import type { ZellijOperations, ZellijSurface } from "../extensions/zellij.ts";

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fp07-runner-"));
const model = { provider: "offline", id: "fixture", thinking: "off" };
const surface: ZellijSurface = { paneId: "terminal_2", parentPaneId: "terminal_1" };

function findArtifacts(root: string): RunArtifacts {
  const task = fs.readdirSync(root).find((name) => name !== "session")!;
  const taskDir = path.join(root, task);
  const run = fs.readdirSync(path.join(taskDir, "runs"))[0];
  const runDir = path.join(taskDir, "runs", run);
  return {
    taskDir, runDir,
    promptPath: path.join(runDir, "prompt.md"), systemPromptPath: path.join(runDir, "system.md"),
    pidPath: path.join(runDir, "pid"), exitPath: path.join(runDir, "exit.json"), runtimeErrorPath: path.join(runDir, "runtime-error.json"), cancelPath: path.join(runDir, "cancel"),
  };
}

function writeSession(sessionDir: string, sessionId: string, report: string): void {
  fs.mkdirSync(sessionDir, { recursive: true });
  const user = { type: "message", id: "u1", parentId: null, timestamp: new Date(0).toISOString(), message: { role: "user", content: "brief", timestamp: 0 } };
  const assistant = { type: "message", id: "a1", parentId: "u1", timestamp: new Date(0).toISOString(), message: {
    role: "assistant", content: [{ type: "text", text: report }], stopReason: "stop", timestamp: 0,
    usage: { input: 1, output: 2, totalTokens: 3, cost: { input: 0.3, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.3 } },
  } };
  fs.writeFileSync(path.join(sessionDir, `${sessionId}.jsonl`), [
    JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: process.cwd(), timestamp: new Date(0).toISOString() }),
    JSON.stringify(user), JSON.stringify(assistant), "",
  ].join("\n"));
}

async function runFake(options: { complete?: boolean; partial?: boolean; disappear?: boolean; createError?: boolean; exitCode?: number; signal?: AbortSignal } = {}) {
  const root = temp();
  const sessionDir = path.join(root, "session");
  const runId = randomUUID();
  let alive = true;
  const controller: ZellijOperations & { closeCount: number; interruptCount: number; command?: readonly string[] } = {
    closeCount: 0, interruptCount: 0,
    createSurface: async (input) => {
      controller.command = input.command;
      if (options.createError) throw new Error("surface startup failed");
      const artifacts = findArtifacts(root);
      if (options.disappear) { alive = false; return surface; }
      if (options.complete !== false || options.partial) {
        writeSession(sessionDir, "session", "child report");
        if (options.complete !== false) writeExitSidecar(artifacts.exitPath, { runId, exitCode: options.exitCode ?? 0, finishedAt: new Date().toISOString(), ...(options.exitCode ? { error: "provider error" } : {}) });
      }
      return surface;
    },
    sendCommand: async () => {},
    interrupt: async () => { controller.interruptCount++; alive = false; },
    close: async () => { controller.closeCount++; alive = false; },
    paneExists: async () => alive,
    screen: async () => "",
  };
  const result = await runChildTask({
    taskId: randomUUID(), runId, cwd: root, artifactRoot: root, sessionDir, sessionId: "session", model,
    tools: ["read"], extensions: [], childRuntimePath: path.join(root, "child-runtime.ts"),
    systemPrompt: "system", prompt: "brief", parentPaneId: "terminal_1", timeoutMs: options.signal ? 100 : 100,
    signal: options.signal,
  }, { zellij: controller, sleep: async (ms) => new Promise((resolve) => setTimeout(resolve, ms)) });
  return { result, controller };
}

test("FP-07/Integration: WHEN a child reports success, SHALL return the new report and close its pane once", async () => {
  const run = await runFake();
  assert.equal(run.result.status, "ok");
  assert.equal(run.result.report, "child report");
  assert.equal(run.result.costUsd, 0.3);
  assert.equal(run.controller.closeCount, 1);
  assert.equal(run.controller.command?.length, 2);
});

test("FP-07/Unit: WHEN child surface startup fails, SHALL return an actionable error without a second spawn", async () => {
  const run = await runFake({ createError: true });
  assert.equal(run.result.status, "error");
  assert.match(run.result.errorMessage ?? "", /surface startup failed/);
  assert.equal(run.controller.closeCount, 0);
});

test("FP-07/Unit: WHEN the child reports a provider error, SHALL retain its pane and preserve the report evidence", async () => {
  const run = await runFake({ exitCode: 7 });
  assert.equal(run.result.status, "error");
  assert.equal(run.result.report, "child report");
  assert.equal(run.result.costUsd, 0.3);
  assert.equal(run.controller.closeCount, 0);
});

test("FP-07/Unit: WHEN the owned pane disappears, SHALL retain the surface and return an error", async () => {
  const run = await runFake({ disappear: true });
  assert.equal(run.result.status, "error");
  assert.equal(run.controller.closeCount, 0);
});

test("FP-07/Unit: WHEN the child does not settle before timeout, SHALL return timeout and retain its pane", async () => {
  const run = await runFake({ complete: false });
  assert.equal(run.result.status, "timeout");
  assert.equal(run.controller.closeCount, 0);
});

test("FP-07/Integration: WHEN timeout follows billed assistant output, SHALL preserve new usage and report", async () => {
  const run = await runFake({ complete: false, partial: true });
  assert.equal(run.result.status, "timeout");
  assert.equal(run.result.report, "child report");
  assert.equal(run.result.costUsd, 0.3);
  assert.equal(run.controller.closeCount, 0);
});

test("FP-07/Unit: WHEN pane interruption fails, SHALL return the termination error and retain the run", async () => {
  const root = temp();
  const controller: ZellijOperations = {
    createSurface: async () => surface, sendCommand: async () => {},
    interrupt: async () => { throw new Error("interrupt denied"); }, close: async () => {},
    paneExists: async () => false, screen: async () => "",
  };
  const result = await runChildTask({
    taskId: randomUUID(), runId: randomUUID(), cwd: root, artifactRoot: root, sessionDir: path.join(root, "session"), sessionId: "session", model,
    tools: ["read"], extensions: [], childRuntimePath: path.join(root, "runtime"), systemPrompt: "system", prompt: "brief",
    parentPaneId: "terminal_1", timeoutMs: 100,
  }, { zellij: controller });
  assert.equal(result.status, "error");
  assert.match(result.errorMessage ?? "", /interrupt denied/);
});

test("FP-07/Unit: WHEN the owned PID fingerprint is invalid, SHALL report the stop failure", async () => {
  const root = temp();
  const runId = randomUUID();
  const controller: ZellijOperations = {
    createSurface: async () => { const artifacts = findArtifacts(root); fs.writeFileSync(artifacts.pidPath, JSON.stringify({ runId, pid: 99999 }) + "\n"); return surface; },
    sendCommand: async () => {}, interrupt: async () => {}, close: async () => {}, paneExists: async () => false, screen: async () => "",
  };
  const result = await runChildTask({
    taskId: randomUUID(), runId, cwd: root, artifactRoot: root, sessionDir: path.join(root, "session"), sessionId: "session", model,
    tools: ["read"], extensions: [], childRuntimePath: path.join(root, "runtime"), systemPrompt: "system", prompt: "brief",
    parentPaneId: "terminal_1", timeoutMs: 100,
  }, { zellij: controller });
  assert.equal(result.status, "error");
  assert.match(result.errorMessage ?? "", /owned child termination failed/);
});

test("FP-07/Unit: WHEN cancellation arrives before allocation, SHALL not create artifacts or a pane", async () => {
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(() => runFake({ signal: abort.signal }), /cancelled before allocation/);
});

test("FP-07/Integration: WHEN cancellation arrives during delayed surface creation, SHALL suppress late child launch", async () => {
  const root = temp();
  const sessionDir = path.join(root, "session");
  const abort = new AbortController();
  let creates = 0;
  const controller: ZellijOperations = {
    createSurface: async () => { creates++; await new Promise((resolve) => setTimeout(resolve, 30)); return surface; },
    sendCommand: async () => {}, interrupt: async () => {}, close: async () => {},
    paneExists: async () => true, screen: async () => "",
  };
  setTimeout(() => abort.abort(), 5);
  const result = await runChildTask({
    taskId: randomUUID(), runId: randomUUID(), cwd: root, artifactRoot: root, sessionDir, sessionId: "session", model,
    tools: ["read"], extensions: [], childRuntimePath: path.join(root, "runtime"), systemPrompt: "system", prompt: "brief",
    parentPaneId: "terminal_1", timeoutMs: 200, signal: abort.signal,
  }, { zellij: controller });
  assert.equal(creates, 1);
  assert.equal(result.status, "aborted");
  assert.equal(fs.readFileSync(result.artifacts.cancelPath, "utf8").trim(), result.runId);
});

test("FP-07/Integration: WHEN cancellation arrives before a delayed PID beyond the old grace, SHALL leave a cancellation handshake", async () => {
  const root = temp();
  const abort = new AbortController();
  let interrupted = 0;
  const controller: ZellijOperations = {
    createSurface: async () => surface, sendCommand: async () => {},
    interrupt: async () => { interrupted++; }, close: async () => {}, paneExists: async () => true, screen: async () => "",
  };
  const resultPromise = runChildTask({
    taskId: randomUUID(), runId: randomUUID(), cwd: root, artifactRoot: root, sessionDir: path.join(root, "session"), sessionId: "session", model,
    tools: ["read"], extensions: [], childRuntimePath: path.join(root, "runtime"), systemPrompt: "system", prompt: "brief",
    parentPaneId: "terminal_1", timeoutMs: 200, signal: abort.signal,
  }, { zellij: controller });
  setTimeout(() => abort.abort(), 10);
  const result = await resultPromise;
  assert.equal(result.status, "aborted");
  assert.ok(interrupted >= 1);
  assert.equal(fs.readFileSync(result.artifacts.cancelPath, "utf8").trim(), result.runId);
});

test("FP-07/Integration: WHEN cancellation arrives during result parsing, SHALL retain usage and keep the pane open", async () => {
  const root = temp();
  const sessionDir = path.join(root, "session");
  const abort = new AbortController();
  const runId = randomUUID();
  const controller: ZellijOperations = {
    createSurface: async () => {
      const artifacts = findArtifacts(root);
      writeSession(sessionDir, "session", "child report");
      writeExitSidecar(artifacts.exitPath, { runId, exitCode: 0, finishedAt: new Date().toISOString() });
      return surface;
    }, sendCommand: async () => {}, interrupt: async () => {}, close: async () => { throw new Error("must not close"); },
    paneExists: async () => true, screen: async () => "",
  };
  let findCalls = 0;
  const result = await runChildTask({
    taskId: randomUUID(), runId, cwd: root, artifactRoot: root, sessionDir, sessionId: "session", model,
    tools: ["read"], extensions: [], childRuntimePath: path.join(root, "runtime"), systemPrompt: "system", prompt: "brief",
    parentPaneId: "terminal_1", timeoutMs: 200, signal: abort.signal,
  }, { zellij: controller, findSessionFile: (dir, id) => { findCalls++; if (findCalls >= 2) abort.abort(); return path.join(dir, `${id}.jsonl`); } });
  assert.equal(result.status, "aborted");
  assert.equal(result.report, "child report");
  assert.equal(result.costUsd, 0.3);
});
