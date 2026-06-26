import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const EXTREMELY_IMPORTANT_MARKER = "<EXTREMELY_IMPORTANT>";
const BOOTSTRAP_MARKER = "superpowers:using-superpowers bootstrap for pi";

const extensionDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(extensionDir, "..");

function superpowersRoot(): string {
  const agentDir =
    process.env["PI_CODING_AGENT_DIR"] ?? join(homedir(), ".pi", "agent");
  return join(agentDir, "git/github.com/obra/superpowers");
}

function getSkillsDir(): string {
  return join(superpowersRoot(), "skills");
}

function getBootstrapSkillPath(): string {
  return join(getSkillsDir(), "using-superpowers", "SKILL.md");
}

let cachedBootstrap: string | null | undefined;

export default function superpowersPiExtension(pi: ExtensionAPI) {
  let injectBootstrap = true;

  pi.on("resources_discover", async () => ({
    skillPaths: [getSkillsDir(), resolve(packageRoot, "skills")],
  }));

  pi.on("session_start", async () => {
    injectBootstrap = true;
  });

  pi.on("session_compact", async () => {
    injectBootstrap = true;
  });

  pi.on("agent_end", async () => {
    injectBootstrap = false;
  });

  pi.on("context", async (event) => {
    if (!injectBootstrap) return;
    if (event.messages.some(messageContainsBootstrap)) return;

    const bootstrap = getBootstrapContent();
    if (!bootstrap) return;

    const bootstrapMessage = {
      role: "user" as const,
      content: [{ type: "text" as const, text: bootstrap }],
      timestamp: Date.now(),
    };

    const insertAt = firstNonCompactionSummaryIndex(event.messages);
    return {
      messages: [
        ...event.messages.slice(0, insertAt),
        bootstrapMessage,
        ...event.messages.slice(insertAt),
      ],
    };
  });
}

function getBootstrapContent(): string | null {
  if (cachedBootstrap !== undefined) return cachedBootstrap;

  try {
    const skillContent = readFileSync(getBootstrapSkillPath(), "utf8");
    const body = stripFrontmatter(skillContent);
    cachedBootstrap = `${EXTREMELY_IMPORTANT_MARKER}
${BOOTSTRAP_MARKER}

You have superpowers.

The using-superpowers skill content is included below and is already loaded for this Pi session. Follow it now. Do not try to load using-superpowers again.

${promptGuard()}

${body}

${piToolMapping()}
</EXTREMELY_IMPORTANT>`;
    return cachedBootstrap;
  } catch {
    cachedBootstrap = null;
    return null;
  }
}

function stripFrontmatter(content: string): string {
  const match = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  return (match ? match[1] : content).trim();
}

function promptGuard(): string {
  return `## Local scope guard

Keep the superpowers skill injection enabled, but do not force the full superpowers workflow for every request.

For small, self-contained tasks, act directly without mandatory brainstorming, spec-writing, planning, or TDD. Examples: tiny bugfixes, narrow config edits, simple refactors, copy tweaks, straightforward file-local changes, and other low-risk requests with clear intent.

For those trivial tasks, do not load or follow a superpowers skill just because there is a weak or theoretical chance it might apply. The heavy superpowers process is optional for trivial work and should usually be skipped. This local rule overrides blanket instructions such as “invoke relevant skills before any response or action” and “if there is even a 1% chance a skill applies.”

Use superpowers skills when they are actually relevant: ambiguous or creative work, user-requested planning/design, debugging, code review, risky/destructive changes, cross-cutting or multi-step work, or tasks where a named skill clearly matches the problem.

When in doubt, prefer the lightest process that still keeps the work correct.`;
}

function piToolMapping(): string {
  return `## Pi tool mapping

Pi has native skills. When a Superpowers instruction says to invoke a skill, use Pi's native skill system instead.

Pi's built-in coding tools are lowercase: \`read\`, \`write\`, \`edit\`, \`bash\`, plus optional \`grep\`, \`find\`, and \`ls\`. Use those for the corresponding actions: read a file, create or edit files, run shell commands, search file contents, find files by name, and list directories.

If a subagent tool such as \`subagent\` is available, use it for Superpowers subagent workflows.
- For implementation or fix-up work, dispatch the \`worker\` subagent.
- For code review or read-only review work, dispatch the \`reviewer\` subagent.
- Do not invent or substitute a \`general-purpose\` implementation subagent in Pi; \`worker\` is the general implementation agent here.

If no subagent tool is available, do the work in this session or explain the missing capability instead of inventing \`Task\` calls.

Pi's task-list tool is \`todo_write\`. When Superpowers instructions mention \`TodoWrite\`, use \`todo_write\` explicitly to manage the session task list.`;
}

function messageContainsBootstrap(message: unknown): boolean {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content.includes(BOOTSTRAP_MARKER);
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    return (
      part &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string" &&
      (part as { text: string }).text.includes(BOOTSTRAP_MARKER)
    );
  });
}

function firstNonCompactionSummaryIndex(messages: unknown[]): number {
  let index = 0;
  while ((messages[index] as { role?: unknown } | undefined)?.role === "compactionSummary") {
    index += 1;
  }
  return index;
}
