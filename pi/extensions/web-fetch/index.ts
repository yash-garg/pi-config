import { createRequire } from "node:module";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { enableTools } from "../shared/active-tools.ts";

const _require = createRequire(import.meta.url);

// ── Types ─────────────────────────────────────────────────────────────────────

interface CachedDocument {
  raw: string;               // Full response body as UTF-8 string
  readable: string | null;   // Plain text from Readability; null if not HTML or failed
  contentType: string;       // Raw Content-Type header value
  totalBytes: number;        // Buffer.byteLength(raw, "utf8")
  totalLines: number | null; // readable.split("\n").length; null when readable is null
  markdown: string | null;   // Full Markdown body when the server returned Markdown
}

// ── Utility functions ─────────────────────────────────────────────────────────

/** True when Content-Type indicates HTML. */
export function isHtml(contentType: string): boolean {
  return contentType.toLowerCase().includes("text/html");
}

/** True when Content-Type indicates Markdown. */
export function isMarkdown(contentType: string): boolean {
  const normalized = contentType.toLowerCase();
  return (
    normalized.includes("text/markdown") ||
    normalized.includes("text/x-markdown") ||
    normalized.includes("application/markdown")
  );
}

/**
 * Slice a UTF-8 string by byte offsets.
 * startByte and endByte are clamped to the document length — no errors thrown.
 */
export function sliceBytes(text: string, startByte: number, endByte?: number): string {
  const buf = Buffer.from(text, "utf8");
  const start = Math.max(0, Math.min(startByte, buf.length));
  const end =
    endByte !== undefined ? Math.max(start, Math.min(endByte, buf.length)) : buf.length;
  return buf.subarray(start, end).toString("utf8");
}

/**
 * Slice a string by 1-indexed line offset and optional line count.
 * line_offset past the end returns "". Both values are clamped — no errors thrown.
 */
export function sliceLines(text: string, lineOffset: number, lineLimit?: number): string {
  const lines = text.split("\n");
  const start = Math.max(0, Math.min(lineOffset - 1, lines.length));
  const end =
    lineLimit !== undefined
      ? Math.max(start, Math.min(start + lineLimit, lines.length))
      : lines.length;
  return lines.slice(start, end).join("\n");
}

// ── Readability ───────────────────────────────────────────────────────────────

/**
 * Run Mozilla Readability on an HTML string and return plain text.
 * Returns null if Readability cannot extract an article (e.g. not an article page).
 * Never throws — any internal failure returns null.
 */
function applyReadability(html: string, url: string): string | null {
  try {
    const { JSDOM } = _require("jsdom") as { JSDOM: typeof import("jsdom").JSDOM };
    const { Readability } = _require("@mozilla/readability") as {
      Readability: typeof import("@mozilla/readability").Readability;
    };
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    if (!article?.textContent) return null;
    return article.textContent.trim();
  } catch {
    return null;
  }
}

// ── Fetch & cache ─────────────────────────────────────────────────────────────

// Cleared in the extension's session_start handler so each session starts fresh.
const cache = new Map<string, CachedDocument>();

/**
 * Fetch a URL and populate a CachedDocument.
 * Throws on HTTP error or network failure.
 * Always computes both raw and (when HTML) readable forms.
 */
async function fetchDocument(url: string, signal?: AbortSignal): Promise<CachedDocument> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  signal?.addEventListener("abort", () => controller.abort());
  const response = await fetch(url, {
    signal: controller.signal,
    headers: {
      Accept: "text/markdown",
    },
  }).finally(() => clearTimeout(timer));
  if (!response.ok) {
    throw new Error(
      [response.status, response.statusText, "fetching", url].filter(Boolean).join(" "),
    );
  }

  const contentType = response.headers.get("content-type") ?? "application/octet-stream";
  const raw = await response.text();
  const totalBytes = Buffer.byteLength(raw, "utf8");

  let readable: string | null = null;
  let totalLines: number | null = null;
  let markdown: string | null = null;

  if (isMarkdown(contentType)) {
    markdown = raw;
  } else if (isHtml(contentType)) {
    readable = applyReadability(raw, url);
    if (readable !== null) {
      totalLines = readable.split("\n").length;
    }
  }

  return { raw, readable, contentType, totalBytes, totalLines, markdown };
}

// ── Extension ─────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {

  // Clear the cache at the start of each session so stale pages are never served.
  pi.on("session_start", () => {
    enableTools(pi, ["web_fetch"]);
    cache.clear();
  });

  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Fetch the contents of an HTTP/HTTPS URL.\n\n" +
      "The tool first requests Markdown with Accept: text/markdown. If the server returns " +
      "Markdown, that full response is returned wholesale with no readability filtering or " +
      "line/byte ranges applied.\n\n" +
      "For HTML pages, Readability is enabled by default and extracts clean article text, " +
      "stripping navigation, ads, and boilerplate. Use line_offset/line_limit to page through " +
      "the result. Set readability: false to get the raw response body instead — byte ranges " +
      "(start_byte/end_byte) then apply.\n\n" +
      "For non-HTML content (JSON, plain text, etc.), readability is ignored and byte ranges " +
      "always apply.\n\n" +
      "The first call to a URL fetches the full document and caches it. Subsequent calls with " +
      "different ranges or readability settings serve from the cache — no extra network requests.\n\n" +
      "IMPORTANT: line ranges and byte ranges are mutually exclusive. Do not mix them.",
    promptSnippet: "Fetch the contents of a URL, with optional Readability extraction and paging",
    promptGuidelines: [
      "Use web_fetch when the user's message contains a URL or references an external page.",
      "web_fetch first prefers Markdown via Accept: text/markdown; when the server returns Markdown, Pi returns it wholesale and ignores readability and range parameters.",
      "For HTML pages, readability is enabled by default and strips navigation/ads to article text — use line_offset/line_limit to page through large results.",
      "Set readability: false only when you need the raw HTML or the page is not an article — byte ranges (start_byte/end_byte) then apply.",
      "Check total_lines or total_bytes in the result to know whether there is more content to fetch.",
    ],
    parameters: Type.Object({
      url: Type.String({
        description: "Full URL to fetch. Must start with http:// or https://.",
      }),
      readability: Type.Optional(
        Type.Boolean({
          description:
            "Extract clean article text via Mozilla Readability. " +
            "Default: true for HTML pages (ignored for non-HTML). " +
            "When true, use line_offset/line_limit for paging. " +
            "When false, the raw response body is returned and start_byte/end_byte apply.",
        }),
      ),
      line_offset: Type.Optional(
        Type.Integer({
          description:
            "1-indexed line to start from when readability is active. Default: 1. " +
            "Clamped silently if past end of document.",
          minimum: 1,
        }),
      ),
      line_limit: Type.Optional(
        Type.Integer({
          description:
            "Maximum number of lines to return when readability is active. Default: no limit.",
          minimum: 1,
        }),
      ),
      start_byte: Type.Optional(
        Type.Integer({
          description:
            "Byte offset to start from when readability is false or content is non-HTML. " +
            "Default: 0. Clamped silently if past end of document.",
          minimum: 0,
        }),
      ),
      end_byte: Type.Optional(
        Type.Integer({
          description:
            "Byte offset to end at (exclusive) when readability is false or content is non-HTML. " +
            "Default: end of document. Clamped silently if past end of document.",
          minimum: 0,
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      // Validate URL scheme
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(params.url);
      } catch {
        throw new Error(`Invalid URL: "${params.url}"`);
      }
      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
        throw new Error(
          `Only http:// and https:// URLs are supported, got: "${parsedUrl.protocol}//"`,
        );
      }

      // Fetch or serve from cache
      let doc = cache.get(params.url);
      if (!doc) {
        doc = await fetchDocument(params.url, signal);
        cache.set(params.url, doc);
      }

      if (doc.markdown !== null) {
        return {
          content: [{ type: "text", text: doc.markdown }],
          details: {
            content_type: doc.contentType,
            readability_applied: false,
            total_bytes: doc.totalBytes,
          },
        };
      }

      const html = isHtml(doc.contentType);
      const useReadability = html && params.readability !== false && doc.readable !== null;

      let text: string;
      let details: Record<string, unknown>;

      if (useReadability) {
        // Line-based slicing on Readability-cleaned plain text
        const lineOffset = params.line_offset ?? 1;
        const lineLimit = params.line_limit;
        text = sliceLines(doc.readable!, lineOffset, lineLimit);
        details = {
          content_type: doc.contentType,
          readability_applied: true,
          total_lines: doc.totalLines,
        };
      } else {
        // Byte-based slicing on raw response body.
        // Also used when readability=true but Readability returned null (fallback to raw).
        const startByte = params.start_byte ?? 0;
        const endByte = params.end_byte;
        text = sliceBytes(doc.raw, startByte, endByte);
        details = {
          content_type: doc.contentType,
          readability_applied: false,
          total_bytes: doc.totalBytes,
        };
      }

      return {
        content: [{ type: "text", text }],
        details,
      };
    },
  });
}
