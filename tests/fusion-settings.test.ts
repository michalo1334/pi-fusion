import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { normalizeFusionModel, persistFusionModel } from "../extensions/fusion-settings.ts";
import { tempRoot } from "./fixtures/temp-root.ts";

test("FUSION-SETTINGS-01: WHEN a model has whitespace, THEN normalization returns provider/model:thinking", () => {
  assert.equal(normalizeFusionModel(" anthropic/claude:high "), "anthropic/claude:high");
  assert.equal(normalizeFusionModel("offline/fixture"), "offline/fixture:off");
});

test("FUSION-SETTINGS-02: WHEN settings exist, THEN persistence preserves unrelated fields", (t) => {
  const root = tempRoot(t, "fusion-settings");
  const file = path.join(root, ".pi", "settings.json");
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, '{"theme":"dark","fusion":{"timeoutMinutes":3}}\n');
  persistFusionModel(file, "openai/gpt:medium");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { theme: "dark", fusion: { timeoutMinutes: 3, sidekickModel: "openai/gpt:medium" } });
});

test("FUSION-SETTINGS-03: WHEN settings are absent, THEN persistence creates the file and fusion object", (t) => {
  const root = tempRoot(t, "fusion-settings");
  const file = path.join(root, ".pi", "settings.json");
  persistFusionModel(file, "openai/gpt:low");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).fusion.sidekickModel, "openai/gpt:low");
});

test("FUSION-SETTINGS-04: WHEN JSON is malformed, THEN persistence rejects without overwriting", (t) => {
  const root = tempRoot(t, "fusion-settings");
  const file = path.join(root, ".pi", "settings.json");
  const original = "{ malformed";
  fs.mkdirSync(path.dirname(file)); fs.writeFileSync(file, original);
  assert.throws(() => persistFusionModel(file, "openai/gpt:high"), /malformed/i);
  assert.equal(fs.readFileSync(file, "utf8"), original);
});
