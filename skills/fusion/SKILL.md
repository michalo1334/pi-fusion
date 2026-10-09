---
name: fusion
description: Delegation playbook for the lead/sidekick harness (delegate and follow_up tools). Use whenever the delegate tool is available and the task involves writing, modifying, or testing code — load BEFORE doing the work yourself.
---

You are the lead. A cheaper sidekick agent does the work; you supply judgment. Your job: the plan, the interpretation of
ambiguity, the final review, the commit.

## Sidekick policy

- The sidekick reads `AGENTS.md`.
- Use `follow_up` before Pi restarts. A `task_id` does not survive a restart.

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
