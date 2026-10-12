import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { ZellijController, type ZellijSurface } from "../../extensions/zellij.ts";
import { runChildTask } from "../../extensions/child-runner.ts";
import { readIncrementalResult } from "../../extensions/session-parser.ts";
import { realZellijAvailability, focusPane, listPanes, makeExecutable, temporaryRoot, waitForFile } from "../real-harness.ts";

const fixture = path.resolve("tests/fixtures/offline-provider.ts");
const childRuntime = path.resolve("extensions/child-runtime.ts");
const availability = await realZellijAvailability();
const skip = availability.reason;

async function assertFocused(paneId: string): Promise<void> {
  const focused = (await listPanes()).find(pane => pane.is_focused);
  assert.equal(focused && `terminal_${focused.id}`, paneId);
}

async function closeOwned(controller: ZellijController, surfaces: ZellijSurface[]): Promise<void> {
  for (const surface of [...surfaces].reverse()) {
    try { await controller.close(surface); } catch { /* The owned pane may already have exited. */ }
  }
}

test("FP09-04 Integration: WHEN real Zellij surfaces are created, THEN explicit targeting, focus, placement, command delivery, interruption, and cleanup SHALL work", { skip, timeout: 45_000 }, async () => {
  const parent = availability.parentPaneId!;
  const root = temporaryRoot("surfaces");
  const controller = new ZellijController();
  const owned: ZellijSurface[] = [];
  try {
    const first = await controller.createSurface({ parentPaneId: parent, placement: { kind: "split", direction: "right" }, command: ["sh", "-c", "sleep 30"] });
    owned.push(first);
    assert.notEqual(first.paneId, parent);
    await assertFocused(parent);

    // Change focus to an owned pane. The next creation must still use the explicit parent.
    await focusPane(first.paneId);
    const second = await controller.createSurface({ parentPaneId: parent, placement: { kind: "split", direction: "right" }, command: ["sh", "-c", "sleep 30"] });
    owned.push(second);
    assert.notEqual(second.paneId, first.paneId);
    await assertFocused(parent);

    const tab = await controller.createSurface({ parentPaneId: parent, placement: { kind: "tab" }, command: ["sh", "-c", "sleep 30"] });
    owned.push(tab);
    await assertFocused(parent);

    const concurrent = await Promise.all([
      controller.createSurface({ parentPaneId: parent, placement: { kind: "split", direction: "right" }, command: ["sh", "-c", "sleep 30"] }),
      controller.createSurface({ parentPaneId: parent, placement: { kind: "split", direction: "right" }, command: ["sh", "-c", "sleep 30"] }),
    ]);
    owned.push(...concurrent);
    assert.notEqual(concurrent[0].paneId, concurrent[1].paneId);
    await assertFocused(parent);

    const marker = path.join(root, "long-command.marker");
    const longScript = path.join(root, "command's $long;value.sh");
    makeExecutable(longScript, `#!/bin/sh\nprintf '%s' 'FP09-LONG-$HOME-$(printf no-expand)-semicolon;metachar' > ${JSON.stringify(marker)}\nsleep 30\n`);
    const commandSurface = await controller.createSurface({ parentPaneId: parent, placement: { kind: "split", direction: "right" }, command: ["sh"] });
    owned.push(commandSurface);
    await controller.sendCommand(commandSurface, longScript);
    await waitForFile(marker);
    assert.match(await controller.screen(commandSurface, true), /command/);

    const interrupted = path.join(root, "interrupted.marker");
    const interruptSurface = await controller.createSurface({ parentPaneId: parent, placement: { kind: "split", direction: "right" }, command: ["sh", "-c", `trap 'printf interrupted > ${interrupted}; exit 0' INT; sleep 30`] });
    owned.push(interruptSurface);
    await controller.interrupt(interruptSurface);
    await waitForFile(interrupted);

    const pidFile = path.join(root, "child.pid");
    const exitFile = path.join(root, "child.exit");
    const sidecarSurface = await controller.createSurface({ parentPaneId: parent, placement: { kind: "split", direction: "right" }, command: ["sh", "-c", `printf '%s' "$$" > ${pidFile}; sleep .2; printf '%s' 0 > ${exitFile}; sleep 30`] });
    owned.push(sidecarSurface);
    await waitForFile(pidFile);
    await waitForFile(exitFile);
    const childPid = Number(fs.readFileSync(pidFile, "utf8"));
    assert.ok(Number.isInteger(childPid) && childPid > 0);
    assert.equal(fs.readFileSync(exitFile, "utf8"), "0");

    const failed = await controller.createSurface({ parentPaneId: parent, placement: { kind: "split", direction: "right" }, command: ["sh", "-c", "printf FP09-FAIL; sleep 30"] });
    owned.push(failed);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await controller.paneExists(failed), true, "a failed diagnostic surface remains inspectable before cleanup");
  } finally {
    await closeOwned(controller, owned);
    try { await focusPane(parent); } catch { /* Preserve the original error if the parent closed externally. */ }
  }
});

test("FP09-05 Integration: WHEN production runChildTask starts in an owned Zellij pane, THEN the offline child TUI SHALL settle and follow_up SHALL use a new pane and the same session", { skip, timeout: 60_000 }, async () => {
  const parent = availability.parentPaneId!;
  const root = temporaryRoot("tui");
  const sessionDir = path.join(root, "sessions");
  const evidencePath = path.join(root, "fixture-evidence.json");
  const taskId = `task-${randomUUID()}`;
  const firstRunId = `run-${randomUUID()}`;
  const secondRunId = `run-${randomUUID()}`;
  const oldOffline = process.env.PI_OFFLINE;
  const oldEvidence = process.env.PI_FUSION_FIXTURE_EVIDENCE;
  process.env.PI_OFFLINE = "1";
  process.env.PI_FUSION_FIXTURE_EVIDENCE = evidencePath;
  const input = (runId: string, prompt: string, cursor?: Parameters<typeof runChildTask>[0]["expectedSessionCursor"]) => ({
    taskId,
    runId,
    cwd: root,
    artifactRoot: root,
    sessionDir,
    sessionId: "offline-session",
    model: { provider: "offline-faux", id: "offline", thinking: "off" },
    tools: ["read"],
    extensions: [fixture],
    childRuntimePath: childRuntime,
    systemPrompt: "FP09 real TUI system policy",
    prompt,
    parentPaneId: parent,
    timeoutMs: 20_000,
    ...(cursor ? { requireExistingSession: true, expectedSessionCursor: cursor } : {}),
  });
  let first: Awaited<ReturnType<typeof runChildTask>> | undefined;
  let second: Awaited<ReturnType<typeof runChildTask>> | undefined;
  let failed: Awaited<ReturnType<typeof runChildTask>> | undefined;
  try {
    first = await runChildTask(input(firstRunId, "real TUI first turn"));
    assert.equal(first.status, "ok", first.errorMessage);
    assert.equal(first.report, "offline-first");
    assert.ok(first.cursor);
    assert.ok(first.sessionFile);
    assert.equal(fs.existsSync(first.artifacts.pidPath), true);
    assert.equal(fs.existsSync(first.artifacts.exitPath), true);
    const firstEvidence = await readIncrementalResult(first.sessionFile, { byteOffset: 0 }, { processExited: true, exitStatus: { exitCode: 0 } });
    assert.ok(firstEvidence.usage.totalTokens > 0);

    second = await runChildTask(input(secondRunId, "real TUI follow-up turn", first.cursor));
    assert.equal(second.status, "ok", second.errorMessage);
    assert.equal(second.report, "offline-follow-up");
    assert.equal(second.sessionFile, first.sessionFile);
    assert.notDeepEqual(second.cursor, first.cursor);
    assert.notEqual(second.runId, first.runId);
    assert.notEqual(second.surface?.paneId, first.surface?.paneId);
    const secondEvidence = await readIncrementalResult(second.sessionFile, first.cursor, { processExited: true, exitStatus: { exitCode: 0 } });
    assert.ok(secondEvidence.usage.totalTokens > 0);
    const evidence = JSON.parse(fs.readFileSync(path.join(root, `.pi-fusion-fixture-${secondRunId}.json`), "utf8")) as { response: string; stdioTTY: boolean; messages: Array<{ role: string; content: unknown }> };
    assert.equal(evidence.response, "offline-follow-up");
    assert.equal(evidence.stdioTTY, true, "the owned pane must provide the child inherited TTY");
    assert.ok(evidence.messages.some(message => JSON.stringify(message.content).includes("offline-first")));

    failed = await runChildTask({
      ...input(`run-${randomUUID()}`, "policy failure in a real pane"),
      taskId: `failed-${randomUUID()}`,
      sessionId: "policy-session",
      tools: [],
    });
    assert.equal(failed.status, "error");
    assert.match(failed.errorMessage ?? "", /policy|missing PI_FUSION_TOOLS/i);
    assert.ok(failed.surface);
    assert.equal(await new ZellijController().paneExists(failed.surface), true, "policy failure retains the inspection pane");
    assert.equal(fs.existsSync(failed.artifacts.runtimeErrorPath), true);
  } finally {
    // Successful runs are already closed. These idempotent calls also clean a pane
    // retained by a failed assertion without touching any unrelated surface.
    const controller = new ZellijController();
    for (const result of [failed, second, first]) {
      if (result?.surface) {
        try { await controller.close(result.surface); } catch { /* owned diagnostic pane cleanup only */ }
      }
    }
    try { await focusPane(parent); } catch { /* Preserve the test failure. */ }
    if (oldOffline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = oldOffline;
    if (oldEvidence === undefined) delete process.env.PI_FUSION_FIXTURE_EVIDENCE; else process.env.PI_FUSION_FIXTURE_EVIDENCE = oldEvidence;
  }
});
