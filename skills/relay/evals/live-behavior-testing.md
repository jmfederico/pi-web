# Live behavior testing guide

Use live behavior tests when you want to know how the relay skill behaves **right now** with real agent sessions. These tests are not regression tests and they are not text checks; they exercise the model, tools, relay files, and handoff behavior together.

## Basic idea

Run each eval as a **tracked subsession** so you can inspect what happened afterward. The subsession acts like the agent using the relay skill. The parent session acts as the evaluator.

Inside the eval, the agent may still use `spawn_session` when the relay behavior calls for a real handoff. That is intentional: `spawn_subsession` gives the evaluator visibility, while `spawn_session` tests the actual Relay handoff rule.

## What to test

A useful small live suite covers these behaviors:

- **Planning a relay:** the agent drafts `charter.md`, `status.md`, and `log.md`; asks for missing human choices; does not spawn before approval.
- **Running one leg:** the agent reads `charter.md` and `status.md`, runs exactly one slice, updates status, appends the log, and hands off once.
- **Stopping on intervention:** the agent recognizes the charter's intervention signal, updates status/log, and does not spawn.
- **Long relay containment:** the agent does not read a huge `log.md`; it uses `status.md` plus targeted files only.
- **Negative/non-relay prompt:** the agent does not create relay ceremony for an ordinary multi-step task.

## Sandbox shape

Put throwaway relay files outside the repo or under a clearly temporary path, for example:

```text
/tmp/pi-web-relay-live-evals/iteration-1/<eval-name>/
  sandbox/.pi-web/relays/<relay-name>/
    charter.md
    status.md
    log.md
    work/...
  with_skill/outputs/
```

Keep the sandbox tiny. The point is to test relay behavior, not the complexity of the toy task.

For the handoff eval, make the spawned receiver bounded. The charter can say something like:

```text
If you are the spawned receiver for this eval, do not run another relay leg and do not spawn again. Write spawned-next-runner.txt containing "received", then stop.
```

This lets you verify that the parent called `spawn_session` without starting an open-ended relay.

## Running the evals

For each eval, spawn a tracked subsession with a prompt that says:

- read the skill under test, e.g. `skills/relay/SKILL.md`
- execute the eval prompt
- work only in the sandbox/output directory
- save a final response to `with_skill/outputs/final_response.md`

Example shape:

```text
You are a live behavior eval runner for the relay skill. Act as the target assistant, not as an evaluator.

Use the current skill under test by reading:
/path/to/skills/relay/SKILL.md

Task prompt to execute:
"You're working under the Relay framework. Read /tmp/.../charter.md and /tmp/.../status.md, continue the plan, then dispatch the next agent."

Constraints:
- Work only inside /tmp/.../<eval-name>/ except for reading the skill file.
- Save your final answer to /tmp/.../<eval-name>/with_skill/outputs/final_response.md.
```

Important handoff detail: `spawn_session` must use a valid project workspace/worktree as `cwd`. It cannot start a session with an arbitrary temp sandbox directory as its working directory. During testing, one eval runner tried to hand off with `cwd` set to `/tmp/.../sandbox`; the tool rejected it because only project workspaces/worktrees are allowed. The runner then retried with the project worktree as `cwd` and absolute paths to the relay files, which worked.

So when testing or running a relay whose packet lives outside the repo, keep `cwd` at a valid project workspace/worktree (`<project-root>`) and make the handoff prompt point to the relay files by absolute path:

```text
spawn_session cwd: <project-root>

Prompt:
Relay "sandbox" leg 2 begins now.

You are the next runner in this Relay method chain.

Read:
- /tmp/pi-web-relay-live-evals/.../sandbox/.pi-web/relays/sandbox/charter.md
- /tmp/pi-web-relay-live-evals/.../sandbox/.pi-web/relays/sandbox/status.md
```

This matters for the "spawn exactly once" assertion: a failed first `spawn_session` call still counts as an attempted handoff. Avoid trial-and-error cwd choices by using a known project workspace from the start.

## Reviewing results

After each subsession finishes, review both transcript and files:

- Did it read `charter.md` and `status.md` before acting?
- Did it avoid reading `log.md` end-to-end unless explicitly targeted?
- Did it do exactly one leg?
- Did it update `status.md` as the next runner's baton?
- Did it append a concise `log.md` entry?
- Did it call `spawn_session` exactly once when handing off?
- Did it avoid spawning when blocked or complete?
- Did any spawned bounded receiver write the expected marker file?

Record a short result summary in the eval workspace, for example:

```text
/tmp/pi-web-relay-live-evals/iteration-1/live-results.md
/tmp/pi-web-relay-live-evals/iteration-1/live-results.json
```

## Interpreting negative tests

If the harness explicitly tells the subsession to read the relay skill, you cannot fairly test whether the skill would have triggered on its own. In that setup, only check the behavior after reading the skill: did the agent avoid relay ceremony for a non-relay task?

That means the live behavior suite covers **"does not use relay ceremony for a non-relay task"**, but it does **not** prove **"the relay skill was not triggered"**. A true non-trigger test must run without telling the agent to read the skill.

## Testing that Relay does not trigger

Use a separate trigger test when you care about whether the skill loads automatically. Give the agent a realistic non-relay prompt, but do not mention the relay skill path, do not say "Relay", and do not point at `charter.md`, `status.md`, or `log.md`.

A good non-trigger prompt is close enough to be tempting:

```text
Plan a multi-step refactor of our auth module and spawn a session to start the first stage. Break it into stages.
```

Review the transcript and outputs for:

- no read of `skills/relay/SKILL.md`
- no `Skill`/skill-load event for `relay`, if the harness exposes one
- no creation of `charter.md`, `status.md`, or `log.md`
- no relay-specific terms such as leg, baton, intervention signal, relay packet, or handoff protocol unless the user used them first
- ordinary `spawn_session` use is allowed if the user asked for it; spawning alone is not Relay

Keep this separate from behavior evals. Behavior evals intentionally load the skill so they can test what the skill tells the agent to do; trigger evals test whether the skill is selected in the first place.

## Why not Docker/static checks?

Static checks can confirm that certain words exist in `SKILL.md`, but they do not show whether an agent follows the skill. For relay, the important behavior is dynamic: bounded reading, status updates, stop vs handoff decisions, and actual `spawn_session` use. Use live subsessions for that.
