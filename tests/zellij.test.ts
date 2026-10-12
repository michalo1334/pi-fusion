import test from "node:test";
import assert from "node:assert/strict";
import { resolveParentPaneId } from "../extensions/child-runner.ts";
import { choosePlacement, detectZellij, hasZellijExecutable, withPlacementLock } from "../extensions/zellij.ts";

const env = { ZELLIJ: "0" };

test("FP09-06 Unit: WHEN ZELLIJ_PANE_ID is zero, THE resolver SHALL return terminal_0", () => {
  assert.equal(resolveParentPaneId({ ZELLIJ_PANE_ID: "0" }), "terminal_0");
});

test("FP09-06 Unit: WHEN ZELLIJ_PANE_ID is a positive safe integer, THE resolver SHALL return its terminal ID", () => {
  assert.equal(resolveParentPaneId({ ZELLIJ_PANE_ID: "42" }), "terminal_42");
  assert.equal(resolveParentPaneId({ ZELLIJ_PANE_ID: "0007" }), "terminal_7");
  assert.equal(resolveParentPaneId({ ZELLIJ_PANE_ID: String(Number.MAX_SAFE_INTEGER) }), `terminal_${Number.MAX_SAFE_INTEGER}`);
});

test("FP09-06 Unit: WHEN ZELLIJ_PANE_ID is malformed, negative, fractional, or unsafe, THE resolver SHALL reject it", () => {
  for (const value of ["", "abc", "1x", "-1", "1.5", "1e2", String(Number.MAX_SAFE_INTEGER + 1), "999999999999999999999999999999"]) {
    assert.equal(resolveParentPaneId({ ZELLIJ_PANE_ID: value }), undefined, value);
  }
});

test("FP-02 Unit: WHEN Zellij marker and executable exist, detection SHALL be available", () => {
  assert.equal(detectZellij(env, true).available, true);
});

test("FP-02 Unit: WHEN the marker or executable is absent, detection SHALL return setup guidance", () => {
  assert.equal(detectZellij({}, true).reason, "inactive");
  assert.equal(detectZellij(env, false).reason, "missing-executable");
  assert.match(detectZellij({}, true).setupHint, /active Zellij/);
});

test("FP-02 Unit: WHEN there is room, placement SHALL choose a split", () => {
  assert.deepEqual(choosePlacement({ columns: 200, rows: 40 }), { kind: "split", direction: "right" });
  assert.deepEqual(choosePlacement({ columns: 100, rows: 60 }), { kind: "split", direction: "down" });
});

test("FP-02 Unit: WHEN either split axis is too small, placement SHALL use a safe fallback", () => {
  assert.deepEqual(choosePlacement({ columns: 200, rows: 10 }), { kind: "tab" });
  assert.deepEqual(choosePlacement({ columns: 70, rows: 60 }), { kind: "tab" });
});

test("FP-02 Unit: WHEN geometry is malformed or below stacked limits, placement SHALL choose a tab", () => {
  for (const layout of [
    { columns: 0, rows: 40, paneCount: 2 },
    { columns: -1, rows: 40, paneCount: 2 },
    { columns: Number.NaN, rows: 40, paneCount: 2 },
    { columns: Number.POSITIVE_INFINITY, rows: 40, paneCount: 2 },
    { columns: 100, rows: 20, paneCount: 2 },
    { columns: 100, rows: 24, paneCount: 0 },
  ]) assert.deepEqual(choosePlacement(layout), { kind: "tab" });
});

test("FP-02 Unit: WHEN geometry meets stacked limits and has a pane, placement SHALL stack", () => {
  assert.deepEqual(choosePlacement({ columns: 80, rows: 24, paneCount: 1 }), { kind: "stacked" });
});

test("FP-02 Unit: WHEN the executable probe succeeds or fails, availability SHALL match the probe", async () => {
  assert.equal(await hasZellijExecutable(async () => ({ stdout: "zellij 0.40", stderr: "" })), true);
  assert.equal(await hasZellijExecutable(async () => { throw new Error("missing"); }), false);
});

test("FP-02 Unit: WHEN placement operations overlap, the process lock SHALL serialize them", async () => {
  const events: string[] = [];
  let release!: () => void;
  const first = withPlacementLock(async () => {
    events.push("first-start");
    await new Promise<void>((resolve) => { release = resolve; });
    events.push("first-end");
  });
  const second = withPlacementLock(async () => { events.push("second"); });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["first-start"]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first-start", "first-end", "second"]);
});

test("FP-02 Unit: WHEN placement succeeds or fails, the lock SHALL be released", async () => {
  await assert.rejects(withPlacementLock(async () => { throw new Error("expected"); }), /expected/);
  let ran = false;
  await withPlacementLock(async () => { ran = true; });
  assert.equal(ran, true);
});
