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

function findArtifacts(root: string, runId?: string): RunArtifacts {
  const task = fs.readdirSync(root).find((name) => name !== "session")!;
  const taskDir = path.join(root, task);
  const run = runId ?? fs.readdirSync(path.join(taskDir, "runs"))[0];
  const runDir = path.join(taskDir, "runs", run);
  return {
    taskDir, runDir,
    promptPath: path.join(runDir, "prompt.md"), systemPromptPath: path.join(runDir, "system.md"),
    pidPath: path.join(runDir, "pid"), exitPath: path.join(runDir, "exit.json"), runtimeErrorPath: path.join(runDir, "runtime-error.json"), cancelPath: path.join(runDir, "cancel"), launchPath: path.join(runDir, "launch.mjs"),
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

test("FP-08/Integration: WHEN follow-up starts, THE runner SHALL resume the same session in a new pane and return only new report and usage", async () => {
  const root = temp();
  const sessionDir = path.join(root, "session");
  const taskId = randomUUID();
  let createCount = 0;
  const controller: ZellijOperations = {
    createSurface: async () => {
      createCount += 1;
      const runId = createCount === 1 ? firstRunId : secondRunId;
      const artifacts = findArtifacts(root, runId);
      if (createCount === 1) writeSession(sessionDir, "session", "first report");
      else fs.appendFileSync(path.join(sessionDir, "session.jsonl"), [
        JSON.stringify({ type: "message", id: "u2", parentId: "a1", timestamp: new Date(0).toISOString(), message: { role: "user", content: "follow up", timestamp: 0 } }),
        JSON.stringify({ type: "message", id: "a2", parentId: "u2", timestamp: new Date(0).toISOString(), message: {
          role: "assistant", content: [{ type: "text", text: "second report" }], stopReason: "stop", timestamp: 0,
          usage: { input: 4, output: 5, totalTokens: 9, cost: { input: 0.4, output: 0.5, cacheRead: 0, cacheWrite: 0, total: 0.9 } },
        } }), "",
      ].join("\n"));
      writeExitSidecar(artifacts.exitPath, { runId, exitCode: 0, finishedAt: new Date().toISOString() });
      return { paneId: `terminal_${createCount + 1}`, parentPaneId: "terminal_1" };
    },
    sendCommand: async () => {}, interrupt: async () => {}, close: async () => {}, paneExists: async () => true, screen: async () => "",
  };
  const firstRunId = randomUUID();
  const secondRunId = randomUUID();
  const input = (runId: string, prompt: string) => ({
    taskId, runId, cwd: root, artifactRoot: root, sessionDir, sessionId: "session", model,
    tools: ["read"], extensions: [], childRuntimePath: path.join(root, "runtime"), systemPrompt: "system", prompt,
    parentPaneId: "terminal_1", timeoutMs: 200,
  });
  const first = await runChildTask(input(firstRunId, "brief"), { zellij: controller });
  const second = await runChildTask(input(secondRunId, "follow up"), { zellij: controller });
  assert.equal(createCount, 2);
  assert.equal(first.status, "ok");
  assert.equal(second.status, "ok");
  assert.equal(first.report, "first report");
  assert.equal(second.report, "second report");
  assert.equal(first.costUsd, 0.3);
  assert.equal(second.costUsd, 0.9);
  assert.equal(first.sessionFile, second.sessionFile);
  assert.notDeepEqual(first.cursor, { byteOffset: 0 });
  assert.equal(second.report.includes("first report"), false);
});

test("FP-08/Integration: WHEN the previous child turn fails with a provider error, THE runner SHALL permit a valid saved session to resume", async () => {
  const root = temp();
  const sessionDir = path.join(root, "session");
  const taskId = randomUUID();
  const firstRunId = randomUUID();
  const secondRunId = randomUUID();
  let createCount = 0;
  const controller: ZellijOperations = {
    createSurface: async () => {
      createCount += 1;
      const runId = createCount === 1 ? firstRunId : secondRunId;
      const artifacts = findArtifacts(root, runId);
      if (createCount === 1) {
        writeSession(sessionDir, "session", "provider report");
        writeExitSidecar(artifacts.exitPath, { runId: firstRunId, exitCode: 7, error: "provider error", finishedAt: new Date().toISOString() });
      } else {
        fs.appendFileSync(path.join(sessionDir, "session.jsonl"), [
          JSON.stringify({ type: "message", id: "u2", parentId: "a1", timestamp: new Date(0).toISOString(), message: { role: "user", content: "retry", timestamp: 0 } }),
          JSON.stringify({ type: "message", id: "a2", parentId: "u2", timestamp: new Date(0).toISOString(), message: {
            role: "assistant", content: [{ type: "text", text: "recovered" }], stopReason: "stop", timestamp: 0,
            usage: { input: 1, output: 1, totalTokens: 2, cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0, total: 0.2 } },
          } }), "",
        ].join("\n"));
        writeExitSidecar(artifacts.exitPath, { runId: secondRunId, exitCode: 0, finishedAt: new Date().toISOString() });
      }
      return { paneId: `terminal_${createCount + 2}`, parentPaneId: "terminal_1" };
    },
    sendCommand: async () => {}, interrupt: async () => {}, close: async () => {}, paneExists: async () => true, screen: async () => "",
  };
  const input = (runId: string) => ({ taskId, runId, cwd: root, artifactRoot: root, sessionDir, sessionId: "session", model,
    tools: ["read"], extensions: [], childRuntimePath: path.join(root, "runtime"), systemPrompt: "system", prompt: "retry", parentPaneId: "terminal_1", timeoutMs: 200 });
  const failed = await runChildTask(input(firstRunId), { zellij: controller });
  const resumed = await runChildTask(input(secondRunId), { zellij: controller });
  assert.equal(failed.status, "error");
  assert.equal(failed.taskValid, true);
  assert.equal(resumed.status, "ok");
  assert.equal(resumed.report, "recovered");
  assert.equal(resumed.costUsd, 0.2);
});

test("FP-08/Integration: WHEN termination fails, THE runner SHALL retain cleanup control for a bounded retry without closing the pane", async () => {
  const root = temp();
  const runId = randomUUID();
  let artifacts!: RunArtifacts;
  let interrupts = 0;
  let closes = 0;
  const controller: ZellijOperations = {
    createSurface: async () => { artifacts = findArtifacts(root, runId); return surface; },
    sendCommand: async () => {},
    interrupt: async () => {
      interrupts += 1;
      if (interrupts === 1) throw new Error("termination denied");
      writeExitSidecar(artifacts.exitPath, { runId, exitCode: 143, finishedAt: new Date().toISOString() });
    },
    close: async () => { closes += 1; },
    paneExists: async () => false,
    screen: async () => "",
  };
  const result = await runChildTask({
    taskId: randomUUID(), runId, cwd: root, artifactRoot: root, sessionDir: path.join(root, "session"), sessionId: "session", model,
    tools: ["read"], extensions: [], childRuntimePath: path.join(root, "runtime"), systemPrompt: "system", prompt: "brief",
    parentPaneId: "terminal_1", timeoutMs: 100,
  }, { zellij: controller });
  assert.equal(result.status, "error");
  assert.equal(result.cleanupPending, true);
  assert.match(result.errorMessage ?? "", /termination denied/);
  assert.equal(closes, 0);
  const retry = await result.retryCleanup!();
  assert.equal(retry.pending, false);
  assert.equal(interrupts, 2);
  assert.equal(closes, 0);
});

test("FP-17 Unit: WHEN a valid follow-up has a retained failed pane, THEN it verifies closure before creating a fresh surface", async () => {
  const root = temp();
  const sessionDir = path.join(root, "session");
  writeSession(sessionDir, "session", "first report");
  const events: string[] = [];
  const controller: ZellijOperations = {
    closeRetainedSurface: async () => { events.push("close-retained"); return "closed"; },
    createSurface: async () => { events.push("create"); throw new Error("stop after order check"); },
    sendCommand: async () => {}, interrupt: async () => {}, close: async () => {}, paneExists: async () => false, screen: async () => "",
  };
  const outcome = await runChildTask({
    taskId: randomUUID(), runId: randomUUID(), cwd: root, artifactRoot: root, sessionDir, sessionId: "session",
    sessionFile: path.join(sessionDir, "session.jsonl"), requireExistingSession: true,
    retainedFailureSurface: { surface, launchPath: "/private/old/launch.mjs" },
    tools: ["read"], extensions: [], childRuntimePath: path.join(root, "runtime"), systemPrompt: "system", prompt: "retry",
    parentPaneId: "terminal_1", timeoutMs: 100,
  }, { zellij: controller });
  assert.equal(outcome.status, "error");
  assert.deepEqual(events, ["close-retained", "create"]);

  const fallbackEvents: string[] = [];
  const missingController: ZellijOperations = {
    closeRetainedSurface: async () => { fallbackEvents.push("lookup"); return "not-found-or-unowned"; },
    createSurface: async () => { fallbackEvents.push("create"); throw new Error("missing pane fallback checked"); },
    sendCommand: async () => {}, interrupt: async () => {}, close: async () => {}, paneExists: async () => false, screen: async () => "",
  };
  const fallback = await runChildTask({
    taskId: randomUUID(), runId: randomUUID(), cwd: root, artifactRoot: root, sessionDir, sessionId: "session",
    sessionFile: path.join(sessionDir, "session.jsonl"), requireExistingSession: true,
    retainedFailureSurface: { surface, launchPath: "/private/missing/launch.mjs" },
    tools: ["read"], extensions: [], childRuntimePath: path.join(root, "runtime"), systemPrompt: "system", prompt: "retry",
    parentPaneId: "terminal_1", timeoutMs: 100,
  }, { zellij: missingController });
  assert.equal(fallback.status, "error");
  assert.deepEqual(fallbackEvents, ["lookup", "create"]);
});

test("FP-17 Unit: WHEN retained-pane close fails before creation, THEN it rejects directly without synthetic child cleanup", async () => {
  const root = temp();
  const sessionDir = path.join(root, "session");
  writeSession(sessionDir, "session", "prior report");
  let creates = 0;
  let interrupts = 0;
  let sleeps = 0;
  const abort = new AbortController();
  const runId = randomUUID();
  const controller: ZellijOperations = {
    closeRetainedSurface: async () => { throw new Error("Verified retained pane terminal_2 could not close: close denied"); },
    createSurface: async () => { creates++; return surface; },
    sendCommand: async () => {}, interrupt: async () => { interrupts++; }, close: async () => {}, paneExists: async () => false, screen: async () => "",
  };
  await assert.rejects(() => runChildTask({
    taskId: "close-failure", runId, cwd: root, artifactRoot: root, sessionDir, sessionId: "session",
    sessionFile: path.join(sessionDir, "session.jsonl"), requireExistingSession: true,
    retainedFailureSurface: { surface, launchPath: "/private/old/launch.mjs" },
    tools: ["read"], extensions: [], childRuntimePath: path.join(root, "runtime"), systemPrompt: "system", prompt: "retry",
    parentPaneId: "terminal_1", timeoutMs: 100, signal: abort.signal,
  }, { zellij: controller, sleep: async () => { sleeps++; } }), error => {
    const message = error instanceof Error ? error.message : String(error);
    assert.match(message, /Verified retained pane terminal_2 could not close: close denied/);
    assert.doesNotMatch(message, /owned child did not establish a PID/);
    return true;
  });
  abort.abort();
  assert.equal(fs.existsSync(path.join(root, "close-failure", "runs", runId, "cancel")), false);
  assert.equal(creates, 0);
  assert.equal(interrupts, 0);
  assert.equal(sleeps, 0);
});

test("FP-17 Unit: WHEN a launch is fresh, or the session or signal is invalid, THEN it does not close a retained pane", async () => {
  const root = temp();
  let retainedCloses = 0;
  const controller: ZellijOperations = {
    closeRetainedSurface: async () => { retainedCloses++; return "closed"; },
    createSurface: async () => { throw new Error("fresh launch checked"); },
    sendCommand: async () => {}, interrupt: async () => {}, close: async () => {}, paneExists: async () => false, screen: async () => "",
  };
  const base = {
    taskId: randomUUID(), runId: randomUUID(), cwd: root, artifactRoot: root, sessionDir: path.join(root, "session"), sessionId: "session",
    model, tools: ["read"], extensions: [], childRuntimePath: path.join(root, "runtime"), systemPrompt: "system", prompt: "retry",
    parentPaneId: "terminal_1", timeoutMs: 100,
    retainedFailureSurface: { surface, launchPath: "/private/old/launch.mjs" },
  };
  await runChildTask(base, { zellij: controller });
  assert.equal(retainedCloses, 0, "fresh delegates do not replace panes");

  writeSession(base.sessionDir, "session", "prior report");
  await assert.rejects(() => runChildTask({
    ...base, runId: randomUUID(), requireExistingSession: true, sessionFile: path.join(base.sessionDir, "session.jsonl"),
    expectedSessionCursor: { byteOffset: 999_999, sessionId: "session" },
  }, { zellij: controller }), /cursor/i);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(() => runChildTask({ ...base, runId: randomUUID(), signal: aborted.signal }, { zellij: controller }), /cancelled before allocation/);
  assert.equal(retainedCloses, 0);
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
