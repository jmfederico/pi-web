---
description: Clarify a goal with the human, then dispatch a Relay in a fresh worktree
argument-hint: "<what the relay should achieve>"
---

Prepare a Relay from the request below in a fresh worktree. Load the `relay` and `relay-runner` skills. This differs from `/relay` only in working location; if the request names an existing target, resolve that choice with the human.

Help the human put into words what they want built, what counts as done, and the relay-specific boundaries, limitations, and conditions. Read supplied specifications and inspect the project only as needed to understand that intent. If the request is empty, ask what they want to achieve with `ask_user`.

Draft `.pi-web/relays/<name>/charter.md`, `status.md`, and `log.md` in this checkout under the runner skill's packet convention. Mark status **Draft — awaiting approval; not dispatched**. Capture the requested outcome and any details the human explicitly asks to include, not an agent-invented implementation plan. Leave project rules and skill discovery to each runner; do not turn them into relay instructions. The first runner chooses the first useful slice.

Point the human to the draft, summarize the goal, boundaries, and proposed working location, and resolve material questions together through `ask_user`. Once the goal is understood, ask **Approve and dispatch**, **Revise**, or **Do not dispatch** against the final draft. Drafting and the initial request are not dispatch approval.

On revision, update the draft and obtain approval. On refusal, record that it was not dispatched and stop. After explicit approval, create the worktree and move the packet there as described in the runner skill. Record approval, finalize the packet, and dispatch one fresh session in that worktree. After dispatch, provide only a brief summary.

<relay_task>
$ARGUMENTS
</relay_task>
