import test from "node:test";
import assert from "node:assert/strict";
import { ZellijController, type CommandExecutor } from "../extensions/zellij.ts";

function harness(responses: Array<unknown>): { calls: string[][]; options: Array<unknown>; execute: CommandExecutor } {
  const calls: string[][] = [];
  const options: Array<unknown> = [];
  const execute: CommandExecutor = async (_file, args, optionsArg) => {
    calls.push([...args]);
    options.push(optionsArg);
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return (response ?? { stdout: "terminal_9", stderr: "" }) as { stdout: string; stderr: string };
  };
  return { calls, options, execute };
}

const panes = (ids: number[], tabId = 3, geometry = { pane_rows: 40, pane_columns: 120 }) => ({
  stdout: JSON.stringify(ids.map(id => ({ id, is_plugin: false, is_focused: id === 1, exited: false, tab_id: tabId, ...geometry }))), stderr: "",
});
const tab = (tabId: number, ids: number[], plugins: number[] = []) => ({
  stdout: JSON.stringify([
    ...ids.map(id => ({ id, is_plugin: false, is_focused: false, exited: false, tab_id: tabId, pane_rows: 40, pane_columns: 120 })),
    ...plugins.map(id => ({ id, is_plugin: true, is_focused: false, exited: false, tab_id: tabId })),
  ]), stderr: "",
});

 test("FP-03 Unit: WHEN a split is created, THEN parent and child operations use explicit terminal IDs", async () => {
  const h = harness([panes([1]), { stdout: "terminal_9", stderr: "" }, { stdout: "", stderr: "" }]);
  const surface = await new ZellijController(h.execute).createSurface({
    parentPaneId: "terminal_1", placement: { kind: "split", direction: "right" }, command: ["pi"],
  });
  assert.deepEqual(surface, { paneId: "terminal_9", parentPaneId: "terminal_1" });
  assert.deepEqual(h.calls, [
    ["action", "list-panes", "--json", "--all"],
    ["action", "new-pane", "--no-focus", "--near-current-pane", "--direction", "right", "--", "pi"],
    ["action", "focus-pane-id", "terminal_1"],
  ]);
  const createOptions = h.options[1] as { env: NodeJS.ProcessEnv };
  assert.equal(createOptions.env.ZELLIJ_PANE_ID, "1");
  assert.notEqual(createOptions.env, process.env);
});

test("FP-03 Unit: WHEN the user focus changes, THEN creation does not use focus to identify the child", async () => {
  const h = harness([panes([1, 2], 3), { stdout: "7", stderr: "" }, tab(7, [7], [0]), { stdout: "", stderr: "" }]);
  const surface = await new ZellijController(h.execute).createSurface({
    parentPaneId: "terminal_1", placement: { kind: "tab" }, command: ["pi", "--mode"],
  });
  assert.equal(surface.paneId, "terminal_7");
  assert.deepEqual(h.calls[1], ["action", "new-tab", "--no-focus", "--", "pi", "--mode"]);
  assert.equal(h.options[1], undefined);
});

test("FP-03 Unit: WHEN split creation fails, THEN controller falls back to stacked and then tab", async () => {
  const h = harness([
    panes([1]), new Error("split unavailable"), new Error("stack unavailable"),
    { stdout: "9", stderr: "" }, tab(9, [8], [0]), { stdout: "", stderr: "" }, { stdout: "", stderr: "" },
  ]);
  const surface = await new ZellijController(h.execute).createSurface({
    parentPaneId: "terminal_1", placement: { kind: "split", direction: "down" }, command: ["pi"],
  });
  assert.equal(surface.paneId, "terminal_8");
  assert.deepEqual(h.calls.slice(1, 4), [
    ["action", "new-pane", "--no-focus", "--near-current-pane", "--direction", "down", "--", "pi"],
    ["action", "new-pane", "--no-focus", "--near-current-pane", "--direction", "right", "--stacked", "--", "pi"],
    ["action", "new-tab", "--no-focus", "--", "pi"],
  ]);
});

test("FP-03 Unit: WHEN tab discovery finds two unrelated panes, THEN creation fails safely", async () => {
  const h = harness([panes([1]), { stdout: "7", stderr: "" }, tab(7, [7, 8], [0]), { stdout: "", stderr: "" }]);
  await assert.rejects(() => new ZellijController(h.execute).createSurface({
    parentPaneId: "terminal_1", placement: { kind: "tab" }, command: ["pi"],
  }), /ambiguous|identity/);
});

test("FP-03 Unit: WHEN creation fails, THEN focus restoration is attempted", async () => {
  const h = harness([panes([1]), new Error("create failed"), new Error("restore failed")]);
  await assert.rejects(() => new ZellijController(h.execute).createSurface({
    parentPaneId: "terminal_1", placement: { kind: "tab" },
  }), /focus restoration failed/);
  assert.deepEqual(h.calls.at(-1), ["action", "focus-pane-id", "terminal_1"]);
});

test("FP-07/Unit: WHEN focus restore fails after a terminal is created, SHALL preserve its trusted surface identity", async () => {
  const h = harness([panes([1]), { stdout: "terminal_9", stderr: "" }, new Error("focus failed"), new Error("restore failed")]);
  await assert.rejects(() => new ZellijController(h.execute).createSurface({
    parentPaneId: "terminal_1", placement: { kind: "split", direction: "right" },
  }), (error: unknown) => {
    const value = error as { partial?: { surface?: { paneId: string } } };
    assert.equal(value.partial?.surface?.paneId, "terminal_9");
    return true;
  });
});

test("FP-03 Unit: WHEN sending a script, THEN its quoted path is targeted explicitly", async () => {
  const h = harness([]);
  await new ZellijController(h.execute).sendCommand({ paneId: "terminal_4", parentPaneId: "terminal_1" }, "/tmp/a file's.sh");
  assert.deepEqual(h.calls, [
    ["action", "write-chars", "--pane-id", "terminal_4", "'/tmp/a file'\\''s.sh'"],
    ["action", "write", "--pane-id", "terminal_4", "13"],
  ]);
});

test("FP-03 Unit: WHEN IDs are invalid, THEN no command is sent", async () => {
  const h = harness([]);
  await assert.rejects(() => new ZellijController(h.execute).sendCommand({ paneId: "plugin_4", parentPaneId: "terminal_1" }, "/tmp/x"), /Invalid terminal/);
  assert.equal(h.calls.length, 0);
});

test("FP-16 Unit: WHEN a plugin and terminal share an ID, THEN only the terminal is live", async () => {
  const h = harness([{
    stdout: JSON.stringify([
      { id: 4, is_plugin: true, is_focused: false, exited: false, tab_id: 3 },
      { id: 4, is_plugin: false, is_focused: false, exited: false, tab_id: 3 },
    ]), stderr: "",
  }]);
  const controller = new ZellijController(h.execute);
  assert.equal(await controller.paneExists({ paneId: "terminal_4", parentPaneId: "terminal_1" }), true);

  const gone = harness([{
    stdout: JSON.stringify([{ id: 4, is_plugin: true, is_focused: false, exited: false, tab_id: 3 }]), stderr: "",
  }]);
  const goneController = new ZellijController(gone.execute);
  assert.equal(await goneController.paneExists({ paneId: "terminal_4", parentPaneId: "terminal_1" }), false);
});

test("FP-16 Unit: WHEN only a plugin existed before creation, SHALL discover the new terminal", async () => {
  const h = harness([
    {
      stdout: JSON.stringify([
        { id: 1, is_plugin: false, is_focused: true, exited: false, tab_id: 3, pane_rows: 40, pane_columns: 120 },
        { id: 4, is_plugin: true, is_focused: false, exited: false, tab_id: 3 },
      ]), stderr: "",
    },
    { stdout: "7", stderr: "" },
    tab(7, [4], [4]),
    { stdout: "", stderr: "" },
  ]);
  const surface = await new ZellijController(h.execute).createSurface({
    parentPaneId: "terminal_1", placement: { kind: "tab" }, command: ["pi"],
  });
  assert.equal(surface.paneId, "terminal_4");
});

test("FP-03 Unit: WHEN pane query fails, THEN the error is preserved", async () => {
  const h = harness([new Error("query failed")]);
  await assert.rejects(() => new ZellijController(h.execute).paneExists({ paneId: "terminal_4", parentPaneId: "terminal_1" }), /query failed/);
});

test("FP-16 Unit: WHEN close or interrupt finds only a colliding plugin, SHALL remain idempotent", async () => {
  const pluginOnly = {
    stdout: JSON.stringify([{ id: 4, is_plugin: true, is_focused: false, exited: false, tab_id: 3 }]),
    stderr: "",
  };
  const h = harness([new Error("gone"), pluginOnly, new Error("gone"), pluginOnly]);
  const controller = new ZellijController(h.execute);
  const surface = { paneId: "terminal_4", parentPaneId: "terminal_1" };
  await controller.close(surface);
  await controller.interrupt(surface);
  assert.deepEqual(h.calls, [
    ["action", "close-pane", "--pane-id", "terminal_4"],
    ["action", "list-panes", "--json", "--all"],
    ["action", "send-keys", "--pane-id", "terminal_4", "Ctrl c"],
    ["action", "list-panes", "--json", "--all"],
  ]);
});

test("FP-03 Unit: WHEN screen is requested, THEN dump-screen targets the pane", async () => {
  const h = harness([{ stdout: "screen", stderr: "" }]);
  assert.equal(await new ZellijController(h.execute).screen({ paneId: "terminal_4", parentPaneId: "terminal_1" }, true), "screen");
  assert.deepEqual(h.calls[0], ["action", "dump-screen", "--pane-id", "terminal_4", "--full"]);
});
