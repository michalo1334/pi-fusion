import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TestCleanup {
  after(cleanup: () => void): void;
}

/** Create a temporary test root and remove it after the current test. */
export function tempRoot(t: TestCleanup, prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), `${prefix}-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
