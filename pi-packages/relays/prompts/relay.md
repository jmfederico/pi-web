---
description: Clarify a goal with the human, then dispatch a Relay
argument-hint: "<what the relay should achieve>"
---

Prepare a Relay from the request below. Load the `relay` and `relay-runner` skills. Use the current checkout unless the human chooses another working location.

Help the human put into words what they want built, what counts as done, and the relay-specific boundaries, limitations, and conditions. Read supplied specifications and inspect the project only as needed to understand that intent. If the request is empty, ask what they want to achieve with `ask_user`.

Draft `.pi-web/relays/<name>/charter.md`, `status.md`, and `log.md` under the runner skill's packet convention. Mark status **Draft — awaiting approval; not dispatched**. Capture the requested outcome and any details the human explicitly asks to include, not an agent-invented implementation plan. Leave project rules and skill discovery to each runner; do not turn them into relay instructions. The first runner chooses the first useful slice.

Point the human to the draft, summarize the goal and boundaries, and resolve material questions together through `ask_user`. Once the goal is understood, ask **Approve and dispatch**, **Revise**, or **Do not dispatch** against the final draft. Drafting and the initial request are not dispatch approval.

On revision, update the draft and obtain approval. On refusal, record that it was not dispatched and stop. After explicit approval, record it, finalize the packet, and dispatch one fresh session using the runner skill's handoff mechanics. After dispatch, provide only a brief summary.

<relay_task>
$ARGUMENTS
</relay_task>
