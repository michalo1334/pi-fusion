# pi-fusion

This package gives a lead Pi session two blocking tools for restricted sidekick tasks. Each sidekick runs as a child Pi TUI in an owned Zellij pane.

The lead owns requirements, decisions, review, and commits. The sidekick works from the brief and returns a report.

This is an installable Pi package from [`michalo1334/pi-fusion`](https://github.com/michalo1334/pi-fusion), forked from [`JoniBR/pi-fusion`](https://github.com/JoniBR/pi-fusion). It retains the agent library's sidekick policy and compatibility fixes. See `PROVENANCE.md` for the upstream commit and license declaration.

## Installation

From the consuming project's root:

```sh
pi install git:github.com/michalo1334/pi-fusion --local
```

Review the package before you grant project trust. Pi loads the extension and lead skill from this package. Do not copy them into `.pi/extensions/` or `.pi/skills/`. Restart Pi after installation. Use Pi's package updater for later updates.

## Lead skill

The package provides the `fusion` delegation playbook from `skills/fusion/SKILL.md`. Pi discovers it through the package manifest. The lead loads it before delegation. The sidekick does not load it.

## Zellij is required

Fusion supports Zellij only. It does not support cmux, tmux, WezTerm, or a headless fallback.

Start Pi inside an active Zellij session:

```sh
zellij
pi
```

Run `delegate` from that Pi session. Fusion checks the Zellij environment marker, the `zellij` executable, and the host pane ID before it creates a task. The numeric pane ID `0` is valid. If the marker or executable is missing, or if `ZELLIJ_PANE_ID` is missing or invalid, Fusion returns setup guidance and does not create a child.

Fusion was tested with Pi 1.1.0 and Zellij 0.45.1. The current child launch protocol requires Linux because it records Linux `/proc` process identity before startup. It aborts child launch on other operating systems. Fusion does not claim macOS or Windows child-launch support. It uses these public Zellij actions: `list-panes`, `new-pane`, `new-tab`, `write-chars`, `write`, `send-keys`, `dump-screen`, `focus-pane-id`, and `close-pane`. A different Zellij version can change these commands or their output.

## Delegate lifecycle

`delegate(brief)` does the following:

1. Checks Zellij and the selected sidekick model before task creation.
2. Creates a process-local task ID, a stable child session ID, and private run artifacts.
3. Seeds one child session header in the lead session directory with `parentSession` set to the persisted lead file.
4. Opens a split pane. It can use a stacked pane or a new tab when the layout needs it.
5. Restores focus to the lead pane and targets the child by its explicit pane ID.
6. Starts one restricted child Pi TUI turn and waits for it to settle.
7. Reads the new session report and usage from the run cursor.
8. Closes the pane only after a successful run.
9. Returns the report, status, cost, session path, and `task_id`.

The tool blocks until the child settles or fails. It does not return an early acknowledgement. Prompt text stays in a private artifact file and is not placed in a shell command.

## Follow-up lifecycle

`follow_up(task_id, message)` opens a new pane and resumes the same child session. It blocks until the new turn settles. It returns only the new report and the new usage. It does not charge or repeat the earlier run.

Task IDs and the task map exist only in the current parent Pi process and extension generation. A Pi restart or `/reload` invalidates old task IDs. Fusion does not reconstruct tasks after a restart. A follow-up also requires an intact saved session and cursor. A failed run can accept a follow-up only when Fusion reports that the session evidence remains valid and cleanup is complete.

A task accepts only one active run at a time. A second follow-up for the same task returns a busy error. Separate tasks use the process-wide placement lock so concurrent pane creation does not race.

## Pane cleanup and cancellation

| Run state | Pane and session behavior |
| --- | --- |
| Success | Fusion closes the child pane after it reads the report. The session and run artifacts remain. |
| Provider, tool, policy, startup, or session error | Fusion keeps the pane and artifacts for inspection. |
| Timeout, parent cancellation, or user-closed pane | Fusion stops waiting, tries the owned child stop sequence, and keeps the inspection pane when it still exists. |
| Parent `/reload` or shutdown | Fusion cancels active children, waits for bounded cleanup, and does not close inspection panes. |

Cleanup is idempotent. If Fusion cannot confirm cleanup, it keeps an in-memory cleanup control and writes `cleanup-state.json` in the run artifact directory. The tool result includes `cleanupPending` and an error when available. Inspect that artifact and the pane before retrying or ending the parent session. Do not target a pane by its current focus. Fusion uses the recorded pane ID and a verified child PID.

Child sessions use the Pi `parentSession` header field. The normal Pi session browser discovers the child under the lead when both files are in the lead session directory. An ephemeral lead session has no authoritative parent file, so Fusion rejects `delegate` before child allocation. Fusion does not migrate older child files or copy lead conversation entries.

The safe child-PID protocol uses Linux `/proc/<pid>/stat` identity data. Safe numeric PID termination is currently supported only on Linux. Fusion does not claim safe forced termination on macOS or Windows. A child that cannot establish this identity remains a failed run instead of receiving an unverified numeric signal.

## Errors and troubleshooting

- **No active Zellij or missing executable:** Start `zellij`, then start Pi inside it. Check that the `zellij` executable is on `PATH`.
- **Missing or invalid parent pane ID:** Start Pi from the Zellij pane that should own the child. A numeric `ZELLIJ_PANE_ID` is required; `0` is valid. Do not set a pane ID from another session.
- **Selected model is unavailable:** The lead must resolve the provider and model before it creates a task. Check the provider setup, or run `/fusion-model` and select an available model. A model change applies to later `delegate` and `follow_up` launches. It does not change a child that is already running.
- **Child policy readiness failure:** The child disables tools first, waits briefly for selected extensions to register, and then checks the exact requested tool names. A missing tool, recursive Fusion tool, or readiness timeout fails before the model turn and leaves the pane and `runtime-error.json` available for inspection. A missing selected extension fails before child pane creation.
- **Lost pane:** If the user closes the child pane, Fusion reports a surface-loss error. The child session may still be usable only if the returned session evidence is complete. Do not assume that screen text proves completion.
- **Session integrity error:** A truncated, replaced, or rewritten session file cannot be resumed. Start a new task with `delegate`.
- **Timeout or cancellation:** Increase `timeoutMinutes` only for a new task when the work needs more time. Fusion first sends an interrupt, then uses the owned PID identity for bounded termination on Linux. The failed pane remains open when possible.
- **Failed cleanup:** Read `cleanup-state.json`, the run `exit.json`, and the pane transcript. A task with unresolved cleanup rejects `follow_up` until cleanup is confirmed.

## Child resources and policy

Fusion passes the selected provider, model, thinking level, and exact pre-seeded session file to the child. The child opens that file with `--session`, so follow-ups keep the same file and parent header. The parent applies the configured timeout to each child run. The child loads no discovered context files, skills, prompt templates, themes, or arbitrary project extensions. It loads only the child runtime and the explicitly selected extension paths. Fusion itself is excluded, so the child cannot call `delegate` or `follow_up`.

`fusion.sidekickTools` is a tool-name allowlist. Supported names are:

- Pi built-ins: `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls`.
- MCP adapter names: `mcp`, `mcpScript`, `mcp__blender_mcp`, `mcp__svelte`, and `mcp__web_search`.

The child checks that these names are registered and active before it accepts input. An allowed adapter or gateway name can still reach capabilities controlled by that adapter or its server. The list does not prove server-side authorization or describe every action behind an opaque tool. Configure MCP servers and their permissions separately.

`fusion.sidekickExtensions` supports `pi-mcp-adapter` and `context-mode`. Select `pi-mcp-adapter` when the tool list includes an MCP adapter name. Loading an extension does not automatically allow every tool that it provides. Fusion fails closed when a selected extension path is missing or a requested tool is not ready.

## Configuration

Set values in `.pi/settings.json` or the user-level Pi settings:

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

The public configuration values are:

- `sidekickModel`: provider, model, and optional thinking level.
- `timeoutMinutes`: maximum time for each child turn.
- `sidekickTools`: exact tool names passed to the child policy.
- `sidekickExtensions`: supported explicit extension IDs.

### Change the Fusion default

Use this command:

```text
/fusion-model [provider/model[:thinking]]
```

The command uses the lead Pi model registry. The selected model must be available there.

- With no argument in TUI mode, the command opens Pi’s model selector and then a thinking-level selector. RPC and
  other non-TUI users must pass `provider/model[:thinking]` explicitly.
- With `provider/model`, the command validates the model and prompts for the thinking level.
- With `provider/model:thinking`, the command validates and applies both values directly.

The supported thinking levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.

For example, `/fusion-model openai/gpt-5:high` selects a model and thinking level in one command.

Fusion saves the normalized value as `provider/model:thinking` in the project file `.pi/settings.json` under `fusion.sidekickModel`. The command writes the file before it changes the current session value. A failed write leaves the current session value unchanged. A cancelled selector, invalid model, invalid thinking level, malformed settings file, or other persistence error does not overwrite the file or change the runtime value.

Fusion resolves the default in this order for each child launch:

1. A successful `/fusion-model` selection in the current session.
2. `PI_FUSION_MODEL`.
3. The project value in `.pi/settings.json`.
4. The user-level Pi settings value.
5. The package fallback.

A Pi restart clears the session selection. The normal environment, project, global, and fallback order then applies. Therefore, `PI_FUSION_MODEL` can temporarily take priority over the persisted project value after a restart.

New `delegate` calls resolve the latest successful model and thinking selection immediately before launch. `follow_up` calls do the same. They do not reuse the model captured by the earlier run. A running child keeps its current model and thinking level. Fusion starts child launches from the parent's current working directory. A follow-up keeps the saved child session and its working directory.

## Cost accounting

Each run reports the child provider usage and `cost_usd`. Fusion records each run ID once and rolls its cost into the next parent-session assistant usage message. A follow-up adds only its new usage. Reload and shutdown preserve pending cost for the same parent session, while a different parent session cannot consume it. Offline faux-provider tests use zero cost by design; they prove no billing, not production price arithmetic. Arithmetic regressions are covered by the runner and parser unit tests.

## Development checks

Use Node.js with TypeScript stripping support. Install development dependencies with `npm ci --ignore-scripts`. Run:

```sh
npm test
npm run check
```

`npm test` runs the offline child, lifecycle, policy, parser, and package tests. It uses local provider fixtures and makes no paid provider or network requests. `npm run test:real` runs the model-free Zellij surface and real child-TUI checks with one test worker. It skips with an explicit reason when Zellij is inactive or its executable is missing. It does not use a paid provider.

The package manifest exposes only `extensions/fusion.ts` and `skills/`. The child runtime is loaded by the child process and is not a public package extension entry point.
