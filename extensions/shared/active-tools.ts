import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function enableTools(pi: ExtensionAPI, tools: string[]): void {
  const active = pi.getActiveTools();
  pi.setActiveTools([...new Set([...active, ...tools])]);
}
