# fusion (Claude Code plugin)

Lead/sidekick multi-model harness for Claude Code — a port of
[pi-fusion](https://github.com/JoniBR/pi-fusion). The lead session delegates
whole implement→test→lint loops to a cheap sidekick agent that runs in its own
persistent context (Devin Fusion pattern).

## What it ships

- `bin/fusion-delegate "brief"` — spawn a fresh sidekick (`claude -p`), print
  its report and `session_id`.
- `bin/fusion-followup <session_id> "message"` — continue that sidekick in the
  same context (`claude -p --resume`).
- `skills/fusion` — the delegation playbook the lead loads before coding tasks.

## Install / test locally

```bash
claude --plugin-dir /path/to/pi-fusion/claude-plugin
```

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `FUSION_SIDEKICK_MODEL` | `sonnet` | Sidekick model |
| `FUSION_SIDEKICK_ARGS` | _(empty)_ | Extra `claude` flags for sidekick runs |

Note: sidekicks run with `--allowedTools "Bash Edit Write Read Grep Glob WebFetch"`,
i.e. they can execute shell commands without prompting. Inspect sidekick
sessions afterwards with `claude --resume <session_id>`.
