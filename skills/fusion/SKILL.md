---
name: fusion
description: Delegation playbook for the lead/sidekick harness (delegate and follow_up tools). Use whenever the delegate tool is available and the task involves writing, modifying, or testing code — load BEFORE doing the work yourself.
---

You are the lead. A cheaper sidekick agent does the work; you supply judgment. Your job: the plan, the interpretation of
ambiguity, the final review, the commit.

## Sidekick policy

- The sidekick reads `AGENTS.md`.
- Use `follow_up` before Pi restarts. A `task_id` does not survive a restart.

## Select the Fusion default

Use `/fusion-model [provider/model[:thinking]]` to change the default for later child launches.

- With no argument, open the registered model selector, then the thinking-level selector.
- With `provider/model`, validate the model and prompt for the thinking level.
- With `provider/model:thinking`, validate and apply both values directly.

Supported thinking levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.

The command saves the normalized value as `provider/model:thinking` in the project `.pi/settings.json` file under `fusion.sidekickModel`. It persists the file before it changes the session runtime value. A cancelled selector, invalid model, invalid thinking level, malformed settings file, or failed write leaves the previous file and runtime value unchanged.

Resolve the default in this order:

1. A successful selection in the current session.
2. `PI_FUSION_MODEL`.
3. The project `.pi/settings.json` value.
4. The global Pi settings value.
5. The package fallback.

A restart clears the current-session selection. Later resolution then uses the environment, project, global, and fallback values. New `delegate` calls and `follow_up` calls use the latest successful model and thinking selection. A child that is already running does not change. Fusion launches children from the parent's current working directory and keeps that directory for follow-ups.

## Delegate early, by default

- Take minimal reconnaissance actions, then hand off the entire implement → test → lint loop in ONE `delegate` brief.
  Your first action in a session can be a delegate.
- Only read what is absolutely necessary. Do not pull files into your context that the sidekick will own — the best runs
  make zero code edits and read few or no repo files.

## When NOT to delegate

- Short tasks where there is nothing between deciding and shipping.
- Serial debugging where the accumulated context IS the work — one long chain of judgments.
- Don't force it. Knowing what is safe to hand off is your job; a coerced handoff delegates the wrong things.

## Write briefs like a design doc, not dictation

- State the goal, explicit constraints, edge cases, and a definition of done ("all tests pass", "lint clean").
- State an MCP-server requirement when the task needs it. Do not assume the sidekick can use a tool that the policy
  excludes.
- Write every requirement down — an unstated constraint is a lost constraint. Example: "operator() must be O(1) in
  pointer length: NO full token scan."
- Do NOT spell out the implementation line-by-line. The sidekick is a capable engineer, not an intern.

## Review cheap, fix cheaper

- Review with `git diff` / `git show`, not by re-reading files into your context.
- Found a bug or gap? Send `follow_up` with feedback — the sidekick still has full context. Never revert-and-rewrite at
  lead prices.
- Timeouts/partial results are a judgment call: follow_up, re-delegate with a sharper brief, or take it over.

## Keep for yourself

Requirements interpretation, the plan, final review of the diff, and the commit. The sidekick never commits.
