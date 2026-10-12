import * as fs from "node:fs";
import * as path from "node:path";

const THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export function normalizeFusionModel(value: string): string {
  const input = value.trim();
  const slash = input.indexOf("/");
  if (slash <= 0 || slash === input.length - 1) throw new Error("Use provider/model[:thinking]");
  const provider = input.slice(0, slash).trim();
  let model = input.slice(slash + 1).trim();
  let thinking = "off";
  const colon = model.lastIndexOf(":");
  if (colon > 0) {
    const candidate = model.slice(colon + 1).trim();
    if (!THINKING.has(candidate)) throw new Error(`Invalid thinking level: ${candidate}`);
    model = model.slice(0, colon).trim();
    thinking = candidate;
  }
  if (!model) throw new Error("Use provider/model[:thinking]");
  return `${provider}/${model}:${thinking}`;
}

export function persistFusionModel(settingsFile: string, value: string): string {
  const normalized = normalizeFusionModel(value);
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(settingsFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Settings JSON must be an object");
      settings = parsed;
    } catch (error) {
      throw new Error(`Cannot persist Fusion settings: malformed JSON (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  const fusion = settings.fusion;
  settings.fusion = fusion && typeof fusion === "object" && !Array.isArray(fusion) ? { ...(fusion as object), sidekickModel: normalized } : { sidekickModel: normalized };
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  const temporary = `${settingsFile}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, settingsFile);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* best effort */ }
    throw error;
  }
  return normalized;
}
