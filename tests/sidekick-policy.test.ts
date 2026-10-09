import assert from "node:assert/strict";
import test from "node:test";
import {
  assertNoRecursiveFusionExtensions,
  assertNoRecursiveFusionTools,
} from "../extensions/sidekick-policy.ts";

test("allows ordinary sidekick tools and extensions", () => {
  assert.doesNotThrow(() => assertNoRecursiveFusionTools(["read", "bash", "mcp"]));
  assert.doesNotThrow(() => assertNoRecursiveFusionExtensions(["pi-mcp-adapter", "context-mode"]));
});

test("blocks delegate and follow_up", () => {
  assert.throws(() => assertNoRecursiveFusionTools(["delegate"]), /cannot call recursive Fusion tools: delegate/);
  assert.throws(() => assertNoRecursiveFusionTools(["follow_up"]), /cannot call recursive Fusion tools: follow_up/);
  assert.throws(
    () => assertNoRecursiveFusionTools(["read", "delegate", "follow_up"]),
    /delegate, follow_up/,
  );
});

test("blocks Fusion extension aliases", () => {
  for (const extension of ["fusion", "pi-fusion", "michalo-pi-fusion", "@michalo1334/pi-fusion"]) {
    assert.throws(
      () => assertNoRecursiveFusionExtensions([extension]),
      /cannot load the Fusion extension/,
    );
  }
});
