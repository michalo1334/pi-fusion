import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

export interface ChildSessionSeed {
  parentSessionFile: string;
  childCwd: string;
  sessionDir: string;
  childSessionId: string;
}

function regularSessionFile(file: string, label: string): void {
  let stat: fs.Stats;
  try {
    const link = fs.lstatSync(file);
    if (link.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
    stat = fs.statSync(file);
  } catch (error) {
    throw new Error(`Cannot use ${label} ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!stat.isFile()) throw new Error(`${label} must be a regular file: ${file}`);
}

export const MAX_SESSION_HEADER_BYTES = 64 * 1024;
const HEADER_READ_CHUNK_BYTES = 4096;

function readHeaderLine(file: string): string {
  const fd = fs.openSync(file, "r");
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (total < MAX_SESSION_HEADER_BYTES) {
      const chunk = Buffer.allocUnsafe(Math.min(HEADER_READ_CHUNK_BYTES, MAX_SESSION_HEADER_BYTES - total));
      const count = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      const newline = chunk.subarray(0, count).indexOf(0x0a);
      if (newline >= 0) {
        chunks.push(chunk.subarray(0, newline + 1));
        return Buffer.concat(chunks).toString("utf8").slice(0, -1).replace(/\r$/, "");
      }
      chunks.push(chunk.subarray(0, count));
      total += count;
    }
  } finally {
    fs.closeSync(fd);
  }
  if (total >= MAX_SESSION_HEADER_BYTES) {
    throw new Error(`Session header exceeds ${MAX_SESSION_HEADER_BYTES} bytes: ${file}`);
  }
  throw new Error(`Session header is incomplete: ${file}`);
}

function readHeader(file: string): Record<string, unknown> {
  regularSessionFile(file, "session file");
  const line = readHeaderLine(file);
  if (!line.trim()) throw new Error(`Session file has no header: ${file}`);
  let value: unknown;
  try { value = JSON.parse(line); }
  catch (error) { throw new Error(`Session header is not valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  if (!value || typeof value !== "object" || Array.isArray(value) || (value as Record<string, unknown>).type !== "session") {
    throw new Error(`Session file does not start with a valid session header: ${file}`);
  }
  const header = value as Record<string, unknown>;
  if (typeof header.id !== "string" || !header.id) throw new Error(`Session header has no valid id: ${file}`);
  return header;
}

function writeHeaderExclusively(file: string, header: Record<string, unknown>): void {
  const directory = path.dirname(file);
  const directoryStat = fs.lstatSync(directory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new Error(`Child session directory must be a real directory: ${directory}`);
  }
  let fd: number;
  try {
    fd = fs.openSync(file, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Child session file already exists: ${file}`);
    }
    throw error;
  }
  try {
    fs.writeFileSync(fd, `${JSON.stringify(header)}\n`, { encoding: "utf8" });
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(file, 0o600);
}

/**
 * Create the child header before Pi starts. This keeps lineage separate from
 * conversation history and gives the child CLI one exact session file.
 */
export function seedChildSessionFile(params: ChildSessionSeed): string {
  const parentFile = path.resolve(params.parentSessionFile);
  const sessionDir = path.resolve(params.sessionDir);
  const sessionDirStat = fs.lstatSync(sessionDir);
  if (sessionDirStat.isSymbolicLink() || !sessionDirStat.isDirectory()) {
    throw new Error(`Lead session directory must be a real directory: ${sessionDir}`);
  }
  const parentHeader = readHeader(parentFile);
  if (path.dirname(parentFile) !== sessionDir) {
    throw new Error(`Parent session file must be in the lead session directory: ${parentFile}`);
  }
  const manager = SessionManager.create(params.childCwd, sessionDir, {
    id: params.childSessionId,
    parentSession: parentFile,
  });
  const childFile = manager.getSessionFile();
  const header = manager.getHeader();
  if (!childFile || !header) throw new Error("SessionManager did not provide a child session header");
  if (header.parentSession !== parentFile || header.id !== params.childSessionId) {
    throw new Error("SessionManager returned an unexpected child session lineage");
  }
  if (parentHeader.type !== "session") throw new Error("Lead session header is invalid");
  writeHeaderExclusively(childFile, header as unknown as Record<string, unknown>);
  validateChildSessionLineage(childFile, params.childSessionId, parentFile);
  return childFile;
}

/** Validate the exact child file and stable ID. */
export function validateChildSessionIdentity(childFile: string, childSessionId: string): void {
  const childHeader = readHeader(childFile);
  if (childHeader.id !== childSessionId) throw new Error(`Child session identity changed: expected ${childSessionId}`);
}

/** Validate the exact child file, stable ID, and cross-file parent pointer. */
export function validateChildSessionLineage(childFile: string, childSessionId: string, parentSessionFile: string): void {
  const childHeader = readHeader(childFile);
  const expectedParent = path.resolve(parentSessionFile);
  if (childHeader.id !== childSessionId) throw new Error(`Child session identity changed: expected ${childSessionId}`);
  if (childHeader.parentSession !== expectedParent) {
    throw new Error(`Child session parentSession changed: expected ${expectedParent}`);
  }
  regularSessionFile(expectedParent, "parent session file");
  const parentHeader = readHeader(expectedParent);
  if (parentHeader.type !== "session") throw new Error(`Parent session header is invalid: ${expectedParent}`);
}
