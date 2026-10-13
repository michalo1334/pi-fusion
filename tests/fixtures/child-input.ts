import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type { ChildRunInput } from "../../extensions/child-runner.ts";

const defaultModel = { provider: "offline", id: "fixture", thinking: "off" } as const;

/** Build one child-runner input. Tests override only fields relevant to their behavior. */
export function childInput(root: string, overrides: Partial<ChildRunInput> = {}): ChildRunInput {
  return {
    taskId: randomUUID(),
    runId: randomUUID(),
    cwd: root,
    artifactRoot: root,
    sessionDir: path.join(root, "session"),
    sessionId: "session",
    model: defaultModel,
    tools: ["read"],
    extensions: [],
    childRuntimePath: path.join(root, "runtime"),
    systemPrompt: "system",
    prompt: "brief",
    parentPaneId: "terminal_1",
    timeoutMs: 100,
    ...overrides,
  };
}
