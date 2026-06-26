/**
 * Anthropic usage widget
 *
 * Shows today's token usage and cost (read from ~/.pi/agent/sessions) in the
 * status bar, refreshed every 5 minutes. Works for any provider pi tracks.
 *
 * Display: "today  42.3K tok  $0.12"
 */

import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const WIDGET_ID = "usage-widget";
const REFRESH_MS = 5 * 60 * 1000;
const SESSION_ROOT = path.join(os.homedir(), ".pi", "agent", "sessions");

type WidgetState =
  | { kind: "hidden" }
  | { kind: "loading" }
  | { kind: "ready"; tokens: number; cost: number }
  | { kind: "error" };

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M tok`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K tok`;
  return `${n} tok`;
}

function formatCost(cost: number): string {
  if (cost >= 1) return `$${cost.toFixed(2)}`;
  if (cost >= 0.001) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(4)}`;
}

function toLocalDayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function parseSessionStart(name: string): Date | null {
  const m = name.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_/);
  if (!m) return null;
  const d = new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
  return Number.isFinite(d.getTime()) ? d : null;
}

function readNum(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") { const n = Number(v); return Number.isFinite(n) ? n : 0; }
  return 0;
}

function extractTokens(usage: unknown): number {
  if (!usage || typeof usage !== "object") return 0;
  const u = usage as Record<string, unknown>;
  const direct =
    readNum(u.totalTokens) || readNum(u.total_tokens) ||
    readNum(u.tokenCount) || readNum(u.token_count);
  if (direct > 0) return direct;
  return (
    readNum(u.promptTokens ?? u.prompt_tokens ?? u.inputTokens ?? u.input_tokens) +
    readNum(u.completionTokens ?? u.completion_tokens ?? u.outputTokens ?? u.output_tokens)
  );
}

function extractCost(usage: unknown): number {
  if (!usage || typeof usage !== "object") return 0;
  const u = usage as Record<string, unknown>;
  const c = u.cost;
  if (typeof c === "number") return Number.isFinite(c) ? c : 0;
  if (typeof c === "string") { const n = Number(c); return Number.isFinite(n) ? n : 0; }
  if (c && typeof c === "object") {
    const t = (c as Record<string, unknown>).total;
    if (typeof t === "number") return Number.isFinite(t) ? t : 0;
  }
  return 0;
}

async function sumTodayUsage(): Promise<{ tokens: number; cost: number }> {
  const todayKey = toLocalDayKey(new Date());
  let tokens = 0;
  let cost = 0;

  const stack = [SESSION_ROOT];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch { continue; }

    for (const ent of entries) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) { stack.push(p); continue; }
      if (!ent.isFile() || !ent.name.endsWith(".jsonl")) continue;

      const start = parseSessionStart(ent.name);
      if (start && toLocalDayKey(start) !== todayKey) continue;
      if (!start) {
        try {
          const st = await fs.stat(p);
          if (toLocalDayKey(new Date(st.mtimeMs)) !== todayKey) continue;
        } catch { continue; }
      }

      const stream = createReadStream(p, { encoding: "utf8" });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      try {
        for await (const line of rl) {
          if (!line) continue;
          let obj: unknown;
          try { obj = JSON.parse(line); } catch { continue; }
          if (!obj || typeof obj !== "object") continue;
          const o = obj as Record<string, unknown>;
          if (o.type !== "message") continue;
          const usage = o.usage ?? (o.message as Record<string, unknown> | undefined)?.usage;
          tokens += extractTokens(usage);
          cost += extractCost(usage);
        }
      } finally {
        rl.close();
        stream.destroy();
      }
    }
  }

  return { tokens, cost };
}

function renderWidget(ctx: ExtensionContext, state: WidgetState) {
  if (!ctx.hasUI) return;

  if (state.kind === "hidden" || state.kind === "error") {
    ctx.ui.setWidget(WIDGET_ID, undefined);
    return;
  }

  const text =
    state.kind === "loading"
      ? "usage loading…"
      : `today  ${formatTokens(state.tokens)}  ${formatCost(state.cost)}`;

  ctx.ui.setWidget(
    WIDGET_ID,
    (_tui, theme) => ({
      invalidate() { },
      render(width: number) {
        const line = theme.fg("dim", text);
        const rendered = truncateToWidth(line, width);
        const pad = Math.max(0, width - visibleWidth(rendered));
        return [`${" ".repeat(pad)}${rendered}`];
      },
    }),
    { placement: "belowEditor" },
  );
}

export default function usageWidget(pi: ExtensionAPI) {
  let state: WidgetState = { kind: "hidden" };
  let refreshTimer: NodeJS.Timeout | undefined;
  let activeRun = 0;

  const clearTimer = () => {
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = undefined; }
  };

  const refresh = async (ctx: ExtensionContext) => {
    const runId = ++activeRun;
    try {
      const { tokens, cost } = await sumTodayUsage();
      if (runId !== activeRun) return;
      state = { kind: "ready", tokens, cost };
    } catch {
      if (runId !== activeRun) return;
      if (state.kind !== "ready") state = { kind: "error" };
    }
    renderWidget(ctx, state);
  };

  pi.on("session_start", async (_event, ctx) => {
    clearTimer();
    state = { kind: "loading" };
    renderWidget(ctx, state);
    void refresh(ctx);
    refreshTimer = setInterval(() => void refresh(ctx), REFRESH_MS);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    activeRun++;
    clearTimer();
    if (ctx.hasUI) ctx.ui.setWidget(WIDGET_ID, undefined);
  });
}
