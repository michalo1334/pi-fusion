export const RECURSIVE_FUSION_TOOLS = new Set(["delegate", "follow_up"]);
export const RECURSIVE_FUSION_EXTENSIONS = new Set(["fusion", "pi-fusion", "michalo-pi-fusion", "@michalo1334/pi-fusion"]);

export function assertNoRecursiveFusionTools(tools: readonly string[]): void {
  const forbidden = tools.filter((tool) => RECURSIVE_FUSION_TOOLS.has(tool));
  if (forbidden.length > 0) {
    throw new Error(`Fusion sidekicks cannot call recursive Fusion tools: ${forbidden.join(", ")}`);
  }
}

export function assertNoRecursiveFusionExtensions(extensionIds: readonly string[]): void {
  const forbidden = extensionIds.filter((extension) => RECURSIVE_FUSION_EXTENSIONS.has(extension));
  if (forbidden.length > 0) {
    throw new Error(`Fusion sidekicks cannot load the Fusion extension: ${forbidden.join(", ")}`);
  }
}
