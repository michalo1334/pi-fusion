import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { allocateRunArtifacts, buildChildArgs, createPromptArtifact, parseProcStat, resolvePiExecutable } from "../extensions/child-process.ts";

test("FP-05/Unit: Linux process identity parsing handles spaces and parentheses in comm", () => {
  const fields = ["R", ...Array.from({ length: 18 }, (_, index) => String(index + 1)), "987654", "0", "0"];
  assert.deepEqual(parseProcStat(`123 (worker (with spaces)) ${fields.join(" ")}`), { pid: 123, state: "R", startTime: "987654" });
});

test("FP-04/EARS: allocates unique private run artifacts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-test-"));
  const a = allocateRunArtifacts(root, "task.safe", "run-1");
  const b = allocateRunArtifacts(root, "task.safe", "run-2");
  assert.notEqual(a.runDir, b.runDir);
  assert.equal(fs.statSync(a.taskDir).mode & 0o777, 0o700);
  assert.throws(() => allocateRunArtifacts(root, "../escape", "run"));
  assert.throws(() => allocateRunArtifacts(root, "task.safe", "run-1"));
  fs.symlinkSync(path.join(root, "task.safe"), path.join(root, "linked"));
  assert.throws(() => allocateRunArtifacts(root, "linked", "run-3"));
});

test("FP-04/Architecture: SHALL reject recursive tools and extensions", () => {
  const spec = {
    taskId: "task", runId: "run", cwd: "/work", artifactRoot: "/artifacts", sessionDir: "/sessions", sessionId: "session",
    model: { provider: "p", id: "m", thinking: "off" }, tools: ["read", "delegate"], extensions: [], promptPath: "/p", systemPromptPath: "/s", childRuntimePath: "/r",
  };
  assert.throws(() => buildChildArgs(spec));
  assert.throws(() => buildChildArgs({ ...spec, tools: ["read"], extensions: ["fusion"] }));
});

test("FP-04/Unit: fresh launches select a model while resumed sessions keep their saved model", () => {
  const fresh = {
    taskId: "task-1", runId: "run-1", cwd: "/work", artifactRoot: "/artifacts", sessionDir: "/sessions", sessionId: "session-1",
    model: { provider: "provider", id: "model", thinking: "high" }, tools: ["read"], extensions: [],
    promptPath: "/artifacts/prompt.md", systemPromptPath: "/artifacts/system.md", childRuntimePath: "/extensions/child-runtime.ts",
  };
  const freshArgs = buildChildArgs(fresh);
  assert.deepEqual(
    freshArgs.slice(freshArgs.indexOf("--provider"), freshArgs.indexOf("--provider") + 6),
    ["--provider", "provider", "--model", "model", "--thinking", "high"],
  );
  assert.throws(
    () => buildChildArgs({ ...fresh, model: undefined }),
    /Complete model selection is required for a fresh child launch/,
  );

  const sessionFile = "/sessions/saved-session.jsonl";
  assert.throws(
    () => buildChildArgs({ ...fresh, model: undefined, requireExistingSession: true }),
    /exact saved child session file/,
  );
  const resumedArgs = buildChildArgs({ ...fresh, model: undefined, requireExistingSession: true, sessionFile });
  for (const flag of ["--provider", "--model", "--thinking"]) assert.equal(resumedArgs.includes(flag), false);
  assert.deepEqual(
    resumedArgs.slice(resumedArgs.indexOf("--session"), resumedArgs.indexOf("--session") + 2),
    ["--session", sessionFile],
  );
  assert.equal(resumedArgs.includes("--session-dir"), false);
  assert.equal(resumedArgs.includes("--session-id"), false);
});

test("FP-04/EARS: builds exact restricted CLI policy without prompt interpolation", () => {
  const args = buildChildArgs({
    taskId: "task-1", runId: "run-1", cwd: "/work", artifactRoot: "/artifacts",
    sessionDir: "/sessions with spaces", sessionId: "session-1",
    model: { provider: "provider", id: "model/metachar", thinking: "high" },
    tools: ["read", "bash", "mcp__web_search"],
    extensions: ["/extensions/mcp adapter.ts"],
    promptPath: "/artifacts/prompt;rm -rf.md", systemPromptPath: "/artifacts/system.md",
    childRuntimePath: "/extensions/child-runtime.ts",
  });
  for (const flag of ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-mcp"]) assert.ok(args.includes(flag));
  assert.deepEqual(args.slice(-2), ["--", "@/artifacts/prompt;rm -rf.md"]);
  assert.ok(!args.join(" ").includes("prompt text"));
  assert.deepEqual(args.slice(args.indexOf("--tools") + 1, args.indexOf("--tools") + 2), ["read,bash,mcp__web_search"]);
  const extensionPaths = args.flatMap((value, index) => value === "--extension" ? [args[index + 1]] : []);
  assert.deepEqual(extensionPaths, ["/extensions/mcp adapter.ts", "/extensions/child-runtime.ts"]);
});

test("FP-04/Unit: SHALL resolve configured, PATH, and package Pi runtimes", () => {
  assert.deepEqual(resolvePiExecutable({ PI_FUSION_PI: "/encoded path/pi" }), { file: "/encoded path/pi", prefix: [] });
  assert.deepEqual(resolvePiExecutable({}, { which: () => "/path with spaces/pi" }), { file: "/path with spaces/pi", prefix: [] });
  assert.deepEqual(resolvePiExecutable({}, { which: () => undefined, packageEntry: () => "/runtime/pi.js" }), { file: process.execPath, prefix: ["/runtime/pi.js"] });
});

test("FP-04/EARS: prompt is stored as a file, not a shell command", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-prompt-"));
  const file = path.join(root, "prompt.md");
  createPromptArtifact(file, "brief; $(danger)");
  assert.equal(fs.readFileSync(file, "utf8"), "brief; $(danger)");
});
