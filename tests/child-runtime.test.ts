import test from "node:test";
import assert from "node:assert/strict";
import childRuntime from "../extensions/child-runtime.ts";

type Handler = (event: unknown, ctx: { shutdown: () => void }) => void;

function extensionHarness() {
  let handler: Handler | undefined;
  let shutdowns = 0;
  const pi = {
    on(event: string, next: Handler) {
      assert.equal(event, "agent_settled");
      handler = next;
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
  process.env.PI_FUSION_CHILD = "1";
  try {
    const runtime = extensionHarness();
    runtime.settle();
    runtime.settle();
    assert.equal(runtime.shutdowns, 1);
  } finally {
    if (previous === undefined) delete process.env.PI_FUSION_CHILD;
    else process.env.PI_FUSION_CHILD = previous;
  }
});
