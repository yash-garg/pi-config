/**
 * Todo Extension
 *
 * Maintains a per-session todo list as a markdown file in
 * ~/.local/share/pi-coding-agent/todos/{session-uuid}.md.
 *
 * - `todo_write` tool: LLM replaces the full list in one shot.
 * - Widget above the editor: shows all items, hidden when list is empty.
 * - Session-scoped: switching sessions switches the visible list.
 *
 * Markdown states:
 *   - [ ]  pending     -> O  (text colour)
 *   - [/]  in-progress -> half-circle (accent colour)
 *   - [x]  done        -> check (muted colour)
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { enableTools } from "./shared/active-tools.ts";

const STORAGE_DIR = join(homedir(), ".local/share/pi-coding-agent/todos");

function todoFilePath(sessionId: string): string {
  return join(STORAGE_DIR, `${sessionId}.md`);
}

type ItemState = "pending" | "in-progress" | "done";

interface ParsedItem {
  state: ItemState;
  text: string;
}

function parseItems(markdown: string): ParsedItem[] {
  const items: ParsedItem[] = [];
  for (const line of markdown.split("\n")) {
    const done       = line.match(/^- \[x\] (.+)/i);
    const inProgress = line.match(/^- \[\/\] (.+)/);
    const pending    = line.match(/^- \[ \] (.+)/);
    if (done)            items.push({ state: "done",        text: done[1]!       });
    else if (inProgress) items.push({ state: "in-progress", text: inProgress[1]! });
    else if (pending)    items.push({ state: "pending",     text: pending[1]!    });
    // Non-item lines (blank lines, headings, prose) are ignored in the parsed
    // output but preserved verbatim when writing back to disk.
  }
  return items;
}

interface ItemCounts {
  pending: number;
  inProgress: number;
  done: number;
}

function countItems(items: ParsedItem[]): ItemCounts {
  return {
    pending:    items.filter((i) => i.state === "pending").length,
    inProgress: items.filter((i) => i.state === "in-progress").length,
    done:       items.filter((i) => i.state === "done").length,
  };
}

export default function (pi: ExtensionAPI) {
  let content   = "";  // raw markdown of the active session's todos
  let sessionId = "";  // session ID the content belongs to

  // ── Widget rendering ────────────────────────────────────────────────────

  function refreshWidget(ctx: ExtensionContext): void {
    const items = parseItems(content);
    if (items.length === 0) {
      ctx.ui.setWidget("todo", undefined);
      return;
    }

    const lines: string[] = [
      ctx.ui.theme.fg("accent", " TODOs " + "\u2500".repeat(32)),
    ];

    for (const item of items) {
      switch (item.state) {
        case "done":
          lines.push(ctx.ui.theme.fg("muted",  "  \u2713  " + item.text));
          break;
        case "in-progress":
          lines.push(ctx.ui.theme.fg("accent", "  \u25d0  " + item.text));
          break;
        case "pending":
          lines.push("  \u25cb  " + item.text);
          break;
      }
    }

    // Default placement is aboveEditor.
    ctx.ui.setWidget("todo", lines);
  }

  // ── Session lifecycle ───────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    enableTools(pi, ["todo_write"]);
    sessionId = ctx.sessionManager.getSessionId();
    try {
      content = await readFile(todoFilePath(sessionId), "utf8");
    } catch {
      content = "";
    }
    refreshWidget(ctx);
  });

  // ── todo_write tool ─────────────────────────────────────────────────────

  pi.registerTool({
    name: "todo_write",
    label: "Write Todos",
    description:
      "Replace the current session's todo list with new markdown content. " +
      "Rewrites the entire list in one call — include all items, not just changes. " +
      "Markdown states: `- [ ]` pending  `- [/]` in-progress  `- [x]` done.",
    promptSnippet: "Write or update the full session todo list",
    promptGuidelines: [
      "Always include the full list when calling todo_write, not just changed items.",
      "Use `- [/]` to mark a task as in-progress before starting work on it.",
      "Use `- [x]` to mark a task done only after verifying it is complete.",
    ],
    parameters: Type.Object({
      content: Type.String({
        description:
          "Full markdown todo list. Use `- [ ]` for pending, `- [/]` for in-progress, `- [x]` for done.",
      }),
    }),

    async execute(_id, params, _signal, _onUpdate, ctx) {
      await mkdir(STORAGE_DIR, { recursive: true });

      const sid = ctx.sessionManager.getSessionId();
      await writeFile(todoFilePath(sid), params.content, "utf8");

      content   = params.content;
      sessionId = sid;
      refreshWidget(ctx);

      const counts = countItems(parseItems(params.content));
      return {
        content: [{
          type: "text",
          text:
            `Todo list updated: ` +
            `${counts.pending} pending, ` +
            `${counts.inProgress} in-progress, ` +
            `${counts.done} done.`,
        }],
        details: counts,
      };
    },
  });
}
