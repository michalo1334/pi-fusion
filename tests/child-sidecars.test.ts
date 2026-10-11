import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { allocateRunArtifacts, createLaunchCommand, createLaunchWrapper, pollRun, readProcessIdentity, stopOwnedChild, writeExitSidecar, writePidSidecar } from "../extensions/child-process.ts";

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const dummy = (dir: string, code: string) => { const file = path.join(dir, "dummy.mjs"); fs.writeFileSync(file, code); return file; };
const run = (args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) => new Promise<{ code: number | null; stderr: string }>((resolve, reject) => { const p = spawn(args[0], args.slice(1), { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "pipe"] }); let stderr = ""; p.stderr.on("data", b => stderr += b); p.once("error", reject); p.once("exit", code => resolve({ code, stderr })); });

test("FP-05/TTY: generated wrapper keeps the child in the foreground TTY group", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fp05-tty-"));
  const artifacts = allocateRunArtifacts(root, "task", "run");
  const oldPi = process.env.PI_FUSION_PI; process.env.PI_FUSION_PI = process.execPath;
  try {
    const wrapper = createLaunchWrapper({ taskId: "task", runId: "run", cwd: root, artifactRoot: root, sessionDir: root, sessionId: "session", model: { provider: "p", id: "m", thinking: "off" }, tools: [], extensions: [], promptPath: path.join(root, "prompt"), systemPromptPath: path.join(root, "system"), childRuntimePath: path.join(root, "runtime") }, artifacts);
    const source = fs.readFileSync(wrapper, "utf8");
    assert.match(source, /stdio: "inherit"/);
    assert.match(source, /const isolated = !process\.stdin\.isTTY && !process\.stdout\.isTTY/);
    assert.match(source, /detached: isolated/);
    assert.match(source, /SIGINT/); assert.match(source, /SIGTERM/);
    assert.match(source, /finalized/);
  } finally {
    if (oldPi === undefined) delete process.env.PI_FUSION_PI; else process.env.PI_FUSION_PI = oldPi;
  }
});

test("FP-05/TTY: PTY child keeps foreground stdin and writes one exit sidecar after Ctrl-C", { skip: (() => { try { return spawnSync("which", ["script"], { stdio: "ignore" }).status !== 0; } catch { return true; } })() }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fp05-pty-"));
  const artifacts = allocateRunArtifacts(root, "task", "run");
  const ready = path.join(root, "ready.json"); const output = path.join(root, "pty-output"); const scriptLog = path.join(root, "script.log");
  const fakePi = dummy(root, `#!/usr/bin/env node
import {writeFileSync} from 'node:fs';
writeFileSync(process.env.READY, JSON.stringify({stdinTTY: Boolean(process.stdin.isTTY)}));
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', data => { if (data.includes(3)) { writeFileSync(process.env.OUTPUT, 'ctrl-c'); process.exit(130); } });`);
  fs.chmodSync(fakePi, 0o700);
  const old = { pi: process.env.PI_FUSION_PI, ready: process.env.READY, output: process.env.OUTPUT };
  process.env.PI_FUSION_PI = fakePi; process.env.READY = ready; process.env.OUTPUT = output;
  let p: ReturnType<typeof spawn> | undefined;
  try {
    const spec = { taskId: "task", runId: "run", cwd: root, artifactRoot: root, sessionDir: root, sessionId: "session", model: { provider: "p", id: "m", thinking: "off" }, tools: [], extensions: [], promptPath: path.join(root, "prompt"), systemPromptPath: path.join(root, "system"), childRuntimePath: path.join(root, "runtime") };
    const wrapper = createLaunchWrapper(spec, artifacts);
    p = spawn("script", ["-qefc", `${process.execPath} ${wrapper}`, scriptLog], { cwd: root, env: { ...process.env, READY: ready, OUTPUT: output }, stdio: ["pipe", "ignore", "ignore"] });
    for (let attempt = 0; attempt < 100 && !fs.existsSync(ready); attempt++) await wait(5);
    assert.deepEqual(JSON.parse(fs.readFileSync(ready, "utf8")), { stdinTTY: true });
    const stdin = p.stdin; assert.ok(stdin); stdin.write(Buffer.from([3]));
    await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error("PTY child did not stop")), 1000); p?.once("exit", () => { clearTimeout(timer); resolve(); }); });
    assert.equal(fs.readFileSync(output, "utf8"), "ctrl-c");
    const lines = fs.readFileSync(artifacts.exitPath, "utf8").trim().split("\\n"); assert.equal(lines.length, 1); assert.equal(JSON.parse(lines[0]).runId, "run");
  } finally {
    if (p && p.exitCode === null) p.kill("SIGKILL");
    if (old.pi === undefined) delete process.env.PI_FUSION_PI; else process.env.PI_FUSION_PI = old.pi;
    if (old.ready === undefined) delete process.env.READY; else process.env.READY = old.ready;
    if (old.output === undefined) delete process.env.OUTPUT; else process.env.OUTPUT = old.output;
  }
});

test("FP-05/TTY: fingerprint write failure records an actionable launch error and uses the child handle", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fp05-tty-"));
  const artifacts = allocateRunArtifacts(root, "task", "run");
  const oldPi = process.env.PI_FUSION_PI; process.env.PI_FUSION_PI = process.execPath;
  try {
    const wrapper = createLaunchWrapper({ taskId: "task", runId: "run", cwd: root, artifactRoot: root, sessionDir: root, sessionId: "session", model: { provider: "p", id: "m", thinking: "off" }, tools: [], extensions: [], promptPath: path.join(root, "prompt"), systemPromptPath: path.join(root, "system"), childRuntimePath: path.join(root, "runtime") }, artifacts);
    const source = fs.readFileSync(wrapper, "utf8");
    assert.match(source, /Could not record child PID identity/);
    assert.match(source, /child\.kill\("SIGTERM"\)/);
    assert.match(source, /child\.kill\("SIGKILL"\)/);
    assert.doesNotMatch(source, /identity: identity\(child\.pid\) \}\); } catch \{\}/);
  } finally {
    if (oldPi === undefined) delete process.env.PI_FUSION_PI; else process.env.PI_FUSION_PI = oldPi;
  }
});

test("FP-05/EARS: wrapper preserves the execution pane environment", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fp05-env-"));
  const artifacts = allocateRunArtifacts(root, "task", "run");
  const fakePi = dummy(root, `#!/usr/bin/env node\nimport {writeFileSync} from 'node:fs'; writeFileSync(process.env.OUT, JSON.stringify({pane:process.env.ZELLIJ_PANE_ID, credential:process.env.FP05_CREDENTIAL, child:process.env.PI_FUSION_CHILD}));`);
  fs.chmodSync(fakePi, 0o700);
  const out = path.join(root, "env.json");
  const previous = { pi: process.env.PI_FUSION_PI, out: process.env.OUT, pane: process.env.ZELLIJ_PANE_ID, credential: process.env.FP05_CREDENTIAL };
  process.env.PI_FUSION_PI = fakePi;
  process.env.OUT = out;
  process.env.ZELLIJ_PANE_ID = "parent-pane";
  process.env.FP05_CREDENTIAL = "parent-secret";
  const spec = { taskId: "task", runId: "run", cwd: root, artifactRoot: root, sessionDir: root, sessionId: "session", model: { provider: "p", id: "m", thinking: "off" }, tools: [], extensions: [], promptPath: path.join(root, "prompt"), systemPromptPath: path.join(root, "system"), childRuntimePath: path.join(root, "runtime") };
  const wrapper = createLaunchWrapper(spec, artifacts);
  process.env.ZELLIJ_PANE_ID = "execution-pane";
  process.env.FP05_CREDENTIAL = "execution-secret";
  try {
    await run([process.execPath, wrapper], root, { OUT: out });
    await wait(30);
    assert.deepEqual(JSON.parse(fs.readFileSync(out, "utf8")), { pane: "execution-pane", credential: "execution-secret", child: "1" });
  } finally {
    if (previous.pi === undefined) delete process.env.PI_FUSION_PI; else process.env.PI_FUSION_PI = previous.pi;
    if (previous.out === undefined) delete process.env.OUT; else process.env.OUT = previous.out;
    if (previous.pane === undefined) delete process.env.ZELLIJ_PANE_ID; else process.env.ZELLIJ_PANE_ID = previous.pane;
    if (previous.credential === undefined) delete process.env.FP05_CREDENTIAL; else process.env.FP05_CREDENTIAL = previous.credential;
  }
});

test("FP-05/EARS: matching runtime-error sidecar overrides a zero child exit", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fp05-runtime-"));
  const artifacts = allocateRunArtifacts(root, "task", "run");
  const fakePi = dummy(root, `#!/usr/bin/env node\nimport {writeFileSync} from 'node:fs'; writeFileSync(process.env.PI_FUSION_RUNTIME_ERROR_PATH, JSON.stringify({runId:process.env.PI_FUSION_RUN_ID,error:'runtime policy failed'})+'\\n');`);
  fs.chmodSync(fakePi, 0o700);
  const oldPi = process.env.PI_FUSION_PI; process.env.PI_FUSION_PI = fakePi;
  try {
    const spec = { taskId: "task", runId: "run", cwd: root, artifactRoot: root, sessionDir: root, sessionId: "session", model: { provider: "p", id: "m", thinking: "off" }, tools: [], extensions: [], promptPath: path.join(root, "prompt"), systemPromptPath: path.join(root, "system"), childRuntimePath: path.join(root, "runtime") };
    const result = await run(createLaunchCommand(spec, artifacts), root);
    assert.equal(result.code, 78);
    const exit = JSON.parse(fs.readFileSync(artifacts.exitPath, "utf8"));
    assert.deepEqual(exit, { runId: "run", exitCode: 78, finishedAt: exit.finishedAt, error: "runtime policy failed", policyFailure: true });
  } finally {
    if (oldPi === undefined) delete process.env.PI_FUSION_PI; else process.env.PI_FUSION_PI = oldPi;
  }
});

test("FP-05/EARS: generated wrapper records child PID, cwd, argv, env, and rc0", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fp05-int-"));
  const artifacts = allocateRunArtifacts(root, "task", "run");
  const out = path.join(root, "out.json");
  const fakePi = dummy(root, `#!/usr/bin/env node\nimport {writeFileSync} from 'node:fs'; writeFileSync(process.env.OUT, JSON.stringify({pid:process.pid,cwd:process.cwd(),argv:process.argv.slice(2),value:process.env.FP05_VALUE}));`);
  fs.chmodSync(fakePi, 0o700);
  const oldPi = process.env.PI_FUSION_PI; const oldOut = process.env.OUT; const oldValue = process.env.FP05_VALUE;
  const newline = String.fromCharCode(10);
  const metachar = `space ' quote $ newline${newline}value`;
  process.env.PI_FUSION_PI = fakePi; process.env.OUT = out; process.env.FP05_VALUE = metachar;
  const promptPath = path.join(root, `prompt ; ' \" $${newline}.md`);
  const systemPromptPath = path.join(root, `system ; ' \" $${newline}.md`);
  try {
    const modelId = `model ' \" $${newline}`;
    const spec = { taskId: "task", runId: "run", cwd: root, artifactRoot: root, sessionDir: path.join(root, "session dir ; $"), sessionId: "session", model: { provider: "provider ; $", id: modelId, thinking: "high" }, tools: [], extensions: [], promptPath, systemPromptPath, childRuntimePath: path.join(root, "runtime ; $") };
    const result = await run(createLaunchCommand(spec, artifacts), root);
    assert.equal(result.code, 0);
    const observed = JSON.parse(fs.readFileSync(out, "utf8"));
    assert.equal(observed.cwd, root); assert.notEqual(observed.pid, process.pid); assert.equal(observed.value, metachar);
    const argv = observed.argv as string[];
    assert.ok(argv.includes("provider ; $")); assert.ok(argv.includes(modelId)); assert.ok(argv.includes(path.join(root, "session dir ; $")));
    assert.ok(argv.includes(`@${promptPath}`)); assert.ok(argv.includes(systemPromptPath));
    const pid = JSON.parse(fs.readFileSync(artifacts.pidPath, "utf8")); assert.equal(pid.pid, observed.pid); assert.equal(pid.identity.platform, "linux"); assert.match(pid.identity.startTime, /^\d+$/);
  } finally {
    if (oldPi === undefined) delete process.env.PI_FUSION_PI; else process.env.PI_FUSION_PI = oldPi;
    if (oldOut === undefined) delete process.env.OUT; else process.env.OUT = oldOut;
    if (oldValue === undefined) delete process.env.FP05_VALUE; else process.env.FP05_VALUE = oldValue;
  }
});

test("FP-05/EARS: generated wrapper records nonzero and spawn errors", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fp05-int-"));
  const nonzero = allocateRunArtifacts(root, "task", "nonzero");
  const fakePi = dummy(root, `#!/usr/bin/env node\nprocess.exit(7)`); fs.chmodSync(fakePi, 0o700);
  const oldPi = process.env.PI_FUSION_PI; process.env.PI_FUSION_PI = fakePi;
  const base = { taskId: "task", cwd: root, artifactRoot: root, sessionDir: root, sessionId: "session", model: { provider: "p", id: "m", thinking: "off" }, tools: [], extensions: [], promptPath: path.join(root, "prompt"), systemPromptPath: path.join(root, "system"), childRuntimePath: path.join(root, "runtime") };
  try {
    assert.equal((await run(createLaunchCommand({ ...base, runId: "nonzero" }, nonzero), root)).code, 7);
    assert.equal(JSON.parse(fs.readFileSync(nonzero.exitPath, "utf8")).exitCode, 7);
    const missing = allocateRunArtifacts(root, "task", "missing"); process.env.PI_FUSION_PI = path.join(root, "missing-pi");
    assert.equal((await run(createLaunchCommand({ ...base, runId: "missing" }, missing), root)).code, 1);
    const record = JSON.parse(fs.readFileSync(missing.exitPath, "utf8")); assert.equal(record.exitCode, null); assert.match(record.error, /ENOENT/);
  } finally {
    if (oldPi === undefined) delete process.env.PI_FUSION_PI; else process.env.PI_FUSION_PI = oldPi;
  }
});

test("FP-05/EARS: polling reports confirmed child disappearance after flush grace", async () => {
  const result = await pollRun({ pidPath: "/not-used", exitPath: "/not-used", runId: "run", probeChild: async () => "gone", flushGraceMs: 0, queryIntervalMs: 1 });
  assert.deepEqual(result, { kind: "process-gone", reason: "gone", message: "Child disappeared without a matching exit sidecar" });
});

test("FP-05/Integration: resistant local child is bounded and cleaned", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fp05-real-stop-"));
  const artifacts = allocateRunArtifacts(root, "task", "run");
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { cwd: root, stdio: "ignore" });
  assert.ok(child.pid);
  let identity;
  for (let attempt = 0; attempt < 20; attempt++) { try { identity = readProcessIdentity(child.pid); break; } catch { await wait(2); } }
  assert.ok(identity);
  writePidSidecar(artifacts.pidPath, "run", child.pid, identity);
  try {
    await stopOwnedChild({ pidPath: artifacts.pidPath, runId: "run", interrupt: async () => undefined, graceMs: 5, termGraceMs: 5, killGraceMs: 250 });
    if (child.exitCode === null && child.signalCode === null) await new Promise<void>(resolve => child.once("exit", () => resolve()));
    assert.throws(() => process.kill(child.pid!, 0));
  } finally {
    try { process.kill(child.pid!, "SIGKILL"); } catch { /* already gone */ }
  }
});

test("FP-05/EARS: stop uses graceful interrupt, then bounded TERM and KILL with ownership checks", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fp05-stop-"));
  const artifacts = allocateRunArtifacts(root, "task", "run");
  const identity = { platform: "linux" as const, pid: 4242, startTime: "99", state: "R" };
  writePidSidecar(artifacts.pidPath, "run", 4242, identity);
  let alive = true; const signals: Array<[number, string]> = [];
  await stopOwnedChild({ pidPath: artifacts.pidPath, runId: "run", interrupt: async () => undefined, graceMs: 0, termGraceMs: 0, killGraceMs: 5,
    readIdentity: () => ({ ...identity, state: alive ? "R" : "Z" }),
    sendSignal: (target, signal) => { signals.push([target, signal]); if (signal === "SIGKILL") alive = false; },
    sleep: async () => undefined });
  assert.deepEqual(signals, [[4242, "SIGTERM"], [4242, "SIGKILL"]]);
});

test("FP-05/EARS: stop refuses missing or reused PID fingerprints and sends no unrelated signal", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fp05-stop-"));
  const artifacts = allocateRunArtifacts(root, "task", "run");
  fs.writeFileSync(artifacts.pidPath, JSON.stringify({ runId: "run", pid: 4242 }));
  await assert.rejects(stopOwnedChild({ pidPath: artifacts.pidPath, runId: "run", interrupt: async () => undefined }), /identity fingerprint/);
  const reused = allocateRunArtifacts(root, "task", "reused");
  const identity = { platform: "linux" as const, pid: 4242, startTime: "99", state: "R" };
  writePidSidecar(reused.pidPath, "reused", 4242, identity);
  let reads = 0; const signals: string[] = [];
  await assert.rejects(stopOwnedChild({ pidPath: reused.pidPath, runId: "reused", interrupt: async () => undefined,
    readIdentity: () => { reads++; return reads === 1 ? identity : { ...identity, startTime: "100" }; }, sendSignal: (_target, signal) => signals.push(signal), graceMs: 0 }), /identity fingerprint changed/);
  assert.deepEqual(signals, []);
});

test("FP-05/EARS: interrupt errors remain actionable after forced cleanup", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fp05-stop-")); const artifacts = allocateRunArtifacts(root, "task", "run");
  const identity = { platform: "linux" as const, pid: 4242, startTime: "99", state: "R" }; writePidSidecar(artifacts.pidPath, "run", 4242, identity);
  let alive = true;
  await assert.rejects(stopOwnedChild({ pidPath: artifacts.pidPath, runId: "run", interrupt: async () => { throw new Error("pane interrupt failed"); }, graceMs: 0, termGraceMs: 0,
    readIdentity: () => ({ ...identity, state: alive ? "R" : "Z" }), sendSignal: (_target, signal) => { if (signal === "SIGTERM") alive = false; }, sleep: async () => undefined }), /pane interrupt failed/);
});

test("FP-05/EARS: polling handles completion, stale record, abort, timeout, pane loss, query error, and process loss", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fp05-poll-")); const a = allocateRunArtifacts(root, "task", "run"); writeExitSidecar(a.exitPath, { runId: "stale", exitCode: 0, finishedAt: new Date().toISOString() });
  const controller = new AbortController(); const aborted = pollRun({ ...a, runId: "run", signal: controller.signal, queryIntervalMs: 2 }); controller.abort(); assert.equal((await aborted).kind, "aborted");
  assert.equal((await pollRun({ ...a, runId: "run", timeoutMs: 5, queryIntervalMs: 1 })).kind, "timeout");
  assert.equal((await pollRun({ ...a, runId: "run", isPaneAlive: async () => false })).kind, "pane-lost");
  assert.equal((await pollRun({ ...a, runId: "run", isPaneAlive: async () => { throw new Error("query"); } })).kind, "query-error");
  assert.equal((await pollRun({ ...a, runId: "run", isPaneAlive: async () => true, timeoutMs: 5 })).kind, "timeout");
});
