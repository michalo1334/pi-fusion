import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager, initTheme } from "@earendil-works/pi-coding-agent";
initTheme("dark");
import { createFusionExtension, type FusionRuntimeDependencies } from "../extensions/fusion.ts";
import type { ChildRunResult } from "../extensions/child-runner.ts";

function makeHarness(options: { run?: (input: any) => Promise<ChildRunResult>; root?: string; check?: FusionRuntimeDependencies["checkZellij"]; ui?: any; hasUI?: boolean; mode?: string; models?: Array<{ provider: string; id: string }> } = {}) {
  const root = options.root ?? fs.mkdtempSync(path.join(os.tmpdir(), "fp08-fusion-"));
  fs.mkdirSync(path.join(root, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(root, ".pi", "settings.json"), JSON.stringify({ fusion: {
    sidekickModel: "offline/fixture:high", timeoutMinutes: 1, sidekickTools: ["read"], sidekickExtensions: [],
  } }));
  const tools = new Map<string, any>();
  const events = new Map<string, (event: any, ctx?: any) => Promise<unknown> | unknown>();
  const commands = new Map<string, any>();
  const pi = {
    registerCommand: (name: string, command: any) => { commands.set(name, command); },
    registerTool: (tool: any) => { tools.set(tool.name, tool); },
    on: (name: string, handler: (event: any, ctx?: any) => Promise<unknown> | unknown) => { events.set(name, handler); return () => events.delete(name); },
  } as any;
  const models = options.models ?? [{ provider: "offline", id: "fixture" }];
  const sessionDir = path.join(root, "sessions");
  fs.mkdirSync(sessionDir, { recursive: true });
  const leadManager = SessionManager.create(root, sessionDir, { id: "lead-session" });
  const leadFile = leadManager.getSessionFile()!;
  fs.writeFileSync(leadFile, `${JSON.stringify(leadManager.getHeader())}\n`, { mode: 0o600 });
  const context = {
    cwd: root,
    hasUI: options.hasUI ?? false,
    mode: options.mode ?? "tui",
    ui: options.ui ?? { notify: () => {} },
    model: models[0],
    scopedModels: [],
    modelRegistry: {
      find: (provider: string, id: string) => models.find(model => model.provider === provider && model.id === id),
      getAvailable: () => models,
      getError: () => undefined,
      refresh: async () => ({ aborted: false, errors: new Map() }),
    },
    sessionManager: { getSessionDir: () => sessionDir, getSessionId: () => "lead-session", getSessionFile: () => leadFile },
  } as any;
  const dependencies: FusionRuntimeDependencies = {
    runChildTask: options.run,
    checkZellij: options.check ?? (async () => ({ available: true, setupHint: "" })),
    resolveParentPaneId: () => "terminal_1",
  };
  createFusionExtension(pi, dependencies);
  return { root, tools, events, commands, context };
}

function result(input: any, status: ChildRunResult["status"] = "ok", valid = true): ChildRunResult {
  return {
    taskId: input.taskId, runId: input.runId, status, report: `report-${input.runId}`, costUsd: 0.25,
    sessionFile: input.sessionFile ?? path.join(input.sessionDir, `${input.sessionId}.jsonl`), sessionDir: input.sessionDir,
    cursor: valid ? { byteOffset: 10, sessionId: input.sessionId } : undefined,
    artifacts: {} as any, taskValid: valid,
  };
}

const call = (tool: any, params: any, context: any, signal = new AbortController().signal, onUpdate?: (update: any) => void) =>
  tool.execute("call", params, signal, onUpdate, context);

function commandHarness(options: { custom?: (factory: any) => Promise<string | undefined>; select?: (...args: any[]) => Promise<string | undefined>; notify?: (...args: any[]) => void; mode?: string } = {}) {
  const notifications: any[] = [];
  const selectors: any[] = [];
  const harness = makeHarness({ hasUI: true, mode: options.mode, ui: {
    custom: async (factory: any) => {
      selectors.push(factory);
      if (options.custom) return options.custom(factory);
      return undefined;
    },
    select: async (...args: any[]) => options.select ? options.select(...args) : undefined,
    notify: (...args: any[]) => { notifications.push(args); options.notify?.(...args); },
  } });
  return { ...harness, selectors, notifications, command: harness.commands.get("fusion-model") };
}

test("FUSION-CMD-01: registers fusion-model", () => {
  assert.ok(commandHarness().command);
});

test("FUSION-CMD-02: persists complete argument", async () => {
  const h = commandHarness();
  await h.command.handler("offline/fixture:medium", h.context);
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.root, ".pi/settings.json"), "utf8")).fusion.sidekickModel, "offline/fixture:medium");
});

test("FUSION-CMD-02b: complete replacement repairs malformed saved thinking", async () => {
  const h = commandHarness();
  const settings = path.join(h.root, ".pi", "settings.json");
  const parsed = JSON.parse(fs.readFileSync(settings, "utf8"));
  parsed.fusion.sidekickModel = "offline/fixture:invalid";
  fs.writeFileSync(settings, JSON.stringify(parsed));
  await h.command.handler("offline/fixture:medium", h.context);
  assert.equal(JSON.parse(fs.readFileSync(settings, "utf8")).fusion.sidekickModel, "offline/fixture:medium");
});

test("FUSION-CMD-03: prompts for thinking when model is partial", async () => {
  let calls = 0;
  let title = "";
  const h = commandHarness({ select: async (prompt: string) => { calls++; title = prompt; return "high"; } });
  await h.command.handler("offline/fixture", h.context);
  assert.equal(calls, 1);
  assert.match(title, /thinking/i);
  assert.match(JSON.parse(fs.readFileSync(path.join(h.root, ".pi/settings.json"), "utf8")).fusion.sidekickModel, /:high$/);
});

test("FUSION-CMD-04: non-TUI no-argument command requires an explicit model", async () => {
  const h = commandHarness({ mode: "rpc", custom: async () => { throw new Error("custom must not run"); } });
  const before = fs.readFileSync(path.join(h.root, ".pi/settings.json"), "utf8");
  await h.command.handler("", h.context);
  assert.match(h.notifications.at(-1)?.[0] ?? "", /TUI|provider\/model/i);
  assert.equal(fs.readFileSync(path.join(h.root, ".pi/settings.json"), "utf8"), before);
});

test("FUSION-CMD-04a: production command uses Pi selector runtime, scope, and public selection input", async () => {
  const calls = { available: 0, find: 0, error: 0, refresh: 0, refreshSignal: false };
  const h = commandHarness({ custom: async (factory) => {
    let doneValue: unknown;
    const component = factory({ requestRender() {} }, {}, {}, (value: unknown) => { doneValue = value; });
    assert.equal(component.constructor.name, "ModelSelectorComponent");
    assert.equal((component as any).currentModel.provider, "offline");
    assert.deepEqual(h.context.scopedModels, (component as any).scopedModels);
    await new Promise<void>((resolve) => setImmediate(resolve));
    component.handleInput("\r");
    assert.equal(doneValue, "offline/fixture");
    return doneValue as string;
  }, select: async () => "low" });
  const model = h.context.model;
  h.context.scopedModels = [{ model }];
  h.context.modelRegistry = {
    getAvailable: () => { calls.available++; return [model]; },
    find: (provider: string, id: string) => { calls.find++; return provider === model.provider && id === model.id ? model : undefined; },
    getError: () => { calls.error++; return undefined; },
    refresh: async (options?: { signal?: AbortSignal }) => {
      calls.refresh++;
      calls.refreshSignal = options?.signal instanceof AbortSignal;
      return { aborted: false, errors: new Map() };
    },
  };
  await h.command.handler("", h.context);
  assert.ok(calls.available >= 2);
  assert.ok(calls.find >= 2);
  assert.equal(calls.error, 1);
  assert.equal(calls.refresh, 1);
  assert.equal(calls.refreshSignal, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.root, ".pi/settings.json"), "utf8")).fusion.sidekickModel, "offline/fixture:low");
});

test("FUSION-CMD-05: Pi model selector cancellation does not write", async () => {
  const h = commandHarness({ custom: async (factory) => {
    let doneCalled = false;
    let doneValue: unknown = "not-called";
    const component = factory({ requestRender() {} }, {}, {}, (value: unknown) => { doneCalled = true; doneValue = value; });
    component.handleInput("\u001b");
    assert.equal(doneCalled, true);
    assert.equal(doneValue, undefined);
    return doneValue as undefined;
  } });
  const before = fs.readFileSync(path.join(h.root, ".pi/settings.json"), "utf8");
  await h.command.handler("", h.context);
  assert.equal(fs.readFileSync(path.join(h.root, ".pi/settings.json"), "utf8"), before);
});

test("FUSION-CMD-05a: thinking cancellation does not write", async () => {
  const h = commandHarness({ custom: async () => "offline/fixture", select: async () => undefined });
  const before = fs.readFileSync(path.join(h.root, ".pi/settings.json"), "utf8");
  await h.command.handler("", h.context);
  assert.equal(fs.readFileSync(path.join(h.root, ".pi/settings.json"), "utf8"), before);
});

test("FUSION-CMD-05b: selector reports malformed saved model without writing", async () => {
  const h = commandHarness();
  const settings = path.join(h.root, ".pi", "settings.json");
  const parsed = JSON.parse(fs.readFileSync(settings, "utf8"));
  parsed.fusion.sidekickModel = "offline/fixture:invalid";
  fs.writeFileSync(settings, JSON.stringify(parsed));
  const before = fs.readFileSync(settings, "utf8");
  await h.command.handler("", h.context);
  assert.match(h.notifications.at(-1)?.[0] ?? "", /invalid|repair|complete/i);
  assert.equal(fs.readFileSync(settings, "utf8"), before);
});

test("FUSION-CMD-06: invalid input does not write", async () => {
  const h = commandHarness();
  const before = fs.readFileSync(path.join(h.root, ".pi/settings.json"), "utf8");
  await h.command.handler("not-a-model", h.context);
  assert.equal(fs.readFileSync(path.join(h.root, ".pi/settings.json"), "utf8"), before);
});

test("FUSION-CMD-07: persistence failure leaves runtime override unchanged", async () => {
  const h = commandHarness();
  await h.command.handler("offline/fixture:low", h.context);
  fs.chmodSync(path.join(h.root, ".pi"), 0o500);
  try {
    await h.command.handler("offline/fixture:high", h.context);
    assert.match(h.notifications.at(-1)?.[0] ?? "", /persist/i);
  } finally { fs.chmodSync(path.join(h.root, ".pi"), 0o700); }
  h.context.hasUI = false;
  await h.command.handler("", h.context);
  assert.equal(h.notifications.at(-1)?.[0], "sidekick model: offline/fixture:low");
});

 test("FP-08/Unit: WHEN a task ID is unknown or its cursor is invalid, THE extension SHALL reject unsafe follow-up", async () => {
  const harness = makeHarness({ run: async input => result(input) });
  const follow = harness.tools.get("follow_up");
  await assert.rejects(() => call(follow, { task_id: "missing", message: "x" }, harness.context), /Unknown task_id/);
  const delegate = harness.tools.get("delegate");
  const first = await call(delegate, { brief: "brief" }, harness.context);
  // A second extension instance provides a deterministic invalid-record seam.
  const invalid = makeHarness({ run: async input => result(input, "error", false) });
  const failed = await call(invalid.tools.get("delegate"), { brief: "brief" }, invalid.context);
  await assert.rejects(() => call(invalid.tools.get("follow_up"), { task_id: failed.details.taskId, message: "retry" }, invalid.context), /missing or invalid/);
  assert.match(first.details.taskId, /^[0-9a-f-]+$/);
 });

test("LINEAGE-04 Unit: IF the lead session is ephemeral, THEN delegate SHALL reject before child allocation", async () => {
  let launched = false;
  const harness = makeHarness({ run: async input => { launched = true; return result(input); } });
  harness.context.sessionManager = {
    getSessionDir: () => path.join(harness.root, "sessions"),
    getSessionId: () => "lead-session",
    getSessionFile: () => undefined,
  };
  await assert.rejects(() => call(harness.tools.get("delegate"), { brief: "no fabricated parent" }, harness.context), /no persisted session file/);
  assert.equal(launched, false);
});

test("LINEAGE-07 Unit: IF delegate starts with an aborted signal, THEN it SHALL create no child session, task artifacts, or runner call", async () => {
  let detectionCalls = 0;
  let runnerCalls = 0;
  const harness = makeHarness({
    check: async () => { detectionCalls += 1; return { available: true, setupHint: "" }; },
    run: async input => { runnerCalls += 1; return result(input); },
  });
  const sessionDir = path.join(harness.root, "sessions");
  const before = fs.readdirSync(sessionDir);
  const signal = new AbortController();
  signal.abort();
  await assert.rejects(() => call(harness.tools.get("delegate"), { brief: "cancel before allocation" }, harness.context, signal.signal), /cancelled before allocation/);
  assert.equal(detectionCalls, 0);
  assert.equal(runnerCalls, 0);
  assert.deepEqual(fs.readdirSync(sessionDir), before);
  assert.equal(fs.existsSync(path.join(sessionDir, "artifacts")), false);
});

test("LINEAGE-08 Unit: WHEN delegate is aborted during Zellij detection, THEN it SHALL seed no child session or task artifacts", async () => {
  let releaseDetection!: () => void;
  let runnerCalls = 0;
  const detection = new Promise<void>(resolve => { releaseDetection = resolve; });
  const harness = makeHarness({
    check: async () => { await detection; return { available: true, setupHint: "" }; },
    run: async input => { runnerCalls += 1; return result(input); },
  });
  const sessionDir = path.join(harness.root, "sessions");
  const before = fs.readdirSync(sessionDir);
  const controller = new AbortController();
  const pending = call(harness.tools.get("delegate"), { brief: "cancel during detection" }, harness.context, controller.signal);
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  releaseDetection();
  await assert.rejects(() => pending, /cancelled before allocation/);
  assert.equal(runnerCalls, 0);
  assert.deepEqual(fs.readdirSync(sessionDir), before);
  assert.equal(fs.existsSync(path.join(sessionDir, "artifacts")), false);
});

test("CWD-01/Integration: WHEN the parent context cwd differs from process.cwd(), THE delegate and follow-up SHALL pass that cwd to each launch while reusing one session directory", async () => {
  const parentCwd = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-parent-cwd-"));
  assert.notEqual(parentCwd, process.cwd());
  const launches: any[] = [];
  const harness = makeHarness({
    root: parentCwd,
    run: async input => {
      launches.push({
        cwd: input.cwd,
        sessionDir: input.sessionDir,
        sessionId: input.sessionId,
        sessionFile: input.sessionFile,
        requireExistingSession: input.requireExistingSession,
        hasModel: "model" in input,
      });
      return result(input);
    },
  });

  const first = await call(harness.tools.get("delegate"), { brief: "start in the parent project" }, harness.context);
  await call(harness.tools.get("follow_up"), { task_id: first.details.taskId, message: "continue in the parent project" }, harness.context);

  assert.equal(launches.length, 2);
  assert.equal(launches[0].cwd, parentCwd);
  assert.equal(launches[1].cwd, parentCwd);
  assert.equal(launches[1].sessionDir, launches[0].sessionDir);
  assert.equal(launches[1].sessionId, launches[0].sessionId);
  assert.equal(launches[1].sessionFile, launches[0].sessionFile);
  assert.equal(launches[0].hasModel, true);
  assert.equal(launches[1].hasModel, false);
  assert.equal(launches[1].requireExistingSession, true);
});

test("FP-08/Unit: WHILE a task run is active, THE extension SHALL reject same-task follow-up and allow a separate delegate", async () => {
  const calls: any[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const harness = makeHarness({ run: async input => { calls.push(input); await gate; return result(input); } });
  const delegate = harness.tools.get("delegate");
  const firstPromise = call(delegate, { brief: "first" }, harness.context);
  while (calls.length < 1) await new Promise(resolve => setImmediate(resolve));
  const firstId = calls[0].taskId;
  await assert.rejects(() => call(harness.tools.get("follow_up"), { task_id: firstId, message: "busy" }, harness.context), /busy/);
  const secondPromise = call(delegate, { brief: "second" }, harness.context);
  while (calls.length < 2) await new Promise(resolve => setImmediate(resolve));
  assert.notEqual(calls[0].taskId, calls[1].taskId);
  release();
  await Promise.all([firstPromise, secondPromise]);
});

test("FP-08/Unit: WHEN a run incurs cost, THE extension SHALL roll it forward once to the next lead assistant message", async () => {
  const harness = makeHarness({ run: async input => result(input) });
  await call(harness.tools.get("delegate"), { brief: "bill once" }, harness.context);
  const messageEnd = harness.events.get("message_end")!;
  const first = await messageEnd({ message: { role: "assistant", content: "lead", usage: { cost: { total: 1 } } } });
  assert.equal((first as any).message.usage.cost.total, 1.25);
  assert.equal(await messageEnd({ message: { role: "assistant", content: "next", usage: { cost: { total: 2 } } } }), undefined);
});

test("FP-08/Integration: WHEN shutdown resolves a canceled child after disposal, THE ledger SHALL preserve cost once for the same parent session", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fp08-ledger-"));
  const first = makeHarness({ root, run: async input => {
    await new Promise<void>(resolve => input.signal.addEventListener("abort", () => resolve(), { once: true }));
    return result(input, "aborted");
  } });
  let updates = 0;
  const pending = call(first.tools.get("delegate"), { brief: "cancel" }, first.context, undefined, () => { updates += 1; });
  await new Promise(resolve => setImmediate(resolve));
  await first.events.get("session_shutdown")!({}, {});
  const canceled = await pending;
  assert.equal(canceled.details.status, "aborted");
  assert.equal(updates, 1);
  const second = makeHarness({ root, run: async input => result(input) });
  await second.events.get("session_start")!({}, second.context);
  const folded = await second.events.get("message_end")!({ message: { role: "assistant", usage: { cost: { total: 1 } } } });
  assert.equal((folded as any).message.usage.cost.total, 1.25);
  assert.equal(await second.events.get("message_end")!({ message: { role: "assistant", usage: { cost: { total: 2 } } } }), undefined);
  const other = makeHarness({ run: async input => result(input) });
  await other.events.get("session_start")!({}, other.context);
  assert.equal(await other.events.get("message_end")!({ message: { role: "assistant", usage: { cost: { total: 2 } } } }), undefined);
});

test("FP-08/Integration: WHEN reload resolves an old active child, THE same parent ledger SHALL retain its cost without stale UI updates", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fp08-reload-cost-"));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let updates = 0;
  const first = makeHarness({ root, run: async input => { await gate; return result(input); } });
  const pending = call(first.tools.get("delegate"), { brief: "reload" }, first.context, undefined, () => { updates += 1; });
  await new Promise(resolve => setImmediate(resolve));
  const second = makeHarness({ root, run: async input => result(input) });
  release();
  await pending;
  await second.events.get("session_start")!({}, second.context);
  const folded = await second.events.get("message_end")!({ message: { role: "assistant", usage: { cost: { total: 1 } } } });
  assert.equal((folded as any).message.usage.cost.total, 1.25);
  assert.equal(updates, 1);
});

test("FP-08/Integration: WHEN reload occurs during detection, THE stale module SHALL not allocate or launch a child", async () => {
  let resolveDetection!: () => void;
  let calls = 0;
  const detection = new Promise<void>(resolve => { resolveDetection = resolve; });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fp08-reload-"));
  const first = makeHarness({
    root,
    check: async () => { await detection; return { available: true, setupHint: "" }; },
    run: async input => { calls += 1; return result(input); },
  });
  const original = first.tools.get("delegate");
  const pending = call(original, { brief: "late" }, first.context);
  await new Promise(resolve => setImmediate(resolve));
  makeHarness({ root, run: async input => { calls += 1; return result(input); } });
  resolveDetection();
  await assert.rejects(() => pending, /lifecycle changed/);
  assert.equal(calls, 0);
});

test("FP-08/Unit: WHEN the injected child runner throws synchronously, THE active promise SHALL settle and repeated shutdown SHALL return", async () => {
  const harness = makeHarness({ run: (() => { throw new Error("sync launch failure"); }) as any });
  await assert.rejects(() => call(harness.tools.get("delegate"), { brief: "fail" }, harness.context), /sync launch failure/);
  await harness.events.get("session_shutdown")!({}, {});
  await harness.events.get("session_shutdown")!({}, {});
});

test("FP-08/Integration: WHEN cleanup fails, THE active control SHALL remain for a later bounded retry", async () => {
  let retries = 0;
  const harness = makeHarness({ run: async input => ({
    ...result(input, "aborted"),
    cleanupPending: true,
    retryCleanup: async () => {
      retries += 1;
      return retries === 1 ? { pending: true, errorMessage: "termination denied" } : { pending: false };
    },
  }) });
  const started = await call(harness.tools.get("delegate"), { brief: "retain control" }, harness.context);
  await assert.rejects(() => call(harness.tools.get("follow_up"), { task_id: started.details.taskId, message: "x" }, harness.context), /unresolved child cleanup/);
  await harness.events.get("session_shutdown")!({}, {});
  await harness.events.get("session_shutdown")!({}, {});
  assert.equal(retries, 2);
});

test("FP-08/Integration: WHEN the parent shuts down, THE extension SHALL abort active children once and clear task IDs", async () => {
  let aborted = 0;
  const harness = makeHarness({ run: async input => {
    await new Promise<void>(resolve => {
      if (input.signal.aborted) { aborted += 1; resolve(); return; }
      input.signal.addEventListener("abort", () => { aborted += 1; resolve(); }, { once: true });
    });
    return result(input, "aborted");
  } });
  const delegatePromise = call(harness.tools.get("delegate"), { brief: "long" }, harness.context);
  await new Promise(resolve => setImmediate(resolve));
  const shutdown = harness.events.get("session_shutdown")!;
  await shutdown({}, {});
  const completed = await delegatePromise;
  assert.equal(completed.details.status, "aborted");
  assert.equal(aborted, 1);
  await assert.rejects(() => call(harness.tools.get("follow_up"), { task_id: completed.details.taskId, message: "late" }, harness.context), /Unknown task_id/);
});
