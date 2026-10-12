import test from "node:test";
import assert from "node:assert/strict";
import childRuntime from "../extensions/child-runtime.ts";

function tool(name: string) { return { name, description: "", parameters: {}, promptGuidelines: [] }; }

function harness(names: string[], configure?: (pi: any) => void) {
  const handlers = new Map<string, Function[]>();
  let active = [...names];
  let shutdowns = 0;
  const pi: any = {
    getAllTools: () => names.map(tool),
    getActiveTools: () => [...active],
    setActiveTools: (next: string[]) => { active = [...next]; },
    registerTool: (definition: { name: string }) => { names.push(definition.name); },
    on: (name: string, fn: Function) => {
      const registered = handlers.get(name) ?? [];
      registered.push(fn);
      handlers.set(name, registered);
      return () => undefined;
    },
  };
  configure?.(pi);
  childRuntime(pi);
  const emit = async (name: string, event: unknown = {}) => {
    let result: unknown;
    for (const handler of handlers.get(name) ?? []) {
      result = await handler(event, { shutdown: () => { shutdowns++; } });
    }
    return result;
  };
  return {
    pi, handlers, add: (name: string) => names.push(name), active: () => active, shutdowns: () => shutdowns,
    input: () => emit("input"), beforeAgentStart: () => emit("before_agent_start"),
    sessionStart: () => emit("session_start"), settle: () => emit("agent_settled"),
    call: (name: string) => handlers.get("tool_call")?.at(-1)?.({ toolName: name }, {}),
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

test("FUSION-CTX-01 Unit: WHEN a requested lazy tool is absent during input, THEN input SHALL continue without waiting", async () => withEnv("read,ctx_execute", async () => {
  const h = harness(["read"]);
  await h.sessionStart();
  assert.deepEqual(await h.input(), { action: "continue" });
  assert.deepEqual(h.active(), [], "input must keep every tool disabled");
  assert.equal(h.shutdowns(), 0, "input must not wait for a lazy bridge");
}));

test("FUSION-CTX-02 Unit: WHEN context-mode registers a requested tool before child-runtime validation, THEN the exact policy SHALL become active", async () => withEnv("read,ctx_execute", async () => {
  const h = harness(["read"], (pi) => {
    pi.on("before_agent_start", () => pi.registerTool(tool("ctx_execute")));
  });
  await h.sessionStart();
  assert.deepEqual(await h.input(), { action: "continue" });
  await h.beforeAgentStart();
  assert.deepEqual(h.active(), ["read", "ctx_execute"]);
  assert.equal(h.shutdowns(), 0);
}));

test("FUSION-CTX-03 Unit: WHEN a lazy requested tool remains missing, THEN before_agent_start SHALL fail closed", async () => withEnv("read,missing", async () => {
  const h = harness(["read"]);
  await h.sessionStart();
  await h.input();
  await h.beforeAgentStart();
  assert.deepEqual(h.active(), []);
  assert.equal(process.exitCode, 78);
  assert.equal(h.shutdowns(), 1);
}));

test("FUSION-CTX-04 Unit: WHEN recursive tools are requested, THEN input SHALL stop the child before a model turn", async () => withEnv("read,delegate", async () => {
  const h = harness(["read", "delegate"]);
  await h.sessionStart();
  assert.deepEqual(await h.input(), { action: "handled" });
  assert.deepEqual(h.active(), []);
  assert.equal(process.exitCode, 78);
  assert.equal(h.shutdowns(), 1);
}));

test("FUSION-CTX-05 Unit: WHEN requested tools are malformed or absent, the child SHALL consume input safely", async () => {
  for (const value of [undefined, "", "read,,bash"]) await withEnv(value, async () => {
    const h = harness(["read"]); await h.sessionStart();
    assert.deepEqual(await h.input(), { action: "handled" }); assert.deepEqual(h.active(), []); assert.equal(h.shutdowns(), 1);
  });
});

test("FUSION-CTX-06 Unit: WHEN a tool is added after failure, it SHALL not re-enable and calls SHALL remain blocked", async () => withEnv("read,missing", async () => {
  const h = harness(["read"]); await h.sessionStart(); await h.input(); await h.beforeAgentStart(); h.add("missing");
  assert.deepEqual(h.active(), []); assert.ok(h.call("read")); assert.ok(h.call("missing"));
}));

test("FUSION-CTX-07 Unit: WHEN an unapproved late tool call occurs, it SHALL be blocked", async () => withEnv("read", async () => {
  const h = harness(["read", "extra"]); await h.sessionStart(); await h.input(); await h.beforeAgentStart();
  assert.equal(h.call("extra").block, true); assert.equal(h.call("read"), undefined);
}));
