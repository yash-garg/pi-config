/**
 * MCP Extension
 *
 * Exposes a single `mcp` tool that lets the LLM interact with MCP servers that
 * have already been configured externally via mcporter's config file. The
 * extension itself never adds, removes, or edits server configuration – it only
 * drives the mcporter CLI.
 *
 * Supported actions:
 *   list_servers – discover every configured server (`mcporter list`)
 *   list_tools   – inspect a server's tool signatures (`mcporter list <server>`)
 *   call_tool    – invoke a specific tool (`mcporter call <server>.<tool>`)
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { enableTools } from "./shared/active-tools.ts";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

interface McpToolDetails {
  action: string;
  server?: string;
  tool?: string;
  exitCode: number;
  truncated: boolean;
  fullOutputPath?: string;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", () => {
    enableTools(pi, ["mcp"]);
  });

  pi.registerCommand("mcps", {
    description: "List configured MCP servers",
    handler: async (_args, ctx) => {
      const result = await pi.exec("mcporter", ["list"], { timeout: 15_000 });
      const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
      if (!output) {
        ctx.ui.notify(
          result.code !== 0
            ? `mcporter exited with code ${result.code} and no output`
            : "No MCP servers configured",
          result.code !== 0 ? "error" : "info",
        );
        return;
      }
      ctx.ui.notify(output, result.code !== 0 ? "error" : "info");
    },
  });

  pi.registerTool({
    name: "mcp",
    label: "MCP",
    description:
      `Interact with MCP (Model Context Protocol) servers via the mcporter CLI. ` +
      `MCP server configuration is managed externally – this tool only calls into ` +
      `already-configured servers.\n\n` +
      `Actions:\n` +
      `  list_servers – list every configured MCP server\n` +
      `  list_tools   – show TypeScript-style signatures for all tools on a server\n` +
      `  call_tool    – invoke a specific tool and return its output\n\n` +
      `Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}, ` +
      `whichever comes first. When truncated, the full output is saved to a temp file.`,
    promptSnippet: "List or call tools on configured MCP servers",
    promptGuidelines: [
      "Use mcp list_servers to discover which MCP servers are available before calling any tools.",
      "Use mcp list_tools to inspect a server's tool signatures and parameter names before calling.",
      "Pass call_tool arguments as a JSON object via the args field.",
    ],

    parameters: Type.Object({
      action: StringEnum(["list_servers", "list_tools", "call_tool"] as const, {
        description:
          "list_servers: enumerate all configured MCP servers. " +
          "list_tools: show tool signatures for a specific server (requires server). " +
          "call_tool: invoke a tool on a server (requires server and tool).",
      }),
      server: Type.Optional(
        Type.String({
          description: "Name of the MCP server. Required for list_tools and call_tool.",
        }),
      ),
      tool: Type.Optional(
        Type.String({
          description: "Name of the tool to invoke. Required for call_tool.",
        }),
      ),
      args: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description:
            "Arguments to pass to the tool as a key/value object. Only used with call_tool.",
        }),
      ),
      output_format: Type.Optional(
        StringEnum(["text", "markdown", "json", "raw"] as const, {
          description:
            "How mcporter should render the tool response for call_tool. Defaults to text.",
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const { action, server, tool, args, output_format } = params;

      // ── Build the mcporter argv ─────────────────────────────────────────────
      let cliArgs: string[];

      switch (action) {
        case "list_servers": {
          cliArgs = ["list"];
          break;
        }

        case "list_tools": {
          if (!server) {
            throw new Error("'server' is required when action is 'list_tools'");
          }
          cliArgs = ["list", server];
          break;
        }

        case "call_tool": {
          if (!server) {
            throw new Error("'server' is required when action is 'call_tool'");
          }
          if (!tool) {
            throw new Error("'tool' is required when action is 'call_tool'");
          }
          cliArgs = [
            "call",
            `${server}.${tool}`,
            "--output",
            output_format ?? "text",
          ];
          // Prefer --args JSON for reliability; mcporter handles it transparently
          if (args && Object.keys(args).length > 0) {
            cliArgs.push("--args", JSON.stringify(args));
          }
          break;
        }
      }

      // ── Run mcporter ────────────────────────────────────────────────────────
      const result = await pi.exec("mcporter", cliArgs, {
        signal,
        timeout: 60_000,
      });

      // mcporter writes informational log lines to stderr; include both streams
      const rawOutput = [result.stdout, result.stderr]
        .filter(Boolean)
        .join("\n")
        .trim();

      // A non-zero exit with no output at all is a hard failure
      if (result.code !== 0 && !rawOutput) {
        throw new Error(`mcporter exited with code ${result.code} and produced no output`);
      }

      // ── Truncate to protect the LLM context window ──────────────────────────
      const truncation = truncateHead(rawOutput, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });

      const details: McpToolDetails = {
        action,
        server,
        tool,
        exitCode: result.code,
        truncated: truncation.truncated,
      };

      let text = truncation.content;

      if (truncation.truncated) {
        const tempDir = await mkdtemp(join(tmpdir(), "pi-mcp-"));
        const tempFile = join(tempDir, "output.txt");
        await writeFile(tempFile, rawOutput, "utf8");
        details.fullOutputPath = tempFile;

        const omittedLines = truncation.totalLines - truncation.outputLines;
        const omittedBytes = truncation.totalBytes - truncation.outputBytes;
        text +=
          `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines` +
          ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).` +
          ` ${omittedLines} lines (${formatSize(omittedBytes)}) omitted.` +
          ` Full output saved to: ${tempFile}]`;
      }

      // Surface a non-zero exit as a thrown error so the LLM sees isError=true,
      // but still include whatever output mcporter produced.
      if (result.code !== 0) {
        throw new Error(`mcporter exited with code ${result.code}:\n${text}`);
      }

      return {
        content: [{ type: "text", text }],
        details,
      };
    },

    // ── Custom TUI rendering ────────────────────────────────────────────────

    renderCall(args, theme, _context) {
      let text = theme.fg("toolTitle", theme.bold("mcp "));
      text += theme.fg("accent", args.action ?? "");
      if (args.server) {
        text += theme.fg("muted", ` ${args.server}`);
      }
      if (args.tool) {
        text += theme.fg("dim", `.${args.tool}`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, { isPartial, expanded }, theme, context) {
      if (isPartial) {
        return new Text(theme.fg("warning", "Waiting for mcporter..."), 0, 0);
      }

      // context.isError is set when the tool threw
      if (context.isError) {
        const firstLine =
          (result.content[0] as { type: string; text?: string } | undefined)
            ?.text
            ?.split("\n")[0] ?? "Error";
        return new Text(theme.fg("error", `✗ ${firstLine}`), 0, 0);
      }

      const details = result.details as McpToolDetails | undefined;

      let text = theme.fg("success", "✓ ");
      switch (details?.action) {
        case "list_servers":
          text += theme.fg("muted", "servers listed");
          break;
        case "list_tools":
          text += theme.fg("muted", `tools listed for ${details.server ?? ""}`);
          break;
        case "call_tool":
          text += theme.fg("muted", `${details.server ?? ""}.${details.tool ?? ""}`);
          break;
        default:
          text += theme.fg("muted", "done");
      }

      if (details?.truncated) {
        text += theme.fg("warning", " (truncated)");
      }

      if (expanded) {
        const firstBlock = result.content[0] as
          | { type: string; text?: string }
          | undefined;
        if (firstBlock?.type === "text" && firstBlock.text) {
          const lines = firstBlock.text.split("\n");
          const preview = lines.slice(0, 30);
          for (const line of preview) {
            text += `\n${theme.fg("dim", line)}`;
          }
          if (lines.length > 30) {
            text += `\n${theme.fg("muted", `… (${lines.length - 30} more lines)`)}`;
          }
          if (details?.fullOutputPath) {
            text += `\n${theme.fg("dim", `Full output: ${details.fullOutputPath}`)}`;
          }
        }
      }

      return new Text(text, 0, 0);
    },
  });
}
