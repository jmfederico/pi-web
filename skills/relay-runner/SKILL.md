---
name: relay-runner
description: "Prepare and run Relay legs in Pi: keep the goal, baton, and log durable, then hand off to one fresh session or stop visibly. Use with relay for /relay, /relay-worktree, or a handoff naming relay-runner. Supplies continuity and a bounded fresh-context final review without prescribing the development route."
---

# Relay runner

This skill binds the `relay` method to Pi sessions and a small file packet. It supplies continuity and one completion gate: a fresh-context final review. The development route remains adaptive. Each agent discovers applicable project instructions and skills through the repository and harness; do not copy them into the packet or preselect them for future legs.

## Packet

Use `.pi-web/relays/<name>/` in the working checkout unless the user selects another location. Start with three files:

- **`charter.md` — goal.** The agreed outcome and recognizable finish line, relay-specific scope boundaries and clarifications, and any explicit human requirements. Reference an existing specification when useful. Do not add project rules, implementation plans, or generic quality or delivery procedures; include such details only when the human explicitly asks.
- **`status.md` — baton.** State (`Draft — awaiting approval; not dispatched`, `Active`, `Complete`, or `Needs help`), last completed leg and next leg number, working location, current progress, remaining gaps to the goal, relevant checks, current review state, targeted pointers, and blockers. Include only what is useful now. Avoid suggesting the next slice; record remaining gaps and concrete dependencies instead.
- **`log.md` — history.** Append a short entry per leg: what changed or was learned, important decisions and why, artifact or commit references, checks and actual results, and the next leg or stop. Record human approval and scope changes here too.

Charter = agreement; status = position; decisions = durable reasoning; log = history. Keep revisions in the log, not a separate revisions document; no decision template is required. Status, decisions, and the log cannot silently change the agreement. Keep relay-specific decisions durable without adding documents merely to satisfy a template. The packet is not a second home for project policy or this skill's instructions.

Add **`decisions.md` only when useful**: a compact, living record of consequential decisions and their reasons, including rejected approaches or review concerns worth remembering. Keep current conclusions there and record revisions in the log. Link it from status and consult relevant entries rather than duplicating the reasoning in the baton. It is not a plan, task list, or another home for project rules. Human changes to the goal or scope still belong in the charter. Do not create an empty register or impose a decision template.

For an existing packet, keep explicit human decisions from older files available through targeted pointers. Do not turn format migration into a leg. If it is unclear whether an old instruction is a human requirement or generated procedure, ask before discarding a material condition.

## Preparation and dispatch

The preparation prompt owns discussion and approval. Drafting is allowed before approval; `spawn_session` is not. After the human reviews the goal and boundaries, require an explicit **Approve and dispatch** response. If the approved goal, scope, or working target changes materially, obtain fresh approval.

Use the current checkout for `/relay` unless the user chooses another. For `/relay-worktree`, create a fresh branch and worktree after approval, following project conventions; use current HEAD as the starting point unless another base is agreed. Ask about a material target ambiguity rather than guessing. Move the draft packet into the target checkout before dispatch, update its location, and remove the stale drafting copy.

Record the actual checkout and, in Git, branch and starting commit in status. Keep packet files out of delivery commits using an existing ignore rule or a local Git exclusion. Leave unrelated existing work untouched. Bootstrap the target as needed under project conventions; setup does not automatically require a separate leg.

Record approval in status/log, mark status `Active`, and seed leg 1. The first runner chooses its own slice; preparation need not prescribe one. Dispatch with the same handoff mechanics used by later legs.

## Run a leg

1. Read the charter and status, then inspect relevant project guidance and work. Consult only the history or supporting material needed to understand the current state. Repair small record gaps with targeted inspection; ask for help if the goal or ownership is unclear.
2. Compare reality with the finish line and completion requirements, including the final review below. If all are satisfied, record completion and stop. Otherwise choose one useful, context-sized slice that closes a remaining gap. Explain briefly what it advances. Choose from the goal and current evidence, not a predecessor's proposed task.
3. Do the work and the checks appropriate to it under project conventions. Prefer meaningful progress over isolated micro-tasks; do not broaden into unrelated improvements. Record failed, skipped, or incomplete checks honestly.
4. Make the result durable before handoff. In Git, commit the leg's changes when project policy and human instructions permit, without including unrelated changes or the packet. Otherwise record the exact saved work and why it is uncommitted. Finish any helpers before handing off.
5. Refresh the compact status and append the log entry. Record progress against the goal, important evidence and decisions, remaining gaps, and any limitations the successor needs to know. Then complete, ask for help, or hand off once.

Other reviews, delivery steps, and gates apply only when the human or project requires them. Keep this skill's review procedure here, not copied into the packet.

## Final review

When a leg finishes substantive work and believes implementation is done, record that final review is pending and hand off to a fresh leg. A fresh runner finding implementation complete with review pending performs the review instead of passing it on again. Leave substantive corrections to another leg so the review stays independent.

Review the whole relay result, not just the last slice, against the charter and applicable project guidance. Approve when no concrete, evidence-backed in-scope blocker remains. Optional improvements, speculative concerns, and unrelated pre-existing shortcomings do not block completion. Record consequential finding dispositions in `decisions.md` when useful.

Allow **at most three review attempts total**: the initial review and up to two post-correction reviews, not three mandatory passes. Keep the attempt count, latest result, and reviewed work reference in status; put evidence and findings in the log or link to decisions. Subsequent attempts happen only after concrete corrections and focus on those corrections and changed evidence, carrying supported prior decisions forward rather than restarting an expanding audit.

If the third attempt still has blockers, or a required further review would exceed the budget, mark `Needs help`, record what remains, and stop without dispatching another review or correction leg. A valid approval satisfies the gate; a new context or packet-only update does not reopen it. Material changes to the reviewed result require re-review within the same budget.

## Stop or hand off

Mark `Complete` and report the result and evidence when no required work remains and final review has passed for the current result. Do not spawn a successor to search for extra work.

Mark `Needs help` when a decision, permission, environment problem, or lack of progress prevents responsible continuation. Record the concrete blocker, attempts and evidence, and the smallest question or action needed from the human. Surface it clearly in the user-facing response; use `ask_user` when an answer is needed. Do not hand a human-dependent blocker to another context hoping it will disappear.

Before continuing, check that concrete required work remains, including any pending final review; leave slice selection to the successor. Repeated investigation or remediation without new evidence or meaningful progress is a stall to signal, not a reason to extend the chain. Carry supported prior decisions forward so fresh contexts do not restart settled debates.

For handoff, finish work and all packet writes first. Call `spawn_session` at most once, with the target checkout as `cwd`. Omit `model` and `thinkingLevel` to inherit them unless the human instructed otherwise; keep any relay-wide instruction in the packet. Use an independent session, not a tracked subsession, for the successor.

Keep the successor prompt short, substituting actual paths and the next leg number:

```text
Continue Relay "<name>", leg <N>, in <checkout>.
Load the `relay` and `relay-runner` skills.
Read <packet>/charter.md and <packet>/status.md.
Check the finish line against the current work and choose the next useful slice.
Make progress and the record durable, then hand off once, complete, or signal that you need help.
```

`spawn_session` is the final operational action. After it returns, give only a brief handoff summary: no further tool use, packet writes, work, or downstream supervision. If dispatch fails, report the failure rather than claiming the next leg started.
