import * as fs from "node:fs";
import * as path from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function writeEvidence(value: unknown): void {
  const file = process.env.PI_FUSION_FIXTURE_EVIDENCE
    ?? (process.env.PI_FUSION_RUN_ID ? path.join(process.cwd(), `.pi-fusion-fixture-${process.env.PI_FUSION_RUN_ID}.json`) : undefined);
  if (!file) return;
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, JSON.stringify(value) + "\n", { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, file);
}

export default function offlineProvider(pi: ExtensionAPI): void {
  const faux = fauxProvider({
    api: "offline-faux-api",
    provider: "offline-faux",
    tokensPerSecond: 100_000,
    tokenSize: { min: 8, max: 8 },
    models: [{
      id: "offline",
      name: "Offline fixture",
      reasoning: false,
      input: ["text"],
      cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 256,
    }],
  });

  faux.setResponses([context => {
    const messages = context.messages.map(message => ({
      role: message.role,
      content: typeof message.content === "string" ? message.content : message.content,
    }));
    const hasEarlierAssistant = context.messages.some(message => message.role === "assistant");
    writeEvidence({
      runId: process.env.PI_FUSION_RUN_ID,
      provider: "offline-faux",
      model: "offline",
      messages,
      allTools: pi.getAllTools().map(tool => tool.name).sort(),
      activeTools: pi.getActiveTools().map(tool => String(tool)).sort(),
      response: hasEarlierAssistant ? "offline-follow-up" : "offline-first",
      stdioTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    });
    return fauxAssistantMessage(hasEarlierAssistant ? "offline-follow-up" : "offline-first");
  }]);

  pi.registerProvider(faux.provider);
}
