import assert from "node:assert/strict";
import test from "node:test";
import {
  assertNoRecursiveFusionExtensions,
  assertNoRecursiveFusionTools,
} from "../extensions/sidekick-policy.ts";
import { selectedSidekickTools } from "../extensions/fusion.ts";

test("allows ordinary sidekick tools and extensions", () => {
  assert.doesNotThrow(() => assertNoRecursiveFusionTools(["read", "bash", "mcp"]));
  assert.doesNotThrow(() => assertNoRecursiveFusionExtensions(["pi-mcp-adapter", "context-mode"]));
});

test("allows the default-safe context-mode tools with an exact allowlist", () => {
  const tools = [
    "ctx_execute", "ctx_execute_file", "ctx_index", "ctx_search", "ctx_fetch_and_index", "ctx_batch_execute", "ctx_stats", "ctx_doctor",
  ];
  assert.deepEqual(selectedSidekickTools(tools, ["context-mode"]), tools);
});

test("allows sensitive context-mode tools only when explicitly configured", () => {
  const tools = ["ctx_upgrade", "ctx_purge"];
  assert.deepEqual(selectedSidekickTools(tools, ["context-mode"]), tools);
});

test("rejects context-mode tools when the context-mode extension is not selected", () => {
  assert.throws(
    () => selectedSidekickTools(["ctx_execute"], []),
    /includes context-mode tools but fusion\.sidekickExtensions omits context-mode/,
  );
});

test("rejects unsupported sidekick tool names", () => {
  assert.throws(
    () => selectedSidekickTools(["ctx_not_registered"], ["context-mode"]),
    /Unsupported fusion\.sidekickTools values: ctx_not_registered/,
  );
});

test("does not add extension tools to an explicit allowlist", () => {
  const tools = ["read"];
  assert.deepEqual(selectedSidekickTools(tools, []), ["read"]);
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
