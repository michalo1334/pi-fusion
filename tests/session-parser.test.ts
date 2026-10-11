import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { captureSessionCursor, createSessionCursor, readRunResult, SessionIntegrityError, type SessionCursor } from "../extensions/session-parser.ts";

const root = () => fs.mkdtempSync(path.join(os.tmpdir(), "fp06-session-"));
const header = (id = "session-1") => ({ type: "session", version: 3, id, timestamp: new Date(0).toISOString(), cwd: "/tmp/project" });
const entry = (id: string, parentId: string | null, value: Record<string, unknown>) => ({ id, parentId, timestamp: new Date(0).toISOString(), ...value });
const assistant = (id: string, parentId: string, text: string, usage: Record<string, unknown> = {}, stopReason = "stop") => entry(id, parentId, {
  type: "message",
  message: {
    role: "assistant", content: text ? [{ type: "text", text }] : [], api: "offline-faux-api", provider: "offline-faux", model: "offline",
    usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 }, ...usage }, stopReason,
    timestamp: 0,
  },
});
const write = (file: string, values: unknown[]) => fs.writeFileSync(file, values.map((value) => JSON.stringify(value)).join("\n") + "\n");
const append = (file: string, values: unknown[]) => fs.appendFileSync(file, values.map((value) => JSON.stringify(value)).join("\n") + "\n");

function baseSession(file: string): SessionCursor {
  write(file, [header(), entry("u0", null, { type: "message", message: { role: "user", content: "brief", timestamp: 0 } })]);
  return captureSessionCursor(file);
}

test("FP-06/Unit FPR-01: WHEN a new session is created, SHALL read its header and complete assistant report", async () => {
  const file = path.join(root(), "session.jsonl");
  const cursor = createSessionCursor(file);
  write(file, [header(), entry("u1", null, { type: "message", message: { role: "user", content: "brief", timestamp: 0 } }), assistant("a1", "u1", "fresh report")]);
  const result = await readRunResult(file, cursor, { probeIntervalMs: 1 });
  assert.equal(result.outcome, "success");
  assert.equal(result.report, "fresh report");
  assert.equal(result.usage.totalTokens, 5);
  assert.equal(result.usage.cost.total, 0.3);
});

test("FP-06/Integration FPR-02: WHEN the final line flushes after process exit, SHALL wait for the complete JSONL entry", async () => {
  const file = path.join(root(), "session.jsonl");
  const cursor = baseSession(file);
  const final = JSON.stringify(assistant("a1", "u0", "delayed report"));
  fs.appendFileSync(file, final.slice(0, 20));
  setTimeout(() => fs.appendFileSync(file, final.slice(20) + "\n"), 25);
  const result = await readRunResult(file, cursor, { processExited: true, stabilityTimeoutMs: 300, probeIntervalMs: 3 });
  assert.equal(result.report, "delayed report");
  assert.equal(result.partialTail, false);
});

test("FP-06/Unit FPR-03: WHEN a process is still running, SHALL return complete entries and mark the partial tail", async () => {
  const file = path.join(root(), "session.jsonl");
  const cursor = baseSession(file);
  fs.appendFileSync(file, JSON.stringify(assistant("a1", "u0", "stable prefix")));
  const result = await readRunResult(file, cursor, { isProcessAlive: () => true, probeIntervalMs: 2 });
  assert.equal(result.partialTail, true);
  assert.equal(result.report, "(sidekick produced no report)");
  assert.equal(result.usage.totalTokens, 0);
});

test("FP-06/Unit FPR-04: WHEN a finalized line is malformed, SHALL reject it instead of using an old report", async () => {
  const file = path.join(root(), "session.jsonl");
  const cursor = baseSession(file);
  fs.appendFileSync(file, JSON.stringify(assistant("a1", "u0", "evidence", { totalTokens: 9 })) + "\n{not-json}\n");
  await assert.rejects(readRunResult(file, cursor, { probeIntervalMs: 1 }), (error: unknown) => {
    assert.ok(error instanceof SessionIntegrityError);
    assert.match(error.message, /Malformed finalized JSONL/);
    assert.equal(error.partialUsage?.totalTokens, 9);
    assert.equal(error.partialReport, "evidence");
    return true;
  });
});

test("FP-06/Integration FPR-05: WHEN the session is truncated, replaced, or its prefix is rewritten, SHALL reject the run", async () => {
  const dir = root();
  const file = path.join(dir, "session.jsonl");
  const cursor = baseSession(file);
  fs.appendFileSync(file, JSON.stringify(assistant("a1", "u0", "report")) + "\n");
  fs.truncateSync(file, cursor.byteOffset - 1);
  await assert.rejects(readRunResult(file, cursor, { probeIntervalMs: 1 }), /truncated/);

  const replacement = path.join(dir, "replacement.jsonl");
  const replacementCursor = baseSession(replacement);
  const saved = fs.readFileSync(replacement);
  fs.renameSync(replacement, replacement + ".old");
  fs.writeFileSync(replacement, saved);
  append(replacement, [assistant("a2", "u0", "replacement")]);
  await assert.rejects(readRunResult(replacement, replacementCursor, { probeIntervalMs: 1 }), /replaced/);

  const rewritten = path.join(dir, "rewritten.jsonl");
  const rewriteCursor = baseSession(rewritten);
  const original = fs.readFileSync(rewritten, "utf8");
  fs.writeFileSync(rewritten, `${original.replace("brief", "other!")}\n`);
  append(rewritten, [assistant("a3", "u0", "rewritten")]);
  await assert.rejects(readRunResult(rewritten, rewriteCursor, { probeIntervalMs: 1 }), /prefix was rewritten/);
});

test("FP-06/Unit FPR-06: WHEN a child creates a fork, SHALL show only the active report and bill every new finalized assistant", async () => {
  const file = path.join(root(), "session.jsonl");
  const cursor = baseSession(file);
  append(file, [
    assistant("abandoned", "u0", "abandoned report", { input: 90, output: 90, totalTokens: 180 }, "error"),
    entry("summary", "u0", { type: "branch_summary", fromId: "abandoned", summary: "old branch" }),
    entry("u2", "summary", { type: "message", message: { role: "user", content: "continue", timestamp: 0 } }),
    assistant("active", "u2", "active report", { input: 4, output: 6, totalTokens: 10 }),
  ]);
  const result = await readRunResult(file, cursor, { probeIntervalMs: 1 });
  assert.equal(result.report, "active report");
  assert.equal(result.outcome, "success");
  assert.equal(result.usage.totalTokens, 190);
  assert.equal(result.usage.cost.total, 0.6);

  const followupCursor = createSessionCursor(file);
  append(file, [
    entry("u3", "active", { type: "message", message: { role: "user", content: "follow up", timestamp: 0 } }),
    assistant("followup", "u3", "follow-up report", { input: 7, output: 8, totalTokens: 15 }),
  ]);
  const followup = await readRunResult(file, followupCursor, { probeIntervalMs: 1 });
  assert.equal(followup.report, "follow-up report");
  assert.equal(followup.usage.totalTokens, 15);
  assert.equal(followup.usage.cost.total, 0.3);
});

test("FP-06/Unit FPR-07: WHEN an intermediate assistant uses a tool, SHALL include both new authoritative usages and return the final text", async () => {
  const file = path.join(root(), "session.jsonl");
  const cursor = baseSession(file);
  append(file, [
    assistant("tool-turn", "u0", "", { input: 2, output: 3, reasoning: 3, totalTokens: 5 }, "toolUse"),
    entry("tool", "tool-turn", { type: "message", message: { role: "toolResult", toolCallId: "x", toolName: "read", content: [], isError: false, timestamp: 0 } }),
    assistant("final", "tool", "final text", { input: 4, output: 6, totalTokens: 10 }),
  ]);
  const result = await readRunResult(file, cursor, { probeIntervalMs: 1 });
  assert.equal(result.report, "final text");
  assert.equal(result.usage.totalTokens, 15);
  assert.equal(result.usage.output, 9);
  assert.equal(result.usage.reasoning, 3);
});

test("FP-06/Unit FPR-08: WHEN a provider error or aborted stop reason is finalized, SHALL map the outcome and preserve new usage", async () => {
  const provider = path.join(root(), "provider.jsonl");
  const cursor = baseSession(provider);
  append(provider, [assistant("error", "u0", "", { input: 7, output: 1, totalTokens: 8 }, "error")]);
  const errored = await readRunResult(provider, cursor, { probeIntervalMs: 1 });
  assert.equal(errored.outcome, "error");
  assert.equal(errored.errorMessage, "Sidekick provider returned an error");
  assert.equal(errored.usage.totalTokens, 8);

  const aborted = path.join(root(), "aborted.jsonl");
  const abortedCursor = baseSession(aborted);
  append(aborted, [assistant("aborted", "u0", "partial", { input: 3, output: 2, totalTokens: 5 }, "aborted")]);
  const stopped = await readRunResult(aborted, abortedCursor, { probeIntervalMs: 1 });
  assert.equal(stopped.outcome, "aborted");
  assert.equal(stopped.usage.totalTokens, 5);
});

test("FP-06/Integration FPR-09: WHEN follow-up starts from a stored cursor, SHALL not repeat prior report or usage", async () => {
  const file = path.join(root(), "session.jsonl");
  const before = baseSession(file);
  append(file, [assistant("a1", "u0", "first report", { input: 10, output: 1, totalTokens: 11 })]);
  const first = await readRunResult(file, before, { probeIntervalMs: 1 });
  const followupCursor = createSessionCursor(file);
  append(file, [entry("u2", "a1", { type: "message", message: { role: "user", content: "follow up", timestamp: 0 } }), assistant("a2", "u2", "second report", { input: 20, output: 2, totalTokens: 22 })]);
  const second = await readRunResult(file, followupCursor, { probeIntervalMs: 1 });
  assert.equal(first.usage.totalTokens, 11);
  assert.equal(second.report, "second report");
  assert.equal(second.usage.totalTokens, 22);
});

test("FP-06/Unit FPR-10: WHEN usage is zero or absent, SHALL return a complete zero usage shape and a deliberate fallback report", async () => {
  const file = path.join(root(), "session.jsonl");
  const cursor = baseSession(file);
  append(file, [entry("a1", "u0", { type: "message", message: { role: "assistant", content: [], stopReason: "stop", timestamp: 0 } })]);
  const result = await readRunResult(file, cursor, { probeIntervalMs: 1 });
  assert.equal(result.report, "(sidekick produced no report)");
  assert.deepEqual(result.usage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
});

test("FP-06/Unit FPR-11: WHEN a complete file tail is stable, SHALL finish without waiting for an unbounded flush", async () => {
  const file = path.join(root(), "session.jsonl");
  const cursor = baseSession(file);
  append(file, [assistant("a1", "u0", "stable tail")]);
  const started = Date.now();
  const result = await readRunResult(file, cursor, { stabilityTimeoutMs: 100, probeIntervalMs: 2 });
  assert.equal(result.report, "stable tail");
  assert.ok(Date.now() - started < 100);
});

test("FP-06/Unit FPR-12: WHEN the partial tail never stabilizes after exit, SHALL fail with a bounded actionable error", async () => {
  const file = path.join(root(), "session.jsonl");
  const cursor = baseSession(file);
  fs.appendFileSync(file, JSON.stringify(assistant("a1", "u0", "never complete")).slice(0, 18));
  await assert.rejects(readRunResult(file, cursor, { processExited: true, stabilityTimeoutMs: 35, probeIntervalMs: 2 }), /incomplete JSONL line/);
});

test("FP-06/Unit FPR-13: WHEN a result read is aborted or a process probe fails, SHALL return a bounded actionable error", async () => {
  const file = path.join(root(), "session.jsonl");
  const cursor = baseSession(file);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(readRunResult(file, cursor, { signal: aborted.signal, probeIntervalMs: 1 }), /read was aborted/);
  await assert.rejects(readRunResult(file, cursor, { isProcessAlive: () => { throw new Error("probe unavailable"); }, probeIntervalMs: 1 }), /Process state probe failed: probe unavailable/);
});

test("FP-06/Unit FPR-14: WHEN an exit record reports a nonzero or aborted process, SHALL map status without claiming success", async () => {
  const file = path.join(root(), "session.jsonl");
  const cursor = baseSession(file);
  append(file, [assistant("a1", "u0", "partial")]);
  const result = await readRunResult(file, cursor, { exitStatus: { exitCode: 7, error: "child failed" }, probeIntervalMs: 1 });
  assert.equal(result.outcome, "error");
  assert.equal(result.errorMessage, "child failed");
});
