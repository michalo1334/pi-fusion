import test from "node:test";
import assert from "node:assert/strict";
import childRuntime from "../extensions/child-runtime.ts";

function tool(name: string) { return { name, description: "", parameters: {}, promptGuidelines: [] }; }
function harness(names: string[]) {
  const handlers = new Map<string, Function>();
  let active = [...names]; let shutdowns = 0;
  const pi: any = {
    getAllTools: () => names.map(tool), getActiveTools: () => [...active], setActiveTools: (next: string[]) => { active = [...next]; },
    on: (name: string, fn: Function) => { handlers.set(name, fn); return () => undefined; },
  };
  childRuntime(pi);
  return { pi, handlers, add: (name: string) => names.push(name), active: () => active, shutdowns: () => shutdowns,
    setShutdown: () => { shutdowns++; },
    async input() { return handlers.get("input")?.({}, { shutdown: () => { shutdowns++; } }); },
    settle() { handlers.get("agent_settled")?.({}, { shutdown: () => { shutdowns++; } }); },
    call(name: string) { return handlers.get("tool_call")?.({ toolName: name }, {}); },
  };
}

async function withEnv(tools: string | undefined, fn: () => Promise<void>) {
  const oldChild = process.env.PI_FUSION_CHILD, oldTools = process.env.PI_FUSION_TOOLS;
  const oldDeadline = process.env.PI_FUSION_POLICY_DEADLINE_MS, oldExit = process.exitCode;
  process.env.PI_FUSION_CHILD = "1";
  if (tools === undefined) delete process.env.PI_FUSION_TOOLS; else process.env.PI_FUSION_TOOLS = tools;
  process.env.PI_FUSION_POLICY_DEADLINE_MS = "20"; process.exitCode = 0;
  try { await fn(); } finally {
    if (oldChild === undefined) delete process.env.PI_FUSION_CHILD; else process.env.PI_FUSION_CHILD = oldChild;
    if (oldTools === undefined) delete process.env.PI_FUSION_TOOLS; else process.env.PI_FUSION_TOOLS = oldTools;
    if (oldDeadline === undefined) delete process.env.PI_FUSION_POLICY_DEADLINE_MS; else process.env.PI_FUSION_POLICY_DEADLINE_MS = oldDeadline;
    process.exitCode = oldExit;
  }
}

test("FP-04 Unit: WHEN an approved tool appears during input readiness, the handler SHALL continue", async () => withEnv("read,mcp", async () => {
  const h = harness(["read"]); h.handlers.get("session_start")?.({}, {}); const pending = h.input();
  await new Promise(r => setTimeout(r, 3)); h.add("mcp");
  assert.deepEqual(await pending, { action: "continue" }); assert.deepEqual(h.active(), ["read", "mcp"]);
}));

test("FP-04 Unit: WHEN readiness expires, input SHALL be handled, disabled, and nonzero", async () => withEnv("read,missing", async () => {
  const h = harness(["read"]); h.handlers.get("session_start")?.({}, {});
  assert.deepEqual(await h.input(), { action: "handled" }); assert.deepEqual(h.active(), []); assert.equal(process.exitCode, 78); assert.equal(h.shutdowns(), 1);
  assert.deepEqual(await h.input(), { action: "handled" }); assert.equal(h.shutdowns(), 1);
  h.settle(); h.settle(); assert.equal(h.shutdowns(), 2);
}));

test("FP-04 Unit: WHEN requested tools are malformed or absent, the child SHALL consume input safely", async () => {
  for (const value of [undefined, "", "delegate"]) await withEnv(value, async () => {
    const h = harness(["read"]); h.handlers.get("session_start")?.({}, {});
    assert.deepEqual(await h.input(), { action: "handled" }); assert.deepEqual(h.active(), []); assert.equal(h.shutdowns(), 1);
  });
});

test("FP-04 Unit: WHEN a tool is added after failure, it SHALL not re-enable and calls SHALL remain blocked", async () => withEnv("read,missing", async () => {
  const h = harness(["read"]); h.handlers.get("session_start")?.({}, {}); await h.input(); h.add("missing");
  assert.deepEqual(h.active(), []); assert.ok(h.call("read")); assert.ok(h.call("missing")); h.settle(); h.settle(); assert.equal(h.shutdowns(), 2);
}));

test("FP-04 Unit: WHEN an unapproved late tool call occurs, it SHALL be blocked", async () => withEnv("read", async () => {
  const h = harness(["read", "extra"]); h.handlers.get("session_start")?.({}, {}); await h.input();
  assert.equal(h.call("extra").block, true); assert.equal(h.call("read"), undefined);
}));
