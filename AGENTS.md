## Pi asset placement

In this repo, `pi/` is the canonical source of truth for user-global Pi assets.
`~/.pi` is symlinked to this repository's `pi/` directory via the nix flake.
When adding or editing Pi agents, extensions, prompts, skills, themes, or related global Pi configuration, put them in `pi/` directly.

## Pi extension tests

Pi extensions cannot keep permanent tests in this repository. When validating extension behavior, write only simple temporary test files, be explicit that they are temporary, and remove them once the code has been validated.

Never attempt compile-time verification for Pi extensions. They are loaded by Pi's runtime and are not meant to be compiled or run standalone; use targeted temporary behavioral checks instead.

## Pi tool activation pattern

When a Pi extension registers its own tool, that extension should also enable the tool itself during `session_start` by unioning it into `pi.getActiveTools()` and calling `pi.setActiveTools(...)` with the merged set.

## Structure

```
pi-config/
├── pi/                      # Canonical user-global Pi config (symlinked to ~/.pi)
│   ├── agents/              # Custom agent definitions
│   ├── extensions/          # Pi extensions — TypeScript, loaded at Pi runtime
│   ├── skills/              # Agent skills (dart, flutter, cloudflare)
│   ├── themes/              # UI themes
│   ├── prompts/             # Prompt templates
│   ├── settings.json        # Pi settings
│   └── sandbox.json         # Pi sandbox config
├── mcporter/                # mcporter MCP config (mcporter.json, symlinked to ~/.mcporter)
└── flake.nix                # Nix flake — installs packages and wires symlinks via home-manager
```

## WHERE TO LOOK

| Task | Location |
|------|----------|
| Add/edit extension | `pi/extensions/` |
| Add/edit agent | `pi/agents/` |
| Add/edit theme | `pi/themes/` |
| Add/edit prompt | `pi/prompts/` |
| Add/edit agent skill | `pi/skills/` |
| Add/edit MCP server | `mcporter/mcporter.json` |
| Pi settings | `pi/settings.json` |

## ANTI-PATTERNS

* Do NOT compile or `tsc` extensions directly — they are loaded by Pi runtime
* Do NOT write permanent test files for extensions — only temporary behavioral checks
