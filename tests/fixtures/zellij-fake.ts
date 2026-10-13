import type {
  CreateSurfaceInput,
  RetainedSurfaceCloseInput,
  ZellijOperations,
  ZellijSurface,
} from "../../extensions/zellij.ts";

export interface ZellijFakeCalls {
  createSurface: CreateSurfaceInput[];
  closeRetainedSurface: RetainedSurfaceCloseInput[];
  interrupt: ZellijSurface[];
  close: ZellijSurface[];
  paneExists: ZellijSurface[];
}

export interface ZellijFake {
  operations: ZellijOperations;
  calls: ZellijFakeCalls;
}

function unexpected(name: keyof ZellijOperations): never {
  throw new Error(`Unexpected Zellij operation in test: ${name}`);
}

/**
 * Create a fail-fast Zellij test double.
 *
 * Each test must provide the operations that its behavior can call. An omitted
 * operation fails instead of silently hiding a new production interaction.
 */
export function createZellijFake(overrides: Partial<ZellijOperations> = {}): ZellijFake {
  const calls: ZellijFakeCalls = {
    createSurface: [],
    closeRetainedSurface: [],
    interrupt: [],
    close: [],
    paneExists: [],
  };

  const operations: ZellijOperations = {
    async createSurface(input) {
      calls.createSurface.push(input);
      return overrides.createSurface ? overrides.createSurface(input) : unexpected("createSurface");
    },
    async closeRetainedSurface(input) {
      calls.closeRetainedSurface.push(input);
      return overrides.closeRetainedSurface
        ? overrides.closeRetainedSurface(input)
        : unexpected("closeRetainedSurface");
    },
    async interrupt(surface) {
      calls.interrupt.push(surface);
      return overrides.interrupt ? overrides.interrupt(surface) : unexpected("interrupt");
    },
    async close(surface) {
      calls.close.push(surface);
      return overrides.close ? overrides.close(surface) : unexpected("close");
    },
    async paneExists(surface) {
      calls.paneExists.push(surface);
      return overrides.paneExists ? overrides.paneExists(surface) : unexpected("paneExists");
    },
  };

  return { operations, calls };
}
