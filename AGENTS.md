## Pi asset placement

Assets live at the repo root and are symlinked into `~/.pi/agent/` by `scripts/install.sh`.
When adding or editing Pi agents, extensions, prompts, skills, themes, or related global Pi configuration, put them at the repo root directly (e.g. `agents/`, `extensions/`, `skills/`).

## Pi extension tests

Pi extensions cannot keep permanent tests in this repository. When validating extension behavior, write only simple temporary test files, be explicit that they are temporary, and remove them once the code has been validated.

Never attempt compile-time verification for Pi extensions. They are loaded by Pi's runtime and are not meant to be compiled or run standalone; use targeted temporary behavioral checks instead.

## Pi tool activation pattern

When a Pi extension registers its own tool, that extension should also enable the tool itself during `session_start` by unioning it into `pi.getActiveTools()` and calling `pi.setActiveTools(...)` with the merged set.

## Structure

```
pi-config/
├── agents/                  # Custom agent definitions (symlinked → ~/.pi/agent/agents)
├── extensions/              # Pi extensions — TypeScript, loaded at Pi runtime (symlinked → ~/.pi/agent/extensions)
├── skills/                  # Agent skills (dart, flutter, cloudflare, …) (symlinked → ~/.pi/agent/skills)
├── themes/                  # UI themes (symlinked → ~/.pi/agent/themes)
├── prompts/                 # Prompt templates (symlinked → ~/.pi/agent/prompts)
├── settings.json            # Pi settings (symlinked → ~/.pi/agent/settings.json)
├── sandbox.json             # Pi sandbox config (symlinked → ~/.pi/agent/sandbox.json)
├── mcporter/                # mcporter MCP config (mcporter.json, symlinked to ~/.mcporter)
├── git/                     # Git config/ignore overrides
└── scripts/                 # Utility scripts (install.sh, sync.sh)
```

## WHERE TO LOOK

| Task | Location |
|------|----------|
| Add/edit extension | `extensions/` |
| Add/edit agent | `agents/` |
| Add/edit theme | `themes/` |
| Add/edit prompt | `prompts/` |
| Add/edit agent skill | `skills/` |
| Add/edit MCP server | `mcporter/mcporter.json` |
| Pi settings | `settings.json` |
| Wire symlinks / install deps | `scripts/install.sh` |

## ANTI-PATTERNS

* Do NOT compile or `tsc` extensions directly — they are loaded by Pi runtime
* Do NOT write permanent test files for extensions — only temporary behavioral checks
