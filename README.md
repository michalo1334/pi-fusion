# pi-fusion

This extension implements a lead/sidekick harness for Pi. The lead owns requirements, decisions, review, and commits.
The sidekick implements and checks delegated work.

This is an installable Pi package from [`michalo1334/pi-fusion`](https://github.com/michalo1334/pi-fusion), forked from
[`JoniBR/pi-fusion`](https://github.com/JoniBR/pi-fusion). It retains the agent library's sidekick policy and
compatibility fixes. See `PROVENANCE.md` for the upstream commit and license declaration.

## Installation

From the consuming project's root:

```sh
pi install git:github.com/michalo1334/pi-fusion --local
```

Review the package before granting project trust. Pi loads the extension and lead skill from this package; do not also
copy them into `.pi/extensions/` or `.pi/skills/`. Restart Pi after installation. Use Pi's package updater for updates.

## Tools

- `delegate(brief)` starts a sidekick with a new context. It returns a report and a `task_id`.
- `follow_up(task_id, message)` continues that sidekick context. A task ID works only while the same Pi process runs. Pi
  saves the sidekick session file. You can inspect it with `pi --resume` after a restart, but `follow_up` cannot reopen
  it.

## Lead skill

The package provides the `fusion` delegation playbook from `skills/fusion/SKILL.md`. Pi discovers it through the package
manifest. The lead loads it before delegation. The sidekick does not load it.

## Sidekick environment

The sidekick reads project context files, including `AGENTS.md`. It does not load skills, prompt templates, or themes.
It does not load arbitrary project extensions. It cannot call `delegate` or `follow_up`, so it cannot create or continue
nested sidekicks. Configuration that requests those tools or the Fusion extension fails before the sidekick starts.

`fusion.sidekickTools` is an exact tool allowlist. The supported values are:

- Pi built-ins: `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls`.
- MCP adapter tools: `mcp`, `mcpScript`, `mcp__blender_mcp`, `mcp__svelte`, and `mcp__web_search`.

`fusion.sidekickExtensions` selects the package extensions that the sidekick loads. The supported values are
`pi-mcp-adapter` and `context-mode`. Select `pi-mcp-adapter` when `sidekickTools` contains an MCP adapter tool.

The sidekick loads the selected `context-mode` extension for its commands and hooks. The configured tool allowlist does
not include `ctx_*` names. Loading a package does not automatically permit every tool it provides.

A policy change applies to a new `delegate` call. A `follow_up` call keeps the existing sidekick session and tool set.

## Configuration

Set the sidekick model, timeout, tools, and extensions in `.pi/settings.json` or the user-level Pi settings:

```json
{
  "fusion": {
    "sidekickModel": "provider/model[:thinking]",
    "timeoutMinutes": 10,
    "sidekickTools": ["read", "bash", "edit", "write", "grep", "find", "ls"],
    "sidekickExtensions": []
  }
}
```

Run `/fusion-model` without an argument to select a provider and model in the Pi TUI. Use
`/fusion-model provider/model[:thinking]` to set a value directly. `PI_FUSION_MODEL` overrides settings. The slash
command overrides both.

## Development checks

Use Node.js with TypeScript stripping support. Install dev dependencies with `npm ci --ignore-scripts`. Run `npm test`
and `npm run check`. The integration tests load the package through Pi and create an isolated session without making
model requests. Policy tests check that the sidekick cannot load Fusion or call its delegation tools.
