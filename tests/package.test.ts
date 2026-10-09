import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function loadPackage(t: { after: (fn: () => void) => void }) {
  const temp = mkdtempSync(join(tmpdir(), "fusion-package-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const cwd = join(temp, "consumer");
  const agentDir = join(temp, "agent");
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  mkdirSync(agentDir);
  writeFileSync(join(cwd, ".pi/settings.json"), JSON.stringify({ packages: [ROOT] }));
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
  await loader.reload({ resolveProjectTrust: async () => true });
  return { cwd, agentDir, loader, settingsManager };
}

test("FUSION-01 Integration: WHEN installed as a package, Pi SHALL discover one extension and one lead skill", async (t) => {
  const { loader } = await loadPackage(t);
  const { extensions, errors } = loader.getExtensions();
  assert.deepEqual(errors, []);
  assert.equal(extensions.length, 1);
  assert.equal(extensions[0].path, join(ROOT, "extensions/fusion.ts"));
  assert.deepEqual([...extensions[0].tools.keys()].sort(), ["delegate", "follow_up"]);
  assert.deepEqual([...extensions[0].commands.keys()], ["fusion-model"]);
  const { skills, diagnostics } = loader.getSkills();
  assert.deepEqual(diagnostics, []);
  assert.equal(skills.length, 1);
  assert.equal(skills[0].name, "fusion");
  assert.equal(skills[0].filePath, join(ROOT, "skills/fusion/SKILL.md"));
});

test("FUSION-02 Integration: WHEN a Pi session uses the package, its delegation tools SHALL be active", async (t) => {
  const { cwd, agentDir, loader, settingsManager } = await loadPackage(t);
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    resourceLoader: loader,
    settingsManager,
    sessionManager: SessionManager.inMemory(cwd),
    tools: ["delegate", "follow_up"],
  });
  try {
    await session.bindExtensions({});
    assert.deepEqual(session.getActiveToolNames().sort(), ["delegate", "follow_up"]);
  } finally {
    session.dispose();
  }
});
