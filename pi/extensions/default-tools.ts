/**
 * Default Tools Extension
 *
 * Pi's built-in tool set defaults to: read, bash, edit, write.
 * grep, find, and ls exist but are off by default, which causes the LLM to
 * reach for `bash` + `grep -n` / `find` / `ls` instead of the dedicated tools.
 *
 * This extension only backfills Pi-bundled built-ins that are missing from
 * the current session's active tool set. Extension-owned tools enable
 * themselves so we do not clobber their choices here.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { enableTools } from "./shared/active-tools.ts";

const BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const VENDORED_TOOLS = ["subagent"];

export default function (pi: ExtensionAPI) {
  pi.on("session_start", () => {
    enableTools(pi, BUILTIN_TOOLS + VENDORED_TOOLS);
  });
}
