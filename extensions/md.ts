import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { extname, relative, resolve } from "node:path";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
  Key,
  Markdown,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

type ViewerAction = "close" | "openInEditor";

function isMarkdownPath(filePath: string): boolean {
  const extension = extname(filePath).toLowerCase();
  return extension === ".md" || extension === ".markdown";
}

function resolveMarkdownPath(cwd: string, rawPath: string): string {
  return resolve(cwd, rawPath);
}

async function ensureReadableMarkdownFile(filePath: string): Promise<void> {
  if (!isMarkdownPath(filePath)) {
    throw new Error("Only .md and .markdown files are supported");
  }

  try {
    await access(filePath, constants.R_OK);
  } catch {
    throw new Error(`File is missing or not readable: ${filePath}`);
  }
}

async function openInEditor(filePath: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const editor = process.env["EDITOR"]?.trim();
  if (!editor) {
    return { ok: false, error: "$EDITOR is not set" };
  }

  const shell = process.env["SHELL"]?.trim() || "/bin/sh";

  return await new Promise((resolvePromise) => {
    const child = spawn(shell, ["-lc", `${editor} "$1"`, "--", filePath], {
      stdio: "inherit",
    });

    child.on("error", (error) => {
      resolvePromise({ ok: false, error: error.message });
    });

    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise({ ok: true });
        return;
      }
      resolvePromise({
        ok: false,
        error: signal ? `Editor exited due to signal ${signal}` : `Editor exited with status ${code ?? "unknown"}`,
      });
    });
  });
}

class MarkdownOverlayViewer {
  private readonly theme: Theme;
  private readonly displayPath: string;
  private readonly done: (action: ViewerAction) => void;
  private readonly markdown: Markdown;
  private scrollOffset = 0;
  private viewportHeight = 12;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(theme: Theme, displayPath: string, markdownText: string, done: (action: ViewerAction) => void) {
    this.theme = theme;
    this.displayPath = displayPath;
    this.done = done;
    this.markdown = new Markdown(markdownText, 0, 0, getMarkdownTheme());
  }

  private invalidateCache(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  private clampScroll(maxOffset: number): void {
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxOffset));
  }

  invalidate(): void {
    this.invalidateCache();
    this.markdown.invalidate();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || data === "q") {
      this.done("close");
      return;
    }

    if (data === "o") {
      this.done("openInEditor");
      return;
    }

    if (matchesKey(data, Key.up)) {
      this.scrollOffset -= 1;
      this.invalidateCache();
      return;
    }

    if (matchesKey(data, Key.down)) {
      this.scrollOffset += 1;
      this.invalidateCache();
      return;
    }

    if (matchesKey(data, Key.pageUp)) {
      this.scrollOffset -= this.viewportHeight;
      this.invalidateCache();
      return;
    }

    if (matchesKey(data, Key.pageDown)) {
      this.scrollOffset += this.viewportHeight;
      this.invalidateCache();
      return;
    }

    if (matchesKey(data, Key.home)) {
      this.scrollOffset = 0;
      this.invalidateCache();
      return;
    }

    if (matchesKey(data, Key.end)) {
      this.scrollOffset = Number.MAX_SAFE_INTEGER;
      this.invalidateCache();
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const boxWidth = Math.max(20, width);
    const innerWidth = Math.max(16, boxWidth - 4);
    const title = this.theme.fg("accent", ` Markdown: ${this.displayPath}`);
    const help = this.theme.fg(
      "dim",
      "↑↓ scroll • PgUp/PgDn page • Home/End jump • o open in $EDITOR • q/Esc close",
    );

    const topBorder = this.theme.fg("borderAccent", `╭${"─".repeat(boxWidth - 2)}╮`);
    const divider = this.theme.fg("borderMuted", `├${"─".repeat(boxWidth - 2)}┤`);
    const bottomBorder = this.theme.fg("borderAccent", `╰${"─".repeat(boxWidth - 2)}╯`);
    const frameRow = (content: string) => {
      const padded = truncateToWidth(content, innerWidth, "");
      const rightPad = Math.max(0, innerWidth - visibleWidth(padded));
      return this.theme.fg("borderAccent", "│") + " " + padded + " ".repeat(rightPad) + " " + this.theme.fg("borderAccent", "│");
    };

    const renderedMarkdown = this.markdown.render(innerWidth);
    this.viewportHeight = Math.max(8, Math.min(30, renderedMarkdown.length || 8));
    const maxOffset = Math.max(0, renderedMarkdown.length - this.viewportHeight);
    this.clampScroll(maxOffset);

    const visibleMarkdown = renderedMarkdown.slice(this.scrollOffset, this.scrollOffset + this.viewportHeight);
    const rows: string[] = [topBorder, frameRow(title), divider];

    if (visibleMarkdown.length === 0) {
      rows.push(frameRow(this.theme.fg("muted", "(empty file)")));
    } else {
      for (const line of visibleMarkdown) {
        rows.push(frameRow(line));
      }
    }

    rows.push(divider);
    for (const line of wrapTextWithAnsi(help, innerWidth)) {
      rows.push(frameRow(line));
    }
    rows.push(bottomBorder);

    this.cachedWidth = width;
    this.cachedLines = rows;
    return rows;
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("md", {
    description: "Open a Markdown file in a read-only overlay viewer",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/md requires interactive mode", "error");
        return;
      }

      const rawPath = args.trim?.() ?? "";
      if (!rawPath) {
        ctx.ui.notify("Usage: /md <path>", "error");
        return;
      }

      const absolutePath = resolveMarkdownPath(ctx.cwd, rawPath);
      const displayPath = relative(ctx.cwd, absolutePath) || rawPath;

      try {
        await ensureReadableMarkdownFile(absolutePath);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : `Unable to open ${rawPath}`, "error");
        return;
      }

      let markdownText: string;
      try {
        markdownText = await readFile(absolutePath, "utf8");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : `Unable to read ${rawPath}`, "error");
        return;
      }

      const action = await ctx.ui.custom<ViewerAction>(
        (_tui, theme, _kb, done) => new MarkdownOverlayViewer(theme, displayPath, markdownText, done),
        {
          overlay: true,
          overlayOptions: {
            width: "80%",
            maxHeight: "85%",
            anchor: "center",
            margin: 1,
          },
        },
      );

      if (action !== "openInEditor") {
        return;
      }

      const result = await openInEditor(absolutePath);
      if (!result.ok) {
        ctx.ui.notify(`Failed to open editor: ${result.error}`, "error");
      }
    },
  });
}
