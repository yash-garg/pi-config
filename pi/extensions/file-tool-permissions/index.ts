/**
 * File Tool Permissions Extension
 *
 * Intercepts read, write, and edit tool calls and applies path rules from
 * `fileToolPermissions` inside settings.json.
 *
 * Configuration (global ~/.pi/agent/settings.json or project .pi/settings.json):
 *
 *   {
 *     "fileToolPermissions": {
 *       "read": {
 *         "banned": [
 *           ".env",
 *           { "pattern": "secrets/*", "action": "deny", "reason": "Do not read secret material." }
 *         ]
 *       },
 *       "write": {
 *         "banned": [
 *           ".git/**",
 *           { "pattern": "pi/settings.json", "action": "prompt", "reason": "Editing settings is sensitive. Confirm first." }
 *         ]
 *       }
 *     }
 *   }
 *
 * `write.banned` is shared by both write and edit. Each entry is either:
 *   - a string  → shorthand for a deny rule on a glob pattern
 *   - { pattern: string, reason?: string, action?: "deny" | "prompt" }
 *               → same matching as above, with optional custom messaging and
 *                 confirmation-before-allow behavior
 *
 * Rules are read exclusively from the global settings file — see
 * `loadPermissions` for the security rationale.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, matchesGlob, normalize, relative, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

type ConfigEntry = string | {
  pattern: string;
  reason?: string;
  action?: "deny" | "prompt";
};

interface PermissionEntry {
  pattern: string;
  reason?: string;
  action?: "deny" | "prompt";
}

interface ToolPermissionsConfig {
  banned?: ConfigEntry[];
}

interface FileToolPermissionsConfig {
  read?: ToolPermissionsConfig;
  write?: ToolPermissionsConfig;
}

interface LoadedPermissions {
  read: PermissionEntry[];
  write: PermissionEntry[];
}

function normalise(entry: ConfigEntry): PermissionEntry {
  if (typeof entry === "string") return { pattern: entry, action: "deny" };
  return { ...entry, action: entry.action ?? "deny" };
}

async function readPermissionsFromFile(path: string): Promise<LoadedPermissions> {
  try {
    const raw = await readFile(path, "utf8");
    const settings = JSON.parse(raw) as {
      fileToolPermissions?: FileToolPermissionsConfig;
    };
    return {
      read: (settings.fileToolPermissions?.read?.banned ?? []).map(normalise),
      write: (settings.fileToolPermissions?.write?.banned ?? []).map(normalise),
    };
  } catch {
    return { read: [], write: [] };
  }
}

/**
 * Load file permissions from the global pi agent settings file only.
 *
 * Project-level settings (.pi/settings.json) are intentionally not read.
 * The rules are a security control: allowing per-project overrides would let
 * a malicious or misconfigured project weaken operator-defined policy. Only
 * the global settings file (~/.pi/agent/settings.json, or the directory set
 * by PI_CODING_AGENT_DIR) is authoritative for this extension.
 */
async function loadPermissions(): Promise<LoadedPermissions> {
  const agentDir =
    process.env["PI_CODING_AGENT_DIR"] ?? join(homedir(), ".pi", "agent");
  return readPermissionsFromFile(join(agentDir, "settings.json"));
}

function candidatePaths(inputPath: string): string[] {
  const absolutePath = normalize(isAbsolute(inputPath) ? inputPath : resolve(process.cwd(), inputPath));
  const candidates = new Set<string>([
    inputPath,
    normalize(inputPath),
    absolutePath,
  ]);

  const relativePath = relative(process.cwd(), absolutePath);
  if (relativePath !== "" && !relativePath.startsWith(`..${sep}`) && relativePath !== "..") {
    candidates.add(relativePath);
    candidates.add(relativePath.split(sep).join("/"));
  }

  candidates.add(absolutePath.split(sep).join("/"));
  return [...candidates];
}

function findViolation(path: string, entries: PermissionEntry[]): PermissionEntry | null {
  if (entries.length === 0) return null;
  const candidates = candidatePaths(path);
  for (const entry of entries) {
    if (candidates.some((candidate) => matchesGlob(candidate, entry.pattern))) {
      return entry;
    }
  }
  return null;
}

function blockReason(toolName: "read" | "write" | "edit", path: string, violation: PermissionEntry): string {
  if (violation.reason && violation.action !== "prompt") return violation.reason;
  return (
    `${toolName}: file blocked by permissions policy.\n` +
    `Banned pattern: ${JSON.stringify(violation.pattern)}\n` +
    `Path: ${path}\n` +
    `Do not retry this ${toolName} call against matching files. ` +
    `Inform the user and ask for a different target path or manual intervention.`
  );
}

function promptMessage(toolName: "read" | "write" | "edit", path: string, violation: PermissionEntry): string {
  const lines = [
    `Tool: ${toolName}`,
    `Path: ${path}`,
    `Matched pattern: ${JSON.stringify(violation.pattern)}`,
  ];
  if (violation.reason) lines.push(`Reason: ${violation.reason}`);
  lines.push("Allow this tool call?");
  return lines.join("\n");
}

async function handleViolation(
  toolName: "read" | "write" | "edit",
  path: string,
  violation: PermissionEntry | null,
  ctx?: { hasUI: boolean; ui: { confirm(title: string, message: string): Promise<boolean> } },
): Promise<{ block: true; reason: string } | undefined> {
  if (!violation) return;

  if (violation.action !== "prompt") {
    return { block: true, reason: blockReason(toolName, path, violation) };
  }

  if (!ctx?.hasUI) {
    return {
      block: true,
      reason:
        `${toolName}: file requires interactive approval before access.\n` +
        `Banned pattern: ${JSON.stringify(violation.pattern)}\n` +
        `Path: ${path}` +
        (violation.reason ? `\nReason: ${violation.reason}` : "") +
        `\nRe-run this in a UI-capable session to approve the access.`,
    };
  }

  const confirmed = await ctx.ui.confirm(
    "File access requires approval",
    promptMessage(toolName, path, violation),
  );
  if (confirmed) return;

  return {
    block: true,
    reason:
      `${toolName}: access rejected in approval dialog.\n` +
      `Path: ${path}` +
      (violation.reason ? `\nReason: ${violation.reason}` : ""),
  };
}

export default function (pi: ExtensionAPI) {
  let permissions: LoadedPermissions = { read: [], write: [] };

  async function reload() {
    permissions = await loadPermissions();
  }

  pi.on("session_start", async () => {
    await reload();
  });

  pi.on("resources_discover", async () => {
    await reload();
  });

  pi.on("tool_call", async (event, ctx) => {
    if (isToolCallEventType("read", event)) {
      return handleViolation(
        "read",
        event.input.path,
        findViolation(event.input.path, permissions.read),
        ctx,
      );
    }

    if (isToolCallEventType("write", event)) {
      return handleViolation(
        "write",
        event.input.path,
        findViolation(event.input.path, permissions.write),
        ctx,
      );
    }

    if (isToolCallEventType("edit", event)) {
      return handleViolation(
        "edit",
        event.input.path,
        findViolation(event.input.path, permissions.write),
        ctx,
      );
    }
  });
}
