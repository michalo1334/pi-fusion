import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { runChildTask } from "../extensions/child-runner.ts";
import { writeExitSidecar, type RunArtifacts } from "../extensions/child-process.ts";
import type { ZellijSurface } from "../extensions/zellij.ts";
import { childInput } from "./fixtures/child-input.ts";
import { createZellijFake } from "./fixtures/zellij-fake.ts";
import { tempRoot, type TestCleanup } from "./fixtures/temp-root.ts";
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

async function runFake(t: TestCleanup, options: { complete?: boolean; partial?: boolean; disappear?: boolean; createError?: boolean; exitCode?: number; signal?: AbortSignal } = {}) {
  const root = tempRoot(t, "fp07-runner");
  const sessionDir = path.join(root, "session");
  const runId = randomUUID();
  let alive = true;
  const zellij = createZellijFake({
    createSurface: async () => {
      if (options.createError) throw new Error("surface startup failed");
      const artifacts = findArtifacts(root);
      if (options.disappear) { alive = false; return surface; }
      if (options.complete !== false || options.partial) {
        writeSession(sessionDir, "session", "child report");
        if (options.complete !== false) writeExitSidecar(artifacts.exitPath, { runId, exitCode: options.exitCode ?? 0, finishedAt: new Date().toISOString(), ...(options.exitCode ? { error: "provider error" } : {}) });
      }
      return surface;
    },
    interrupt: async () => { alive = false; },
    close: async () => { alive = false; },
    paneExists: async () => alive,
  });
  const result = await runChildTask(childInput(root, {
    runId,
    sessionDir,
    childRuntimePath: path.join(root, "child-runtime.ts"),
    signal: options.signal,
  }), { zellij: zellij.operations, sleep: async (ms) => new Promise((resolve) => setTimeout(resolve, ms)) });
  return { result, zellij };
}

test("FP-07/Integration: WHEN a child reports success, SHALL return the new report and close its pane once", async (t) => {
  const run = await runFake(t);
  assert.equal(run.result.status, "ok");
  assert.equal(run.result.report, "child report");
  assert.equal(run.result.costUsd, 0.3);
  assert.equal(run.zellij.calls.close.length, 1);
  assert.equal(run.zellij.calls.createSurface[0]?.command?.length, 2);
});

test("FP-07/Unit: WHEN child surface startup fails, SHALL return an actionable error without a second spawn", async (t) => {
  const run = await runFake(t, { createError: true });
  assert.equal(run.result.status, "error");
  assert.match(run.result.errorMessage ?? "", /surface startup failed/);
  assert.equal(run.zellij.calls.close.length, 0);
});

test("FP-07/Unit: WHEN the child reports a provider error, SHALL retain its pane and preserve the report evidence", async (t) => {
  const run = await runFake(t, { exitCode: 7 });
  assert.equal(run.result.status, "error");
  assert.equal(run.result.report, "child report");
  assert.equal(run.result.costUsd, 0.3);
  assert.equal(run.zellij.calls.close.length, 0);
});

test("FP-07/Unit: WHEN the owned pane disappears, SHALL retain the surface and return an error", async (t) => {
  const run = await runFake(t, { disappear: true });
  assert.equal(run.result.status, "error");
  assert.equal(run.zellij.calls.close.length, 0);
});

test("FP-07/Unit: WHEN the child does not settle before timeout, SHALL return timeout and retain its pane", async (t) => {
  const run = await runFake(t, { complete: false });
  assert.equal(run.result.status, "timeout");
  assert.equal(run.zellij.calls.close.length, 0);
});

test("FP-07/Integration: WHEN timeout follows billed assistant output, SHALL preserve new usage and report", async (t) => {
  const run = await runFake(t, { complete: false, partial: true });
  assert.equal(run.result.status, "timeout");
  assert.equal(run.result.report, "child report");
  assert.equal(run.result.costUsd, 0.3);
  assert.equal(run.zellij.calls.close.length, 0);
});

test("FP-07/Unit: WHEN pane interruption fails, SHALL return the termination error and retain the run", async (t) => {
  const root = tempRoot(t, "fp07-runner");
  const zellij = createZellijFake({
    createSurface: async () => surface,
    interrupt: async () => { throw new Error("interrupt denied"); },
    paneExists: async () => false,
  });
  const result = await runChildTask(childInput(root), { zellij: zellij.operations });
  assert.equal(result.status, "error");
  assert.match(result.errorMessage ?? "", /interrupt denied/);
});

test("FP-07/Unit: WHEN the owned PID fingerprint is invalid, SHALL report the stop failure", async (t) => {
  const root = tempRoot(t, "fp07-runner");
  const runId = randomUUID();
  const zellij = createZellijFake({
    createSurface: async () => {
      const artifacts = findArtifacts(root);
      fs.writeFileSync(artifacts.pidPath, JSON.stringify({ runId, pid: 99999 }) + "\n");
      return surface;
    },
    interrupt: async () => {},
    paneExists: async () => false,
  });
  const result = await runChildTask(childInput(root, { runId }), { zellij: zellij.operations });
  assert.equal(result.status, "error");
  assert.match(result.errorMessage ?? "", /owned child termination failed/);
});

test("FP-07/Unit: WHEN cancellation arrives before allocation, SHALL not create artifacts or a pane", async (t) => {
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(() => runFake(t, { signal: abort.signal }), /cancelled before allocation/);
});

test("FP-07/Integration: WHEN cancellation arrives during delayed surface creation, SHALL suppress late child launch", async (t) => {
  const root = tempRoot(t, "fp07-runner");
  const sessionDir = path.join(root, "session");
  const abort = new AbortController();
  const zellij = createZellijFake({
    createSurface: async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return surface;
    },
    interrupt: async () => {},
    close: async () => {},
    paneExists: async () => true,
  });
  setTimeout(() => abort.abort(), 5);
  const result = await runChildTask(childInput(root, {
    sessionDir,
    timeoutMs: 200,
    signal: abort.signal,
  }), { zellij: zellij.operations });
  assert.equal(zellij.calls.createSurface.length, 1);
  assert.equal(result.status, "aborted");
  assert.equal(fs.readFileSync(result.artifacts.cancelPath, "utf8").trim(), result.runId);
});

test("FP-07/Integration: WHEN cancellation arrives before a delayed PID beyond the old grace, SHALL leave a cancellation handshake", async (t) => {
  const root = tempRoot(t, "fp07-runner");
  const abort = new AbortController();
  const zellij = createZellijFake({
    createSurface: async () => surface,
    interrupt: async () => {},
    close: async () => {},
    paneExists: async () => true,
  });
  const resultPromise = runChildTask(childInput(root, {
    timeoutMs: 200,
    signal: abort.signal,
  }), { zellij: zellij.operations });
  setTimeout(() => abort.abort(), 10);
  const result = await resultPromise;
  assert.equal(result.status, "aborted");
  assert.ok(zellij.calls.interrupt.length >= 1);
  assert.equal(fs.readFileSync(result.artifacts.cancelPath, "utf8").trim(), result.runId);
});

test("FP-08/Integration: WHEN follow-up starts, THE runner SHALL resume the same session in a new pane and return only new report and usage", async (t) => {
  const root = tempRoot(t, "fp07-runner");
  const sessionDir = path.join(root, "session");
  const taskId = randomUUID();
  let createCount = 0;
  const zellij = createZellijFake({
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
    close: async () => {},
    paneExists: async () => true,
  });
  const firstRunId = randomUUID();
  const secondRunId = randomUUID();
  const input = (runId: string, prompt: string) => childInput(root, {
    taskId,
    runId,
    sessionDir,
    prompt,
    timeoutMs: 200,
  });
  const first = await runChildTask(input(firstRunId, "brief"), { zellij: zellij.operations });
  const second = await runChildTask(input(secondRunId, "follow up"), { zellij: zellij.operations });
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

test("FP-08/Integration: WHEN the previous child turn fails with a provider error, THE runner SHALL permit a valid saved session to resume", async (t) => {
  const root = tempRoot(t, "fp07-runner");
  const sessionDir = path.join(root, "session");
  const taskId = randomUUID();
  const firstRunId = randomUUID();
  const secondRunId = randomUUID();
  let createCount = 0;
  const zellij = createZellijFake({
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
    close: async () => {},
    paneExists: async () => true,
  });
  const input = (runId: string) => childInput(root, {
    taskId,
    runId,
    sessionDir,
    prompt: "retry",
    timeoutMs: 200,
  });
  const failed = await runChildTask(input(firstRunId), { zellij: zellij.operations });
  const resumed = await runChildTask(input(secondRunId), { zellij: zellij.operations });
  assert.equal(failed.status, "error");
  assert.equal(failed.taskValid, true);
  assert.equal(resumed.status, "ok");
  assert.equal(resumed.report, "recovered");
  assert.equal(resumed.costUsd, 0.2);
});

test("FP-08/Integration: WHEN termination fails, THE runner SHALL retain cleanup control for a bounded retry without closing the pane", async (t) => {
  const root = tempRoot(t, "fp07-runner");
  const runId = randomUUID();
  let artifacts!: RunArtifacts;
  let interrupts = 0;
  const zellij = createZellijFake({
    createSurface: async () => { artifacts = findArtifacts(root, runId); return surface; },
    interrupt: async () => {
      interrupts += 1;
      if (interrupts === 1) throw new Error("termination denied");
      writeExitSidecar(artifacts.exitPath, { runId, exitCode: 143, finishedAt: new Date().toISOString() });
    },
    close: async () => {},
    paneExists: async () => false,
  });
  const result = await runChildTask(childInput(root, { runId }), { zellij: zellij.operations });
  assert.equal(result.status, "error");
  assert.equal(result.cleanupPending, true);
  assert.match(result.errorMessage ?? "", /termination denied/);
  assert.equal(zellij.calls.close.length, 0);
  const retry = await result.retryCleanup!();
  assert.equal(retry.pending, false);
  assert.equal(interrupts, 2);
  assert.equal(zellij.calls.close.length, 0);
});

test("FP-17 Unit: WHEN a valid follow-up has a retained failed pane, THEN it verifies closure before creating a fresh surface", async (t) => {
  const root = tempRoot(t, "fp07-runner");
  const sessionDir = path.join(root, "session");
  writeSession(sessionDir, "session", "first report");
  const events: string[] = [];
  const zellij = createZellijFake({
    closeRetainedSurface: async () => { events.push("close-retained"); return "closed"; },
    createSurface: async () => { events.push("create"); throw new Error("stop after order check"); },
  });
  const outcome = await runChildTask(childInput(root, {
    sessionDir,
    model: undefined,
    sessionFile: path.join(sessionDir, "session.jsonl"),
    requireExistingSession: true,
    retainedFailureSurface: { surface, launchPath: "/private/old/launch.mjs" },
    prompt: "retry",
  }), { zellij: zellij.operations });
  assert.equal(outcome.status, "error");
  assert.deepEqual(events, ["close-retained", "create"]);

  const fallbackEvents: string[] = [];
  const missingZellij = createZellijFake({
    closeRetainedSurface: async () => { fallbackEvents.push("lookup"); return "not-found-or-unowned"; },
    createSurface: async () => { fallbackEvents.push("create"); throw new Error("missing pane fallback checked"); },
  });
  const fallback = await runChildTask(childInput(root, {
    sessionDir,
    model: undefined,
    sessionFile: path.join(sessionDir, "session.jsonl"),
    requireExistingSession: true,
    retainedFailureSurface: { surface, launchPath: "/private/missing/launch.mjs" },
    prompt: "retry",
  }), { zellij: missingZellij.operations });
  assert.equal(fallback.status, "error");
  assert.deepEqual(fallbackEvents, ["lookup", "create"]);
});

test("FP-17 Unit: WHEN retained-pane close fails before creation, THEN it rejects directly without synthetic child cleanup", async (t) => {
  const root = tempRoot(t, "fp07-runner");
  const sessionDir = path.join(root, "session");
  writeSession(sessionDir, "session", "prior report");
  let sleeps = 0;
  const abort = new AbortController();
  const runId = randomUUID();
  const zellij = createZellijFake({
    closeRetainedSurface: async () => { throw new Error("Verified retained pane terminal_2 could not close: close denied"); },
  });
  await assert.rejects(() => runChildTask(childInput(root, {
    taskId: "close-failure",
    runId,
    sessionDir,
    model: undefined,
    sessionFile: path.join(sessionDir, "session.jsonl"),
    requireExistingSession: true,
    retainedFailureSurface: { surface, launchPath: "/private/old/launch.mjs" },
    prompt: "retry",
    signal: abort.signal,
  }), { zellij: zellij.operations, sleep: async () => { sleeps++; } }), error => {
    const message = error instanceof Error ? error.message : String(error);
    assert.match(message, /Verified retained pane terminal_2 could not close: close denied/);
    assert.doesNotMatch(message, /owned child did not establish a PID/);
    return true;
  });
  abort.abort();
  assert.equal(fs.existsSync(path.join(root, "close-failure", "runs", runId, "cancel")), false);
  assert.equal(zellij.calls.createSurface.length, 0);
  assert.equal(zellij.calls.interrupt.length, 0);
  assert.equal(sleeps, 0);
});

test("FP-17 Unit: WHEN a launch is fresh, or the session or signal is invalid, THEN it does not close a retained pane", async (t) => {
  const root = tempRoot(t, "fp07-runner");
  const zellij = createZellijFake({
    closeRetainedSurface: async () => "closed",
    createSurface: async () => { throw new Error("fresh launch checked"); },
  });
  const base = childInput(root, {
    prompt: "retry",
    retainedFailureSurface: { surface, launchPath: "/private/old/launch.mjs" },
  });
  await runChildTask(base, { zellij: zellij.operations });
  assert.equal(zellij.calls.closeRetainedSurface.length, 0, "fresh delegates do not replace panes");

  writeSession(base.sessionDir, "session", "prior report");
  await assert.rejects(() => runChildTask({
    ...base, runId: randomUUID(), requireExistingSession: true, sessionFile: path.join(base.sessionDir, "session.jsonl"),
    expectedSessionCursor: { byteOffset: 999_999, sessionId: "session" },
  }, { zellij: zellij.operations }), /cursor/i);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(() => runChildTask({ ...base, runId: randomUUID(), signal: aborted.signal }, { zellij: zellij.operations }), /cancelled before allocation/);
  assert.equal(zellij.calls.closeRetainedSurface.length, 0);
});

test("FP-07/Integration: WHEN cancellation arrives during result parsing, SHALL retain usage and keep the pane open", async (t) => {
  const root = tempRoot(t, "fp07-runner");
  const sessionDir = path.join(root, "session");
  const abort = new AbortController();
  const runId = randomUUID();
  const zellij = createZellijFake({
    createSurface: async () => {
      const artifacts = findArtifacts(root);
      writeSession(sessionDir, "session", "child report");
      writeExitSidecar(artifacts.exitPath, { runId, exitCode: 0, finishedAt: new Date().toISOString() });
      return surface;
    },
    close: async () => { throw new Error("must not close"); },
    paneExists: async () => true,
  });
  let findCalls = 0;
  const result = await runChildTask(childInput(root, {
    runId,
    sessionDir,
    timeoutMs: 200,
    signal: abort.signal,
  }), { zellij: zellij.operations, findSessionFile: (dir, id) => { findCalls++; if (findCalls >= 2) abort.abort(); return path.join(dir, `${id}.jsonl`); } });
  assert.equal(result.status, "aborted");
  assert.equal(result.report, "child report");
  assert.equal(result.costUsd, 0.3);
});
