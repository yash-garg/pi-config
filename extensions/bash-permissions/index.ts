/**
 * Bash Permissions Extension
 *
 * Intercepts bash tool calls and blocks commands that match any pattern
 * listed in `bashPermissions.banned` inside settings.json.
 *
 * Configuration (global ~/.pi/agent/settings.json or project .pi/settings.json):
 *
 *   {
 *     "bashPermissions": {
 *       "banned": [
 *         "cat",               // bans `cat` in any form
 *         ["git", "push"],     // bans `git push …` but not `git remote -v`
 *         { "pattern": "cat", "reason": "Prefer using the read tool over running cat on files" },
 *         { "pattern": ["git", "push"], "reason": "Open a PR instead of pushing directly." }
 *       ]
 *     }
 *   }
 *
 * Each entry is either:
 *   - a string  → shorthand for a single-token pattern
 *   - string[]  → prefix-match: every token in the array must match the
 *                 corresponding leading token of the extracted command
 *   - { pattern: string | string[], reason: string }
 *               → same matching as above, but the `reason` string completely
 *                 replaces the default block message shown to the agent
 *
 * Bans are read exclusively from the global settings file — see
 * `loadBannedPatterns` for the security rationale.
 *
 * Commands are extracted via a tree-sitter bash parser so every sub-command
 * is checked regardless of how deeply nested it is — pipelines, sequences,
 * subshells, command substitutions, if/while/for bodies, function definitions,
 * and process substitutions are all covered.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const _require = createRequire(import.meta.url);

// ── Types ─────────────────────────────────────────────────────────────────────

type BannedPattern = string[]; // always normalised to an array

interface BannedEntry {
  pattern: BannedPattern;
  reason?: string;
}

type ConfigEntry = string | string[] | { pattern: string | string[]; reason: string };

interface BashPermissionsConfig {
  banned?: Array<ConfigEntry>;
}

/**
 * Commands that wrap another command and whose presence should be ignored when
 * identifying the effective command name (e.g. `sudo git push` → `git push`).
 */
const TRANSPARENT_WRAPPERS = new Set([
  "sudo", "env", "nice", "nohup", "time", "watch", "xargs", "doas",
]);

/**
 * Matches a combined POSIX short-flag token like `-rn` or `-En`.
 * Does NOT match single-char flags (`-i`), long flags (`--force`), or
 * tokens containing digits or other non-letter characters.
 */
const COMBINED_SHORT_FLAG_RE = /^-[a-zA-Z]{2,}$/;

/**
 * Given raw tokens for one segment, skip leading transparent wrapper commands
 * and env-var assignments, returning the effective command tokens.
 *
 * e.g. ["sudo", "GIT_SSH=…", "git", "push"] → ["git", "push"]
 */
function stripPrefixes(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length) {
    if (TRANSPARENT_WRAPPERS.has(tokens[i]!)) {
      i++;
    } else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) {
      i++;
    } else {
      break;
    }
  }
  return tokens.slice(i);
}

/**
 * Push `tok` into `out`, expanding combined short flags: `-rn` → `-r`, `-n`.
 * Does not expand `--long` flags or single-char flags like `-i`.
 *
 * Note: flags that consume a positional argument (e.g. `-f archive.tar` from
 * `-czf archive.tar`) are separated from their argument after expansion —
 * the argument becomes a plain freestanding token. This does not affect
 * current ban rules but is worth keeping in mind when authoring patterns.
 */
function expandToken(tok: string, out: string[]): void {
  if (COMBINED_SHORT_FLAG_RE.test(tok)) {
    for (const ch of tok.slice(1)) out.push(`-${ch}`);
  } else {
    out.push(tok);
  }
}

/**
 * Extract the effective command token array from a single tree-sitter
 * `command` node. Returns tokens ready for `stripPrefixes` + `matchesPattern`.
 *
 * - Command name: the `word` child of the `"name"` field. If the
 *   command name is not a plain word (e.g. `$(expr)` as the command name),
 *   returns an empty array — the inner command is found by the recursive walker.
 * - Arguments: only `word`-typed `argument` field children. `string`,
 *   `raw_string`, `process_substitution`, etc. are skipped; they are either
 *   data values or will be picked up by the recursive walker independently.
 * - Combined short flags (`-rn`) are expanded via `expandToken`.
 */
function tokensFromCommand(node: any): string[] {
  const tokens: string[] = [];

  const nameNode = node.childForFieldName("name");
  if (nameNode) {
    const nameWord = nameNode.child(0);
    if (nameWord?.type === "word") {
      expandToken(nameWord.text, tokens);
    }
  }
  if (tokens.length === 0) return []; // non-word command name — skip

  for (let i = 0; i < node.childCount; i++) {
    if (node.fieldNameForChild(i) === "argument") {
      const child = node.child(i);
      if (child.type === "word") {
        expandToken(child.text, tokens);
      }
    }
  }

  return tokens;
}

/**
 * Walk every node in the tree-sitter parse tree for `command`.
 * At each `command` node, extract tokens and apply transparent-wrapper
 * stripping, then add to results. Always recurse into all children so that
 * commands inside subshells, command substitutions, if/while/for bodies,
 * function definitions, and process substitutions are all checked.
 */
function extractCommandsFromTree(command: string): string[][] {
  if (!_parser) return [];
  const tree = (_parser as any).parse(command);
  const results: string[][] = [];

  const queue: any[] = [tree.rootNode];
  while (queue.length > 0) {
    const node = queue.pop()!;
    if (node.type === "command") {
      const tokens = tokensFromCommand(node);
      const stripped = stripPrefixes(tokens);
      if (stripped.length > 0) results.push(stripped);
    }
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) queue.push(child);
    }
  }
  return results;
}

// ── Pattern matching ──────────────────────────────────────────────────────────

/**
 * Returns true when `tokens` starts with `pattern[0]` and every subsequent
 * pattern token appears as an ordered subsequence in the remaining tokens.
 *
 * Subsequence matching (rather than strict prefix) means flags and arguments
 * between the command name and subcommand are tolerated:
 *
 *   ["git", "push"] matches  git push origin main
 *   ["git", "push"] matches  git -C /repo push --force
 *   ["git", "push"] no-match git remote -v
 *   ["git", "push"] no-match git pull
 *   ["cat"]         matches  cat README.md  (single-token pattern, exact)
 */
function matchesPattern(tokens: string[], pattern: BannedPattern): boolean {
  if (tokens.length === 0 || pattern.length === 0) return false;
  if (tokens[0] !== pattern[0]) return false;
  if (pattern.length === 1) return true;

  let patternIdx = 1;
  for (let i = 1; i < tokens.length && patternIdx < pattern.length; i++) {
    if (tokens[i] === pattern[patternIdx]) {
      patternIdx++;
    }
  }
  return patternIdx >= pattern.length;
}

/**
 * Find the first violation in the command string.
 * Returns the matched tokens and the pattern that triggered, or null.
 */
function findViolation(
  command: string,
  banned: BannedEntry[],
): { tokens: string[]; entry: BannedEntry } | null {
  if (banned.length === 0) return null;
  for (const tokens of extractCommandsFromTree(command)) {
    for (const entry of banned) {
      if (matchesPattern(tokens, entry.pattern)) {
        return { tokens, entry };
      }
    }
  }
  return null;
}

// ── Tree-sitter parser ────────────────────────────────────────────────────────

let _parser: unknown = null;
let _parserFailed: string | null = null;
let _parserInitialised = false;

/**
 * Initialise the tree-sitter bash parser.
 *
 * - If `banned` is empty: no-op. No security boundary is configured so a
 *   parser failure would be non-fatal noise.
 * - If `banned` is non-empty: load the WASM runtime and bash grammar. On
 *   failure, sets `_parserFailed` so the `tool_call` handler can block all
 *   bash calls with a clear error rather than silently passing commands through.
 */
async function initParser(banned: BannedEntry[]): Promise<void> {
  if (banned.length === 0) {
    _parser = null;
    _parserFailed = null;
    return;
  }

  try {
    const { Parser, Language } = _require("web-tree-sitter") as {
      Parser: {
        init(): Promise<void>;
        new (): { setLanguage(lang: unknown): void; parse(src: string): unknown };
      };
      Language: { load(path: string): Promise<unknown> };
    };
    if (!_parserInitialised) {
      await Parser.init();
      _parserInitialised = true;
    }
    const wasmPath = _require.resolve("tree-sitter-bash/tree-sitter-bash.wasm");
    const bash = await Language.load(wasmPath);
    const p = new Parser();
    p.setLanguage(bash);
    // Swap atomically: only update state once the new parser is ready.
    _parser = p;
    _parserFailed = null;
  } catch (e) {
    _parserFailed = e instanceof Error ? e.message : String(e);
    // Leave _parser as-is so any previously working parser stays active.
  }
}

// ── Settings loading ──────────────────────────────────────────────────────────

function normalise(entry: ConfigEntry): BannedEntry {
  if (typeof entry === "string") return { pattern: [entry] };
  if (Array.isArray(entry)) return { pattern: entry };
  const pattern = typeof entry.pattern === "string" ? [entry.pattern] : entry.pattern;
  return { pattern, reason: entry.reason };
}

/**
 * Read `bashPermissions.banned` from a single settings file.
 * Returns an empty array if the file is missing or the key is absent.
 */
async function readBannedFromFile(path: string): Promise<BannedEntry[]> {
  try {
    const raw = await readFile(path, "utf8");
    const settings = JSON.parse(raw) as {
      bashPermissions?: BashPermissionsConfig;
    };
    return (settings.bashPermissions?.banned ?? []).map(normalise);
  } catch {
    return [];
  }
}

/**
 * Load all banned patterns from the global pi agent settings file only.
 *
 * Project-level settings (.pi/settings.json) are intentionally not read.
 * The ban list is a security control: allowing per-project overrides would let
 * a malicious or misconfigured project weaken operator-defined policy. Only
 * the global settings file (~/.pi/agent/settings.json, or the directory set
 * by PI_CODING_AGENT_DIR) is authoritative for this extension.
 */
async function loadBannedPatterns(): Promise<BannedEntry[]> {
  const agentDir =
    process.env["PI_CODING_AGENT_DIR"] ?? join(homedir(), ".pi", "agent");
  return readBannedFromFile(join(agentDir, "settings.json"));
}

// ── Extension ─────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let banned: BannedEntry[] = [];

  async function reload() {
    banned = await loadBannedPatterns();
    await initParser(banned);
  }

  pi.on("session_start", async () => {
    await reload();
  });

  // Re-read config whenever the user runs /reload
  pi.on("resources_discover", async () => {
    await reload();
  });

  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash") return;

    if (_parserFailed !== null) {
      return {
        block: true,
        reason:
          `bash is disabled: security layer failed to initialise — ${_parserFailed}.\n` +
          `Fix the extension or clear the ban list, then run /reload.`,
      };
    }

    const command = (event.input as { command: string }).command;
    const violation = findViolation(command, banned);
    if (!violation) return;

    if (violation.entry.reason) {
      return { block: true, reason: violation.entry.reason };
    }

    const patternStr = JSON.stringify(violation.entry.pattern);
    const matchedStr = violation.tokens.join(" ");

    return {
      block: true,
      reason:
        `bash: command blocked by permissions policy.\n` +
        `Banned pattern: ${patternStr}\n` +
        `Matched command: ${matchedStr}\n` +
        `Do not retry commands matching this pattern. ` +
        `Inform the user and suggest an alternative that avoids it, ` +
        `or ask the user to run the command manually outside of pi.`,
    };
  });
}
