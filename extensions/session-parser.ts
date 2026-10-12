import * as fs from "node:fs";
import * as crypto from "node:crypto";

export interface SessionCursor {
  /** Byte offset immediately after the last complete JSONL line seen before the run. */
  byteOffset: number;
  lastEntryId?: string;
  /** Pi session header id. This prevents a cursor from being used with another session. */
  sessionId?: string;
  /** File identity and prefix fingerprint protect the cursor from replacement and rewrite. */
  fileIdentity?: { dev: number; ino: number };
  prefixHash?: string;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
  reasoning?: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export type RunOutcome = "success" | "error" | "aborted";

export interface ExitStatus {
  exitCode: number | null;
  error?: string;
}

export interface RunResult {
  report: string;
  usage: Usage;
  outcome: RunOutcome;
  errorMessage?: string;
  /** True when the child is still running and the file ends in an incomplete line. */
  partialTail: boolean;
  /** Cursor for the next run. The caller must store this only after it accepts this result. */
  cursor: SessionCursor;
}

export interface ReadRunOptions {
  /** The wrapper has written its exit sidecar. Defaults to true. */
  processExited?: boolean;
  /** Optional live process probe. False means that a partial tail is still in progress. */
  isProcessAlive?: () => boolean | Promise<boolean>;
  stabilityTimeoutMs?: number;
  probeIntervalMs?: number;
  signal?: AbortSignal;
  exitStatus?: ExitStatus;
}

export class SessionIntegrityError extends Error {
  readonly partialUsage?: Usage;
  readonly partialReport?: string;
  readonly partialOutcome?: RunOutcome;

  constructor(message: string, evidence?: { usage?: Usage; report?: string; outcome?: RunOutcome }) {
    super(message);
    this.name = "SessionIntegrityError";
    this.partialUsage = evidence?.usage;
    this.partialReport = evidence?.report;
    this.partialOutcome = evidence?.outcome;
  }
}

interface SessionEntry {
  type: string;
  id?: string;
  parentId?: string | null;
  message?: Record<string, unknown>;
  endOffset: number;
  lineOffset: number;
}

interface ParsedFile {
  header: Record<string, unknown>;
  entries: SessionEntry[];
  headerEnd: number;
  completeBytes: number;
  partialTail: boolean;
}

const FALLBACK_REPORT = "(sidekick produced no report)";
const SHORT_REPORT_CHARS = 200;
const USAGE_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;
const COST_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function addUsage(target: Usage, value: unknown): void {
  if (!value || typeof value !== "object") return;
  const usage = value as Record<string, unknown>;
  for (const field of USAGE_FIELDS) target[field] += finite(usage[field]);
  const cost = usage.cost;
  if (cost && typeof cost === "object") {
    const costs = cost as Record<string, unknown>;
    for (const field of COST_FIELDS) target.cost[field] += finite(costs[field]);
  }
  if (typeof usage.cacheWrite1h === "number" && Number.isFinite(usage.cacheWrite1h) && usage.cacheWrite1h >= 0) {
    target.cacheWrite1h = (target.cacheWrite1h ?? 0) + usage.cacheWrite1h;
  }
  if (typeof usage.reasoning === "number" && Number.isFinite(usage.reasoning) && usage.reasoning >= 0) {
    target.reasoning = (target.reasoning ?? 0) + usage.reasoning;
  }
}

function hashPrefix(bytes: Buffer, length: number): string {
  return crypto.createHash("sha256").update(bytes.subarray(0, length)).digest("hex");
}

function statIdentity(stat: fs.Stats): { dev: number; ino: number } {
  return { dev: stat.dev, ino: stat.ino };
}

function sameIdentity(a: { dev: number; ino: number }, b: { dev: number; ino: number }): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } =>
      !!block && typeof block === "object" && (block as Record<string, unknown>).type === "text" && typeof (block as Record<string, unknown>).text === "string",
    )
    .map((block) => block.text)
    .join("\n");
}

function decode(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new SessionIntegrityError(`Session contains invalid UTF-8: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseJsonLine(bytes: Buffer, lineOffset: number): Record<string, unknown> {
  const source = decode(bytes).replace(/\r$/, "");
  if (!source.trim()) throw new SessionIntegrityError(`Session contains an empty finalized line at byte ${lineOffset}`);
  try {
    const value: unknown = JSON.parse(source);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("line is not a JSON object");
    return value as Record<string, unknown>;
  } catch (error) {
    throw new SessionIntegrityError(`Malformed finalized JSONL line at byte ${lineOffset}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseComplete(bytes: Buffer, allowPartialTail: boolean): ParsedFile {
  const entries: SessionEntry[] = [];
  let start = 0;
  let completeBytes = 0;
  while (start < bytes.length) {
    const newline = bytes.indexOf(0x0a, start);
    if (newline < 0) break;
    const line = bytes.subarray(start, newline);
    const value = parseJsonLine(line, start);
    if (entries.length === 0) {
      if (value.type !== "session") throw new SessionIntegrityError("Session file does not start with a session header");
      if (typeof value.id !== "string" || !value.id) throw new SessionIntegrityError("Session header has no valid id");
    } else {
      if (typeof value.type !== "string" || !value.type) throw new SessionIntegrityError(`Session entry at byte ${start} has no type`);
      if (typeof value.id !== "string" || !value.id) throw new SessionIntegrityError(`Session entry at byte ${start} has no id`);
      if (!(value.parentId === null || typeof value.parentId === "string")) {
        throw new SessionIntegrityError(`Session entry ${value.id} has an invalid parentId`);
      }
      if (value.type === "message" && (!value.message || typeof value.message !== "object" || typeof (value.message as Record<string, unknown>).role !== "string")) {
        throw new SessionIntegrityError(`Session message entry ${value.id} has no valid message role`);
      }
    }
    entries.push({
      type: value.type as string,
      id: typeof value.id === "string" ? value.id : undefined,
      parentId: value.parentId as string | null | undefined,
      message: value.message && typeof value.message === "object" ? value.message as Record<string, unknown> : undefined,
      endOffset: newline + 1,
      lineOffset: start,
    });
    completeBytes = newline + 1;
    start = newline + 1;
  }
  const partialTail = completeBytes !== bytes.length;
  if (partialTail && !allowPartialTail) {
    throw new SessionIntegrityError(`Session ends with an incomplete JSONL line at byte ${completeBytes}`);
  }
  if (entries.length === 0 && bytes.length > 0 && !partialTail) throw new SessionIntegrityError("Session file is empty");
  if (entries.length === 0 && bytes.length === 0) return { header: {}, entries, headerEnd: 0, completeBytes: 0, partialTail };
  const headerEnd = entries[0]?.endOffset ?? 0;
  return { header: entries[0] ? (parseJsonLine(bytes.subarray(0, bytes.indexOf(0x0a)), 0)) : {}, entries: entries.slice(1), headerEnd, completeBytes, partialTail };
}

function validateTree(header: Record<string, unknown>, entries: SessionEntry[]): Map<string, SessionEntry> {
  if (header.type !== "session" || typeof header.id !== "string" || !header.id) throw new SessionIntegrityError("Session header is invalid");
  const byId = new Map<string, SessionEntry>();
  for (const entry of entries) {
    if (!entry.id) continue;
    if (byId.has(entry.id)) throw new SessionIntegrityError(`Session contains duplicate entry id ${entry.id}`);
    byId.set(entry.id, entry);
  }
  for (const entry of entries) {
    if (entry.parentId !== null && entry.parentId !== undefined && !byId.has(entry.parentId)) {
      throw new SessionIntegrityError(`Session entry ${entry.id} points to missing parent ${entry.parentId}`);
    }
  }
  return byId;
}

function authoritativeAssistantEntries(entries: SessionEntry[], cursor: SessionCursor): SessionEntry[] {
  return entries.filter((entry) =>
    entry.endOffset > cursor.byteOffset &&
    entry.type === "message" &&
    entry.message?.role === "assistant" &&
    entry.message.stopReason !== "pending",
  );
}

function sumAssistantUsage(entries: SessionEntry[], cursor: SessionCursor): Usage {
  const usage = emptyUsage();
  // Billing is independent from branch display. Every finalized new assistant
  // entry incurred model work, even when its branch is not the active report path.
  for (const entry of authoritativeAssistantEntries(entries, cursor)) addUsage(usage, entry.message?.usage);
  return usage;
}

function resultEvidence(entries: SessionEntry[], allEntries: SessionEntry[], cursor: SessionCursor, exitStatus?: ExitStatus): { usage: Usage; report: string; outcome: RunOutcome; errorMessage?: string } {
  const usage = sumAssistantUsage(allEntries, cursor);
  const assistant: Array<{ message: Record<string, unknown>; text: string }> = [];
  for (const entry of authoritativeAssistantEntries(entries, cursor)) {
    assistant.push({ message: entry.message!, text: textFromContent(entry.message!.content).trim() });
  }

  const texts = assistant.map((item) => item.text).filter(Boolean);
  let report = FALLBACK_REPORT;
  if (texts.length > 0) {
    const last = texts[texts.length - 1];
    report = last.length >= SHORT_REPORT_CHARS ? last : texts.slice(-3).join("\n\n");
  }

  let outcome: RunOutcome = "success";
  let errorMessage: string | undefined;
  const lastAssistant = [...assistant].reverse().find((item) => item.message.stopReason !== "toolUse")?.message;
  if (lastAssistant?.stopReason === "aborted") {
    outcome = "aborted";
    errorMessage = typeof lastAssistant.errorMessage === "string" ? lastAssistant.errorMessage : "Sidekick run was aborted";
  } else if (lastAssistant?.stopReason === "error" || typeof lastAssistant?.errorMessage === "string" || typeof lastAssistant?.providerError === "string") {
    outcome = "error";
    errorMessage = typeof lastAssistant.errorMessage === "string" && lastAssistant.errorMessage.trim()
      ? lastAssistant.errorMessage
      : typeof lastAssistant.providerError === "string" && lastAssistant.providerError.trim()
        ? lastAssistant.providerError
        : "Sidekick provider returned an error";
  }
  if (exitStatus?.error) {
    outcome = "error";
    errorMessage = exitStatus.error;
  } else if (exitStatus && exitStatus.exitCode !== null && exitStatus.exitCode !== 0) {
    if (exitStatus.exitCode === 130 || exitStatus.exitCode === 143) {
      outcome = "aborted";
      errorMessage ??= "Sidekick run was aborted";
    } else {
      outcome = "error";
      errorMessage ??= `Sidekick process exited with code ${exitStatus.exitCode}`;
    }
  }
  return { usage, report, outcome, errorMessage };
}

function activeBranch(entries: SessionEntry[], cursor: SessionCursor): SessionEntry[] {
  const byId = validateTree({ type: "session", id: "synthetic" }, entries);
  const leaf = entries.length > 0 ? entries[entries.length - 1] : undefined;
  if (!leaf?.id) return [];
  const path: SessionEntry[] = [];
  const seen = new Set<string>();
  let current: SessionEntry | undefined = leaf;
  while (current) {
    if (!current.id || seen.has(current.id)) throw new SessionIntegrityError("Session entry tree contains a cycle");
    seen.add(current.id);
    path.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  path.reverse();
  if (cursor.lastEntryId && !path.some((entry) => entry.id === cursor.lastEntryId)) {
    throw new SessionIntegrityError(`Session active branch does not continue cursor entry ${cursor.lastEntryId}`);
  }
  return path;
}

function parseResult(buffer: Buffer, cursor: SessionCursor, exitStatus?: ExitStatus, allowPartialTail = false): RunResult {
  const parsed = parseComplete(buffer, allowPartialTail);
  if (!parsed.header.id) throw new SessionIntegrityError("Session header is incomplete");
  const byId = validateTree(parsed.header, parsed.entries);
  const boundary = cursor.byteOffset === parsed.headerEnd
    ? undefined
    : cursor.byteOffset > parsed.headerEnd
      ? [...parsed.entries].find((entry) => entry.endOffset === cursor.byteOffset)
      : undefined;
  if (cursor.byteOffset > 0 && cursor.byteOffset !== parsed.headerEnd && !boundary) {
    throw new SessionIntegrityError(`Session cursor byte offset ${cursor.byteOffset} is not at a complete entry boundary`);
  }
  if (cursor.lastEntryId && (!boundary || boundary.id !== cursor.lastEntryId)) {
    throw new SessionIntegrityError("Session cursor entry does not match the file prefix");
  }
  if (cursor.sessionId && cursor.sessionId !== parsed.header.id) throw new SessionIntegrityError("Session header identity changed");
  // Keep this lookup explicit. It also makes a cursor with a deleted entry fail clearly.
  if (cursor.lastEntryId && !byId.has(cursor.lastEntryId)) throw new SessionIntegrityError("Session cursor entry is missing");

  const branch = activeBranch(parsed.entries, cursor);
  const evidence = resultEvidence(branch, parsed.entries, cursor, exitStatus);
  const finalEntry = parsed.entries.length ? parsed.entries[parsed.entries.length - 1] : undefined;
  const nextCursor: SessionCursor = {
    byteOffset: parsed.completeBytes,
    lastEntryId: finalEntry?.id,
    sessionId: parsed.header.id as string,
    prefixHash: hashPrefix(buffer, parsed.completeBytes),
  };
  // The caller validates file identity and adds it to the cursor. Keep parser pure here.
  return { ...evidence, partialTail: parsed.partialTail, cursor: nextCursor };
}

function checkCursor(buffer: Buffer, stat: fs.Stats, cursor: SessionCursor): void {
  if (!Number.isInteger(cursor.byteOffset) || cursor.byteOffset < 0) throw new SessionIntegrityError("Session cursor has an invalid byte offset");
  if (buffer.length < cursor.byteOffset) throw new SessionIntegrityError("Session file was truncated before the stored cursor");
  if (cursor.fileIdentity && !sameIdentity(cursor.fileIdentity, statIdentity(stat))) throw new SessionIntegrityError("Session file was replaced before the stored cursor");
  if (cursor.prefixHash && hashPrefix(buffer, cursor.byteOffset) !== cursor.prefixHash) throw new SessionIntegrityError("Session file prefix was rewritten before the stored cursor");
}

function readSnapshot(file: string, cursor: SessionCursor): { buffer: Buffer; stat: fs.Stats } {
  let stat: fs.Stats;
  try { stat = fs.statSync(file); } catch (error) { throw new SessionIntegrityError(`Cannot read session file: ${error instanceof Error ? error.message : String(error)}`); }
  if (!stat.isFile()) throw new SessionIntegrityError("Session path is not a regular file");
  const buffer = fs.readFileSync(file);
  checkCursor(buffer, stat, cursor);
  return { buffer, stat };
}

export function createSessionCursor(file: string): SessionCursor {
  if (!fs.existsSync(file)) return { byteOffset: 0 };
  const snapshot = readSnapshot(file, { byteOffset: 0 });
  const parsed = parseComplete(snapshot.buffer, false);
  const header = parsed.header;
  const last = parsed.entries[parsed.entries.length - 1];
  return {
    byteOffset: parsed.completeBytes,
    lastEntryId: last?.id,
    sessionId: typeof header.id === "string" ? header.id : undefined,
    fileIdentity: statIdentity(snapshot.stat),
    prefixHash: hashPrefix(snapshot.buffer, parsed.completeBytes),
  };
}

export const captureSessionCursor = createSessionCursor;

/** Validate that a saved run cursor still points into the same session prefix. */
export function validateSessionCursor(file: string, cursor: SessionCursor): void {
  const snapshot = readSnapshot(file, cursor);
  const parsed = parseComplete(snapshot.buffer, false);
  if (cursor.sessionId && parsed.header.id !== cursor.sessionId) throw new SessionIntegrityError("Session header identity changed");
  if (cursor.lastEntryId && !parsed.entries.some(entry => entry.id === cursor.lastEntryId)) {
    throw new SessionIntegrityError("Session cursor entry is missing");
  }
}

async function processHasExited(options: ReadRunOptions): Promise<boolean> {
  if (options.processExited !== undefined) return options.processExited;
  if (options.isProcessAlive) return !(await options.isProcessAlive());
  return true;
}

function attachEvidence(error: SessionIntegrityError, file: string, cursor: SessionCursor, exitStatus?: ExitStatus): SessionIntegrityError {
  if (error.partialUsage) return error;
  try {
    const stat = fs.statSync(file);
    const bytes = fs.readFileSync(file);
    checkCursor(bytes, stat, cursor);
    let lastEvidence: RunResult | undefined;
    let offset = 0;
    while (offset < bytes.length) {
      const newline = bytes.indexOf(0x0a, offset);
      if (newline < 0) break;
      try {
        lastEvidence = parseResult(bytes.subarray(0, newline + 1), cursor, exitStatus, false);
      } catch {
        // Keep the last complete, structurally valid prefix before the bad line.
      }
      offset = newline + 1;
    }
    if (!lastEvidence) return error;
    return new SessionIntegrityError(error.message, { usage: lastEvidence.usage, report: lastEvidence.report, outcome: lastEvidence.outcome });
  } catch {
    return error;
  }
}

export async function readRunResult(file: string, cursor: SessionCursor, options: ReadRunOptions = {}): Promise<RunResult> {
  const timeout = Math.max(1, options.stabilityTimeoutMs ?? 1_000);
  const interval = Math.max(1, options.probeIntervalMs ?? 10);
  const deadline = Date.now() + timeout;
  let previousSignature: string | undefined;
  let lastError: unknown;
  while (Date.now() <= deadline) {
    if (options.signal?.aborted) throw new SessionIntegrityError("Session result read was aborted");
    try {
      const first = readSnapshot(file, cursor);
      const second = readSnapshot(file, cursor);
      const signature = `${second.stat.dev}:${second.stat.ino}:${second.stat.size}:${second.stat.mtimeMs}`;
      if (first.stat.size !== second.stat.size || first.stat.mtimeMs !== second.stat.mtimeMs || !sameIdentity(statIdentity(first.stat), statIdentity(second.stat))) {
        previousSignature = undefined;
      } else if (signature === previousSignature) {
        let exited: boolean;
        try {
          exited = await processHasExited(options);
        } catch (error) {
          throw new SessionIntegrityError(`Process state probe failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        try {
          const result = parseResult(second.buffer, cursor, options.exitStatus, !exited);
          result.cursor.fileIdentity = statIdentity(second.stat);
          result.cursor.prefixHash = hashPrefix(second.buffer, result.cursor.byteOffset);
          return result;
        } catch (error) {
          lastError = error;
          if (error instanceof SessionIntegrityError && /incomplete JSONL line/.test(error.message) && !exited) {
            const partial = parseResult(second.buffer, cursor, options.exitStatus, true);
            partial.cursor.fileIdentity = statIdentity(second.stat);
            partial.cursor.prefixHash = hashPrefix(second.buffer, partial.cursor.byteOffset);
            return partial;
          }
          if (!(error instanceof SessionIntegrityError) || !/incomplete JSONL line/.test(error.message)) throw error;
        }
      }
      previousSignature = signature;
    } catch (error) {
      lastError = error;
      if (error instanceof SessionIntegrityError && !/Cannot read session file/.test(error.message)) {
        throw attachEvidence(error, file, cursor, options.exitStatus);
      }
    }
    await sleep(Math.min(interval, Math.max(1, deadline - Date.now())));
  }
  if (lastError instanceof SessionIntegrityError) throw attachEvidence(lastError, file, cursor, options.exitStatus);
  throw new SessionIntegrityError(`Session file did not become stable within ${timeout}ms`);
}

export const readIncrementalResult = readRunResult;
