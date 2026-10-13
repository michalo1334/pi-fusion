import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import childRuntime from "../extensions/child-runtime.ts";
import { withEnvironment } from "./fixtures/environment.ts";
import { tempRoot } from "./fixtures/temp-root.ts";

type Handler = (event: unknown, ctx: { shutdown: () => void }) => void;

function policyHarness(all: string[], active: string[]) {
  let selected = [...active];
  return {
    pi: { getAllTools: () => all.map(name => ({ name, description: "", parameters: {}, promptGuidelines: [] })), getActiveTools: () => selected, setActiveTools: (next: string[]) => { selected = [...next]; } } as any,
    active: () => selected,
  };
}

function extensionHarness() {
  let handler: Handler | undefined;
  let shutdowns = 0;
  const pi = {
    getAllTools: () => [], getActiveTools: () => [], setActiveTools: () => undefined,
    on(event: string, next: Handler) {
        if (event === "agent_settled") handler = next;
      return () => undefined;
    },
  } as unknown as Parameters<typeof childRuntime>[0];
  childRuntime(pi);
  return {
    settle() {
      assert.ok(handler, "child runtime must register its settlement handler");
      handler({}, { shutdown: () => { shutdowns += 1; } });
    },
    get shutdowns() {
      return shutdowns;
    },
  };
}

test("FP-04 Architecture: SHALL enforce the exact registered capability allowlist", async () => {
  const { validateChildTools } = await import("../extensions/child-runtime.ts");
  const harness = policyHarness(["read", "bash", "mcp__web_search"], ["read", "bash", "mcp__web_search"]);
  validateChildTools(harness.pi, ["read", "mcp__web_search"]);
  assert.deepEqual(harness.active(), ["read", "mcp__web_search"]);
  assert.throws(() => validateChildTools(policyHarness(["read"], []).pi, ["read", "mcp__web_search"]));
  assert.throws(() => validateChildTools(harness.pi, ["read", "delegate"]));
});

test("FP-01 Unit: WHEN the process is not a marked child, the runtime SHALL not register a settlement handler", async () => {
  for (const marker of [undefined, "0"]) {
    await withEnvironment({ PI_FUSION_CHILD: marker }, () => {
      let registrations = 0;
      const pi = { on: () => { registrations += 1; } } as unknown as Parameters<typeof childRuntime>[0];

      childRuntime(pi);

      assert.equal(registrations, 0, `unexpected registration for marker ${marker}`);
    });
  }
});

test("FP-05/EARS: WHEN the child reports a runtime error, THE runtime SHALL write a matching atomic sidecar", async (t) => {
  const root = tempRoot(t, "fusion-runtime-error");
  const file = path.join(root, "runtime-error.json");
  await withEnvironment({
    PI_FUSION_CHILD: "1",
    PI_FUSION_RUN_ID: "run-1",
    PI_FUSION_RUNTIME_ERROR_PATH: file,
  }, () => {
    let agentEnd: ((event: any) => void) | undefined;
    let settled: ((event: any, ctx: { shutdown: () => void }) => void) | undefined;
    const pi = { getAllTools: () => [], getActiveTools: () => [], setActiveTools: () => undefined, on(event: string, handler: any) {
      if (event === "agent_end") agentEnd = handler;
      if (event === "agent_settled") settled = handler;
      return () => undefined;
    }} as unknown as Parameters<typeof childRuntime>[0];
    childRuntime(pi);
    agentEnd?.({ messages: [{ stopReason: "error", errorMessage: "provider request failed" }] });
    settled?.({ aborted: false }, { shutdown: () => undefined });
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(record, { runId: "run-1", error: "Fusion child runtime failure: provider request failed" });
  });
});

test("FP-01 Unit: WHEN a marked child settles, the runtime SHALL request one orderly shutdown", async () => {
  await withEnvironment({ PI_FUSION_CHILD: "1", PI_FUSION_TOOLS: "read" }, () => {
    const runtime = extensionHarness();
    runtime.settle();
    runtime.settle();
    assert.equal(runtime.shutdowns, 1);
  });
});
