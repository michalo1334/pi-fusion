import assert from "node:assert/strict";
import { appendFileSync, chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { writeExitSidecar } from "../extensions/child-process.ts";
import { runChildTask } from "../extensions/child-runner.ts";
import {
  MAX_SESSION_HEADER_BYTES,
  seedChildSessionFile,
  validateChildSessionLineage,
} from "../extensions/session-lineage.ts";

function persistHeader(file: string, header: unknown): void {
  const fd = openSync(file, "wx", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(header)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

test("LINEAGE-01 Integration: WHEN a child is seeded, THE child header SHALL persist its stable ID and parent path", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-fusion-lineage-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sessionDir = join(root, "sessions");
  mkdirSync(sessionDir, { recursive: true });
  const parent = SessionManager.create(root, sessionDir, { id: "parent-session" });
  const parentFile = parent.getSessionFile();
  assert.ok(parentFile);
  persistHeader(parentFile, parent.getHeader());

  chmodSync(sessionDir, 0o770);
  const parentBytes = readFileSync(parentFile);
  const childFile = seedChildSessionFile({
    parentSessionFile: parentFile,
    childCwd: root,
    sessionDir,
    childSessionId: "child-session",
  });
  assert.equal(statSync(sessionDir).mode & 0o777, 0o770);
  assert.deepEqual(readFileSync(parentFile), parentBytes);
  const header = JSON.parse(readFileSync(childFile, "utf8").split("\n", 1)[0]);
  assert.equal(header.id, "child-session");
  assert.equal(header.parentSession, parentFile);
  assert.equal(readFileSync(childFile, "utf8").trim().split("\n").length, 1);
  validateChildSessionLineage(childFile, "child-session", parentFile);

  const reopened = SessionManager.open(childFile, sessionDir, root);
  assert.equal(reopened.getHeader()?.parentSession, parentFile);
  const listed = await SessionManager.list(root, sessionDir);
  assert.equal(listed.find((info) => info.path === childFile)?.parentSessionPath, parentFile);
});

test("LINEAGE-02 Integration: WHEN seeding and launching, THE shared lead directory mode and parent bytes SHALL remain unchanged", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-fusion-lineage-runner-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sessionDir = join(root, "sessions");
  mkdirSync(sessionDir, { recursive: true, mode: 0o770 });
  chmodSync(sessionDir, 0o770);
  const parent = SessionManager.create(root, sessionDir, { id: "parent-session" });
  const parentFile = parent.getSessionFile()!;
  persistHeader(parentFile, parent.getHeader());
  const parentBytes = readFileSync(parentFile);
  const childFile = seedChildSessionFile({ parentSessionFile: parentFile, childCwd: root, sessionDir, childSessionId: "runner-child" });
  const taskId = "lineage-task";
  const runId = "lineage-run";
  const runDir = join(root, "artifacts", taskId, "runs", runId);
  const surface = { paneId: "terminal_2", parentPaneId: "terminal_1" };
  const result = await runChildTask({
    taskId, runId, cwd: root, artifactRoot: join(root, "artifacts"), sessionDir, sessionId: "runner-child",
    sessionFile: childFile, parentSessionFile: parentFile,
    model: { provider: "offline", id: "fixture", thinking: "off" }, tools: [], extensions: [],
    childRuntimePath: join(root, "runtime.ts"), systemPrompt: "system", prompt: "brief", parentPaneId: "terminal_1", timeoutMs: 100,
  }, {
    zellij: {
      closeRetainedSurface: async () => "not-found-or-unowned",
      createSurface: async () => {
        appendFileSync(childFile, `${JSON.stringify({ type: "message", id: "u1", parentId: null, timestamp: new Date(0).toISOString(), message: { role: "user", content: "brief", timestamp: 0 } })}\n`);
        appendFileSync(childFile, `${JSON.stringify({ type: "message", id: "a1", parentId: "u1", timestamp: new Date(0).toISOString(), message: { role: "assistant", content: [{ type: "text", text: "runner report" }], stopReason: "stop", timestamp: 0 } })}\n`);
        writeExitSidecar(join(runDir, "exit.json"), { runId, exitCode: 0, finishedAt: new Date().toISOString() });
        return surface;
      },
      interrupt: async () => {}, close: async () => {}, paneExists: async () => true,
    },
    sleep: async () => {},
  });
  assert.equal(result.status, "ok");
  assert.equal(statSync(sessionDir).mode & 0o777, 0o770);
  assert.deepEqual(readFileSync(parentFile), parentBytes);
});

test("LINEAGE-04 Unit: WHEN the parent has a long body, THE lineage reader SHALL use only the bounded header", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-fusion-lineage-body-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sessionDir = join(root, "sessions");
  mkdirSync(sessionDir, { recursive: true });
  const parentFile = join(sessionDir, "parent.jsonl");
  const header = { type: "session", version: 3, id: "parent", timestamp: new Date(0).toISOString(), cwd: root };
  writeFileSync(parentFile, `${JSON.stringify(header)}\n${"x".repeat(2_000_000)}`, { mode: 0o600 });
  const childFile = seedChildSessionFile({ parentSessionFile: parentFile, childCwd: root, sessionDir, childSessionId: "body-child" });
  assert.equal(JSON.parse(readFileSync(childFile, "utf8").split("\n", 1)[0]).parentSession, parentFile);
});

test("LINEAGE-05 Unit: IF the parent header is malformed, too large, or has no terminating newline, THEN seeding SHALL reject without writing a child", (t) => {
  const cases = [
    { name: "malformed", contents: "not-json\n", error: /not valid JSON/ },
    { name: "too-large", contents: `${"x".repeat(MAX_SESSION_HEADER_BYTES + 1)}\n`, error: /exceeds/ },
    { name: "eof", contents: JSON.stringify({ type: "session", version: 3, id: "parent", cwd: "/tmp" }), error: /incomplete/ },
  ] as const;
  for (const entry of cases) {
    const root = mkdtempSync(join(tmpdir(), `pi-fusion-lineage-${entry.name}-`));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const sessionDir = join(root, "sessions");
    mkdirSync(sessionDir, { recursive: true });
    const parentFile = join(sessionDir, "parent.jsonl");
    writeFileSync(parentFile, entry.contents, { mode: 0o600 });
    assert.throws(() => seedChildSessionFile({ parentSessionFile: parentFile, childCwd: root, sessionDir, childSessionId: `child-${entry.name}` }), entry.error);
    assert.equal(readFileSync(parentFile, "utf8"), entry.contents);
    assert.deepEqual(readdirSync(sessionDir), ["parent.jsonl"]);
  }
});

test("LINEAGE-06 Unit: IF the child parent pointer changes, THEN lineage validation SHALL reject it", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-fusion-lineage-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "child.jsonl");
  persistHeader(file, { type: "session", version: 3, id: "child", timestamp: new Date(0).toISOString(), cwd: root, parentSession: "/parent.jsonl" });
  assert.throws(() => validateChildSessionLineage(file, "child", "/other-parent.jsonl"), /parentSession/);
});
