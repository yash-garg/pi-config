/**
 * Exit Extension
 *
 * Two ways to quit pi gracefully:
 *   /exit        – slash command
 *   exit (Enter) – typing "exit" as a plain prompt
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // /exit command
  pi.registerCommand("exit", {
    description: "Quit pi",
    handler: (_args, ctx) => {
      ctx.shutdown();
    },
  });

  // Intercept "exit" typed as a prompt before it reaches the LLM
  pi.on("input", (_event, ctx) => {
    if (_event.text.trim().toLowerCase() === "exit") {
      ctx.shutdown();
      return { action: "handled" };
    }
  });
}
