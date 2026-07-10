---
name: relay
description: "How the Relay method works: executing a plan as a chain of independent sessions that each do one slice and hand off to the next via spawn_session. Load this skill only when you already know you are in a relay: a prompt states you are working under the Relay framework (or relay/chain), points you at a relay charter/status/log, or the user invokes this skill directly. Do not load it for generic multi-step plans or ordinary spawn_session use."
---

# Relay

Relay is a way to execute a long or complex plan as a chain of independent sessions. Each session runs **one leg** — a single well-sized slice of the work — then hands the work off to a fresh session that runs the next leg. The chain continues until the goal is reached.

There is no coordinator and no referee. Each runner is the coordinator for their own leg: smart enough to do the work, adapt to what they discover, and hand off cleanly. Trust is distributed to every agent, not held by a god-agent above them.

Relay works because it does not try to recreate human management structures. The point is fewer boundaries, less hierarchy, and more fluid execution. The thing that makes that safe is **context containment**: every leg starts with a fresh, small context, and the accumulated knowledge lives in compact documents on disk rather than in any one session's memory.

## The hard constraint that shapes everything

`spawn_session` is fire-and-forget. When you spawn the next leg, **you do not see its output and you cannot correct it.** The only thing that travels down the chain is what you wrote to disk. A human may be watching in the UI, but they intervene by reading your documents, not by relaying messages between sessions.

Two consequences follow, and they govern the whole method:

- **Make your work durable before you hand off.** Update the status, append the log, save/commit the artifacts (commit if the relay says to), and only then spawn the next leg. Anything not on disk is lost.
- **Hand off exactly once, at the end.** Do not spawn early, do not spawn several runners "to parallelize," and never spawn while you still have work in flight. One leg, one handoff.

## The relay packet

A relay is carried by a small packet of documents. By default they live in `.pi-web/relays/<name>/` unless the user or the dispatching prompt says otherwise — always follow an explicit location if given.

Every relay has these three core files:

**Charter** (`charter.md`) — the stable agreement, written when the relay is planned. It must contain, at minimum:

- **Relay identity.** The relay name and root path, so runners know exactly which relay they are on.
- **Goal / finish line.** A concrete, achievable end state. Without this the relay runs forever — this is non-negotiable.
- **Sizing.** How much is *one leg*? This is project- and plan-specific; the charter defines it (a task, a slice, a time/scope budget — whatever fits). The skill does not decide this for you.
- **Task selection policy.** How a runner chooses the next task when `status.md` does not name one explicitly.
- **Handover.** How a runner hands off: what the spawn prompt should say and what the next runner must read. A normal handoff starts with a natural header containing the relay name and next leg number, then points at `charter.md` and `status.md`, not the full log.
- **Intervention signal.** When and how a runner must stop and get the human, and how that is made visible. The charter must define this; the skill does not define it for you.
- **Reading discipline.** The files a runner should read to orient, and any files that should not be read defensively.

The charter *can* be edited, but it should rarely *need* to be. If it is changing every leg, that is a smell — the design wasn't settled, or the goal is drifting. Treat frequent charter edits as a reason to stop and involve the human.

**Status** (`status.md`) — the compact baton/current state. This is the file every runner reads after the charter, and every runner updates before handoff or stop. Keep it short enough that a fresh runner can load it cheaply. It should answer:

- **Current position.** Where the relay is now.
- **Current or next task.** The next leg if known; otherwise enough information to apply the charter's task selection policy.
- **Leg tracking.** The last completed leg and the next leg to run. Keep this explicit so runners do not have to infer whether “current leg” means the leg just finished or the leg being handed off, and so new PI-WEB sessions can distinguish relay legs from the first line of their prompt without naming instructions.
- **Relevant context.** Only the files, sections, commands, artifacts, or specific log entries needed for the next leg.
- **Progress documentation.** Where this runner must write progress: update `status.md`, append `log.md`, update artifacts, commit, etc.
- **Blockers / intervention state.** Current risks, open decisions, or active reasons to stop.

Think of `status.md` as the thing passed from runner to runner. If it grows into a history dump, compress it back into current state plus pointers. If an older relay lacks leg tracking, repair it when you update status; prefer the leg number from the prompt or status, and do not read `log.md` end-to-end just to count prior legs.

**Log** (`log.md`) — append-only history. Each leg appends a concise entry recording what it did, decisions made and why, durable artifacts changed, status updates made, and blockers. The log preserves auditability, but it is **not** orientation memory.

Do not read `log.md` end-to-end by default. Read targeted log entries only when `status.md` points to them, when the charter requires a specific lookup, or when there is an inconsistency you must resolve before continuing.

Optional files such as `plan.md`, `backlog.md`, or artifact notes are fine, but runners should read them only when the charter/status points to the relevant part.

## Context containment rule

A runner normally reads:

1. `charter.md`
2. `status.md`
3. Only the specific files or log entries referenced for the current leg

Do not defensively rebuild the relay's full history. Do not read the full log, the full backlog, or a large artifact tree just because they exist. The relay stays scalable because each runner pays only for the context needed now.

If `status.md` is insufficient, fix the baton rather than compensating by reading everything. Use targeted inspection to clarify the current state, update `status.md` so the next runner has a clean start, and continue only if the task is still clear. If reconstructing the state would require broad archaeology or judgment about past intent, stop and raise the intervention signal.

## Running one leg

This is the loop you run when you are dispatched into a relay.

1. **Orient from the packet.** Read `charter.md` and `status.md`. Confirm the relay name/root, goal, sizing, handoff protocol, last completed leg, next leg to run, intervention signal, and current/next task. If you are not sure you are in a relay, the prompt or `.pi-web/relays/` is your clue — and reading this skill means you are.
2. **Choose the leg.** Prefer the explicit current/next task in `status.md`. If none is named, apply the charter's task selection policy. If that still requires context, inspect only the referenced plan/backlog/artifact sections. If the next task is still ambiguous or would materially change direction, stop and involve the human.
3. **Re-anchor to the goal.** Does the goal still make sense given the status and what you now see? If reality has diverged from the charter, that is often an intervention moment — don't quietly redefine the task.
4. **Run one leg.** Do exactly one well-sized slice, per the charter's sizing. Resist doing "just a bit more" — extra scope bloats context and breaks the containment that makes Relay work.
5. **Document progress.** Make all work durable. Update `status.md` with the new current state, last completed leg, next leg to run (if any), next task or task-selection pointer, relevant context for the next runner, and blockers. Append a concise `log.md` entry with what you did, why, decisions made, artifacts changed, and whether you are handing off or stopping.
6. **Decide: hand off, or stop.**
   - **Hand off** if there is a clear next leg and you are on track. Use `spawn_session` once, with a prompt whose first line is a natural task header containing the relay name and next leg number (for example, `Relay "<name>" leg <N> begins now.`), followed by the Relay method and pointers to `charter.md` and `status.md` (so this skill loads and they can orient cheaply). Then you are done. Handoff is deliberately fire-and-forget: `spawn_session` starts an independent session you will not see and cannot steer — do not reach for a tracked subsession to keep an eye on it. Letting go is the point. The next runner is trusted to run their own leg, and the relay packet is the only thread between you; if you feel the need to watch downstream work, that usually means the leg wasn't sized or handed off cleanly, or an intervention signal should have fired.
   - **Stop — do not spawn —** if the goal is reached, or you are blocked, or the charter's intervention signal fires. Update `status.md`, append a clear note in `log.md`, and raise the intervention signal so the watching human sees exactly what happened and what they need to decide. A stalled relay that stopped cleanly with a clear blocker is a success; a relay that spawned a confused next runner is a failure.

A good handoff prompt is short and explicit. Put the relay identity and leg number at the very beginning so PI-WEB's session title generator sees useful distinguishing context without any naming instruction:

```text
Relay "<name>" leg <N> begins now.

You are the next runner in this Relay method chain.

Read:
- .pi-web/relays/<name>/charter.md
- .pi-web/relays/<name>/status.md

Do not read log.md end-to-end. Use it only for targeted lookup if status.md or charter.md points you there.

Run one leg according to the charter. Before handing off, update status.md, append log.md, make work durable, then either spawn the next leg once or stop with a clear intervention note.
```

## Planning a relay

When the user asks to set up a relay, your job is to produce the relay packet: `charter.md`, `status.md`, and `log.md`. The charter must have the required slots filled: relay identity, goal, sizing, task selection policy, handover, intervention signal, and reading discipline. The initial status must give the first runner a compact baton: current position, leg tracking (usually last completed leg 0 and next leg to run 1 for a new relay), first task or task selection pointer, relevant context, documentation expectations, and known blockers. The log may start empty or with a short seed entry explaining that the relay was created.

Draw the required choices out from the user rather than inventing them: ask what the finish line is, how much should be one leg, how runners pick tasks, how runners hand off, what they should read, and when they must stop and get the human. Sizing, task selection, and the intervention signal especially are the user's to decide — propose options if it helps them think, but do not quietly settle them yourself.

Do **not** impose what a "good" plan, leg size, or cadence looks like — those are deeply project-, plan-, and human-specific, and getting them wrong by being prescriptive is worse than leaving them to the user. Your value in planning is making sure the relay is *runnable*: the finish line exists, sizing is stated, task selection is stated, handover is stated, reading discipline is stated, and the intervention signal is stated. Once the packet is agreed, you can dispatch the first leg with `spawn_session`.

## Smells to watch for

- **No finish line** → infinite relay. Refuse to run a relay without a defined goal.
- **Goal drift** → each leg quietly restates the task. Re-anchor every leg.
- **Charter churn** → the charter changes every leg. The design isn't settled; involve the human.
- **Status bloat** → `status.md` turns into a history dump. Compress it to current state plus targeted pointers.
- **Defensive reading** → reading the full log/backlog/artifact tree to feel safe. Use the packet and targeted lookups; stop if the baton is not enough.
- **Eager spawning** → spawning early, spawning several runners, or spawning before work is durable. One leg, one handoff, at the end.
- **Silent stall** → getting stuck and stopping with no note, or spawning anyway. Always update status, log the blocker, and surface it.
