import * as path from "node:path";
import type { ChildLaunchSpec, RunArtifacts } from "../../extensions/child-process.ts";

const defaultModel = { provider: "offline", id: "fixture", thinking: "off" } as const;

/** Build launch data only. The fixture does not create wrappers or start processes. */
export function launchSpec(
  root: string,
  artifacts: RunArtifacts,
  overrides: Partial<ChildLaunchSpec> = {},
): ChildLaunchSpec {
  return {
    taskId: path.basename(artifacts.taskDir),
    runId: path.basename(artifacts.runDir),
    cwd: root,
    artifactRoot: root,
    sessionDir: path.join(root, "sessions"),
    sessionId: "session",
    model: defaultModel,
    tools: [],
    extensions: [],
    promptPath: artifacts.promptPath,
    systemPromptPath: artifacts.systemPromptPath,
    childRuntimePath: path.join(root, "runtime"),
    ...overrides,
  };
}
