/**
 * Undo Extension
 *
 * /undo removes the last user prompt and everything the LLM did in response
 * (assistant turns, tool calls, tool results) from the active session branch,
 * reverts any files changed by `write` or `edit` tool calls during that
 * response, then restores the prompt text into the editor so it can be edited
 * and re-sent.
 *
 * Reversion strategy:
 *
 *   write – scan backwards through earlier session history for the most recent
 *            prior `write` to the same path and restore that content; if none
 *            exists the file was created this turn and is deleted.
 *
 *   edit  – apply each edit call's hunks in reverse (swap oldText ↔ newText,
 *            process bottom-to-top within each call) and replay those reversed
 *            calls in reverse chronological order. Files that were also written
 *            in the same turn are skipped here — write reversion covers them.
 *
 * Empty session handling:
 *
 *   When the very first user message is undone there are no more user messages
 *   in the session. The undo still follows the same navigateTree + appendEntry
 *   path as a normal undo (navigating to the entry before the first user
 *   message, which is a model_change or thinking_level_change node). The
 *   now-empty session file is then marked for deletion and removed when
 *   session_shutdown fires with reason "quit" — i.e. when pi actually exits.
 *   This is made possible by the reason field added in pi 0.68.0.
 */

import { unlink, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Strip a leading @ that some models incorrectly prepend to path arguments. */
function sanitizePath(p: string): string {
  return p.startsWith("@") ? p.slice(1) : p;
}

function resolveToolPath(cwd: string, p: string): string {
  return resolve(cwd, sanitizePath(p));
}

/**
 * Replace the first occurrence of `search` in `text` with `replacement`.
 * Returns text unchanged when `search` is not found.
 */
function replaceFirst(text: string, search: string, replacement: string): string {
  const idx = text.indexOf(search);
  if (idx === -1) return text;
  return text.slice(0, idx) + replacement + text.slice(idx + search.length);
}

export default function (pi: ExtensionAPI) {
  // When /undo empties the last user message from a session, the now-empty
  // session file is scheduled here and deleted when pi actually exits.
  // We only act on reason "quit" (pi 0.68.0+): the session_shutdown async
  // handler is reliably awaited on graceful exit but not on session switches,
  // so other reasons are intentionally ignored.
  let sessionToDelete: string | null = null;

  pi.on("session_shutdown", async (event) => {
    if (event.reason === "quit" && sessionToDelete) {
      const file = sessionToDelete;
      sessionToDelete = null;
      try {
        await unlink(file);
      } catch {
        // file may already be gone — ignore
      }
    }
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    if (sessionToDelete === ctx.sessionManager.getSessionFile()) {
      // The user continued the session after undoing its first prompt; keep it.
      sessionToDelete = null;
    }
  });

  pi.registerCommand("undo", {
    description:
      "Remove the last prompt and response, revert write/edit changes, and restore the prompt to the editor",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();

      // getBranch() returns entries oldest-first (root → leaf).
      const branch = ctx.sessionManager.getBranch();

      // Walk backwards to find the most recent user message entry.
      let lastUserIdx = -1;
      for (let i = branch.length - 1; i >= 0; i--) {
        const entry = branch[i];
        if (entry.type === "message" && entry.message.role === "user") {
          lastUserIdx = i;
          break;
        }
      }

      if (lastUserIdx === -1) {
        ctx.ui.notify("Nothing to undo", "info");
        return;
      }

      const lastUserEntry = branch[lastUserIdx];

      // Split the branch into:
      //   undoneSegment – the user message and everything after it
      //   priorEntries  – everything that came before
      const undoneSegment = branch.slice(lastUserIdx);
      const priorEntries = branch.slice(0, lastUserIdx);

      // When parentId is null the user message is the very first entry in the
      // session — there is no earlier entry to navigate back to, so undoing it
      // empties the session entirely.
      //
      // However, pi prepends model_change and thinking_level_change entries
      // before the first user message, so parentId is never literally null.
      // The correct test is whether priorEntries contains any user message: if
      // not, undoing this prompt leaves the session with no user-visible content.
      const isFirstEntry = !priorEntries.some(
        (entry) => entry.type === "message" && entry.message.role === "user",
      );

      // ── Collect tool results to filter out failed calls ───────────────────

      const toolErrored = new Map<string, boolean>(); // toolCallId → isError
      for (const entry of undoneSegment) {
        if (entry.type === "message" && entry.message.role === "toolResult") {
          toolErrored.set(entry.message.toolCallId, entry.message.isError);
        }
      }

      // ── Collect successful write operations ───────────────────────────────

      const writtenPaths = new Set<string>();
      for (const entry of undoneSegment) {
        if (entry.type !== "message" || entry.message.role !== "assistant") continue;
        for (const block of entry.message.content) {
          if (block.type !== "toolCall" || block.name !== "write") continue;
          const args = block.arguments as { path?: string };
          if (!args.path || toolErrored.get(block.id) === true) continue;
          writtenPaths.add(resolveToolPath(ctx.cwd, args.path));
        }
      }

      // ── Collect successful edit operations ────────────────────────────────
      //
      // Only for files not already covered by a write — write reversion stores
      // complete content and supersedes any edits on the same file.

      interface EditCall {
        edits: Array<{ oldText: string; newText: string }>;
      }

      // Ordered list of edit calls per file, in chronological order.
      const editsByPath = new Map<string, EditCall[]>();

      for (const entry of undoneSegment) {
        if (entry.type !== "message" || entry.message.role !== "assistant") continue;
        for (const block of entry.message.content) {
          if (block.type !== "toolCall" || block.name !== "edit") continue;
          const args = block.arguments as {
            path?: string;
            edits?: Array<{ oldText: string; newText: string }>;
          };
          if (!args.path || !args.edits?.length) continue;
          if (toolErrored.get(block.id) === true) continue;
          const absPath = resolveToolPath(ctx.cwd, args.path);
          if (writtenPaths.has(absPath)) continue; // covered by write reversion
          const calls = editsByPath.get(absPath) ?? [];
          calls.push({ edits: args.edits });
          editsByPath.set(absPath, calls);
        }
      }

      // ── Find prior content for each written path ──────────────────────────
      //
      // Scan backwards through priorEntries for the most recent write to the
      // same path. Write call arguments always carry the full file content, so
      // this is a lossless source regardless of file size.
      //
      // When priorEntries is empty (isFirstEntry) there can be no prior write,
      // so every written file is treated as newly created and will be deleted.

      const priorContent = new Map<string, string | null>(); // null = file was new

      for (const absPath of writtenPaths) {
        let found: string | null = null;
        outer: for (let i = priorEntries.length - 1; i >= 0; i--) {
          const entry = priorEntries[i];
          if (entry.type !== "message" || entry.message.role !== "assistant") continue;
          for (const block of entry.message.content) {
            if (block.type !== "toolCall" || block.name !== "write") continue;
            const args = block.arguments as { path?: string; content?: string };
            if (!args.path || args.content === undefined) continue;
            if (resolveToolPath(ctx.cwd, args.path) === absPath) {
              found = args.content;
              break outer;
            }
          }
        }
        priorContent.set(absPath, found);
      }

      // ── Extract prompt text ───────────────────────────────────────────────

      const msg = lastUserEntry.message;
      let promptText = "";
      if (typeof msg.content === "string") {
        promptText = msg.content;
      } else {
        promptText = (msg.content as Array<{ type: string; text?: string }>)
          .filter((b) => b.type === "text" && typeof b.text === "string")
          .map((b) => b.text as string)
          .join("\n");
      }

      // ── Revert file changes ───────────────────────────────────────────────
      //
      // Done before any session navigation so that if navigation is cancelled
      // the files are at least consistent with the undone prompt being gone.

      const failed: string[] = [];

      for (const [absPath, content] of priorContent) {
        try {
          if (content === null) {
            await unlink(absPath);
          } else {
            await writeFile(absPath, content, "utf8");
          }
        } catch {
          failed.push(absPath);
        }
      }

      for (const [absPath, editCalls] of editsByPath) {
        try {
          let content = await readFile(absPath, "utf8");
          for (let c = editCalls.length - 1; c >= 0; c--) {
            const { edits } = editCalls[c];
            for (let e = edits.length - 1; e >= 0; e--) {
              const { oldText, newText } = edits[e];
              content = replaceFirst(content, newText, oldText);
            }
          }
          await writeFile(absPath, content, "utf8");
        } catch {
          failed.push(absPath);
        }
      }

      if (failed.length > 0) {
        ctx.ui.notify(
          `Undo: could not revert ${failed.length} file(s): ${failed.join(", ")}`,
          "warning",
        );
      }

      // ── Navigate / rewind the session branch ─────────────────────────────
      //
      // Both the normal case and the empty-session case follow the same path:
      // navigate to the entry just before the user message (which may be a
      // model_change or thinking_level_change node when undoing the first
      // message) and leave an undo-marker to persist the new leaf on disk.
      //
      // For the empty-session case we additionally schedule the session file
      // for deletion on pi exit via the session_shutdown handler above.

      const navResult = await ctx.navigateTree(lastUserEntry.parentId!, {
        summarize: false,
      });

      if (navResult.cancelled) {
        ctx.ui.notify("Undo cancelled", "info");
        return;
      }

      pi.appendEntry("undo-marker", { prompt: promptText });

      if (isFirstEntry) {
        // Session now has no user messages. Mark for deletion on quit.
        sessionToDelete = ctx.sessionManager.getSessionFile() ?? null;
      }

      // ── Restore the prompt into the editor ───────────────────────────────

      // setEditorText updates the internal buffer but does not request a
      // repaint on its own, so the text stays invisible until the next
      // keypress. Following it with notify() forces a re-render that makes
      // the text appear immediately (same pattern used by qna.ts).
      if (promptText) {
        ctx.ui.setEditorText(promptText);
      }
      ctx.ui.notify("Undone", "info");
    },
  });
}
