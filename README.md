# pi-fusion

Lead/sidekick multi-model harness for [pi](https://github.com/badlogic/pi-mono), after the [Devin Fusion](https://cognition.com/blog/devin-fusion) pattern: your session's frontier model stays in the lead seat (plan, ambiguity, review, commit) and delegates the implement → test → lint loop to a cheaper sidekick agent.

Each `delegate` spawns a sidekick with fresh context; `follow_up` continues the same task in its persistent, cache-friendly context. Sidekick sessions are saved as normal pi sessions (`pi --resume` to inspect).

## Install

```bash
pi install /path/to/pi-fusion   # or git:github.com/you/pi-fusion
```

## Tools

- `delegate(brief)` — fresh sidekick, blocks, returns report + `task_id`
- `follow_up(task_id, message)` — continue that sidekick's cached context

## Skill

`fusion` — the delegation playbook (delegate early, spec-quality briefs, review via `git diff`, follow_up over rewrite).

## Config

In `~/.pi/agent/settings.json` or `.pi/settings.json`:

```json
{
  "fusion": {
    "sidekickModel": "anthropic/claude-sonnet-4-6:high",
    "timeoutMinutes": 10
  }
}
```

`sidekickModel` uses pi's `provider/model[:thinkingLevel]` syntax.

Override the sidekick model without editing settings (highest precedence first):

- `/fusion-model provider/model[:thinking]` — set for the current session (no args: show current)
- `PI_FUSION_MODEL=provider/model[:thinking] pi` — set at launch

Model changes apply to new `delegate` calls; existing tasks keep their model.
