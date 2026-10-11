import test from "node:test";
import assert from "node:assert/strict";
import childRuntime from "../extensions/child-runtime.ts";

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

test("FP-01 Unit: WHEN the process is not a marked child, the runtime SHALL not register a settlement handler", () => {
  const previous = process.env.PI_FUSION_CHILD;
  try {
    for (const marker of [undefined, "0"]) {
      if (marker === undefined) delete process.env.PI_FUSION_CHILD;
      else process.env.PI_FUSION_CHILD = marker;
      let registrations = 0;
      const pi = { on: () => { registrations += 1; } } as unknown as Parameters<typeof childRuntime>[0];

      childRuntime(pi);

      assert.equal(registrations, 0, `unexpected registration for marker ${marker}`);
    }
  } finally {
    if (previous === undefined) delete process.env.PI_FUSION_CHILD;
    else process.env.PI_FUSION_CHILD = previous;
  }
});

test("FP-01 Unit: WHEN a marked child settles, the runtime SHALL request one orderly shutdown", () => {
  const previous = process.env.PI_FUSION_CHILD;
  const previousTools = process.env.PI_FUSION_TOOLS;
  process.env.PI_FUSION_CHILD = "1";
  process.env.PI_FUSION_TOOLS = "read";
  try {
    const runtime = extensionHarness();
    runtime.settle();
    runtime.settle();
    assert.equal(runtime.shutdowns, 1);
  } finally {
    if (previous === undefined) delete process.env.PI_FUSION_CHILD;
    else process.env.PI_FUSION_CHILD = previous;
    if (previousTools === undefined) delete process.env.PI_FUSION_TOOLS;
    else process.env.PI_FUSION_TOOLS = previousTools;
  }
});
