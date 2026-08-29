---
name: relay
description: "How the Relay method works: executing a plan as a chain of independent sessions that each do one slice and hand off to the next via spawn_session. Load this skill only when you already know you are in a relay: a prompt states you are working under the Relay framework (or relay/chain), points you at a relay charter/status/log, or the user invokes this skill directly. Do not load it for generic multi-step plans or ordinary spawn_session use."
---

# Relay

Relay is a way to execute a long or complex plan as a chain of independent sessions. Each session runs **one leg** — a single well-sized slice of the work — then hands the work off to a fresh session that runs the next leg. The chain continues until the goal is reached.

There is no coordinator and no referee. Each runner is the coordinator for their own leg: smart enough to do the work, adapt to what they discover, and hand off cleanly. Trust is distributed to every agent, not held by a god-agent above them.

Relay works because it does not try to recreate human management structures. The point is fewer boundaries, less hierarchy, and more fluid execution. The thing that makes that safe is **context containment**: every leg starts with a fresh, small context, and the accumulated knowledge lives in compact documents on disk rather than in any one session's memory.

## The hard constraint that shapes everything

`spawn_session` is fire-and-forget. When you spawn the next leg, **you do not see its output and you cannot correct it.** The only thing that travels down the chain is what you wrote to disk. A human may be watching, but they intervene through the Relay's durable state and intervention signal, not by relaying messages between sessions.

Two consequences follow, and they govern the whole method:

- **Make your work durable before you hand off.** Update the status, append the log, and preserve artifacts in the way the charter defines before spawning the next leg. Anything not on disk is lost.
- **If you hand off, do it exactly once, at the end.** Do not spawn early, do not spawn several runners "to parallelize," and never spawn while you still have work in flight. One leg, at most one handoff.

## The relay packet

A relay is carried by a small packet of documents. By default, its root is `.pi-web/relays/<name>/`. A user or dispatching instruction may choose another root. Record the actual root in the charter and use it consistently.

Every relay has these three core files.

**Authority follows role, not recency.** The charter is authoritative for where the relay is going and the bounds within which it runs; status is authoritative for where it is now and what comes next; the log is history. A later status update does not override the charter. This split lets every runner adapt the route without silently moving the destination.

**Charter** (`charter.md`) — the stable agreement, written when the relay is planned. It must contain, at minimum:

- **Relay identity.** The relay name and root path, so runners know exactly which relay they are on.
- **Goal / finish line.** A concrete, achievable end state with enough stable boundaries to decide whether it has been reached. The charter must state the finish line. It may define supporting requirements by reference only when it explicitly designates the referenced artifact as part of the stable agreement; neither `status.md` nor `log.md` may be the sole source of what “done” means. Without a finish line the relay runs forever — this is non-negotiable.
- **Sizing.** How much is *one leg*? This is project- and plan-specific; the charter defines it (a task, a slice, a time/scope budget — whatever fits). The skill does not decide this for you.
- **Task selection policy.** How a runner chooses the next task when `status.md` does not name one explicitly.
- **Handover.** How a runner hands off: what the spawn prompt should say and what the next runner must read. A normal handoff starts with a natural header containing the relay name and next leg identifier, then points at `charter.md` and `status.md`, not the full log.
- **Intervention signal.** When and how a runner must stop and get the human, and how that is made visible. The charter defines relay-specific triggers and signaling. A runner who would need to change the agreed finish line without explicit human direction must always stop and raise that signal.
- **Reading discipline.** The files a runner should read to orient, and any files that should not be read defensively.

The charter *can* be edited. Clarifications and maintenance are fine, but changing the goal, finish line, or a supporting artifact that the charter designates as part of them changes the relay's agreement; it is not ordinary leg-level adaptation. Runners adapt the route, not the destination. Make such a change only with explicit human agreement, record it in `log.md`, and update the charter before continuing. If you believe the change is needed and do not already have that agreement, stop and raise the intervention signal. Frequent charter edits are still a smell that the design is unsettled.

**Status** (`status.md`) — the compact baton/current state. This is the file every runner reads after the charter, and every runner updates before handoff or stop. Keep it short enough that a fresh runner can load it cheaply.

The baton carries position, not destination. `status.md` is authoritative for current state and next-leg selection only. It may describe a leg task or point to relevant context, but it must fit the charter's finish line and must not redefine, narrow, or extend it. Information needed to judge whether the relay itself is complete needs a stable home in the charter or a supporting artifact the charter designates; status points there rather than becoming its replacement.

It should answer:

- **Current position.** Where the relay is now.
- **Current or next task.** The next leg if known; otherwise enough information to apply the charter's task selection policy.
- **Leg tracking.** The last completed leg and the next leg to run. Keep this explicit so runners do not have to infer whether “current leg” means the leg just finished or the leg being handed off, and so the handoff prompt can identify the next leg accurately.
- **Relevant context.** Only the files, sections, commands, artifacts, or specific log entries needed for the next leg.
- **Progress documentation.** Where and how this runner must make progress durable: update `status.md`, append `log.md`, update artifacts, or follow another workflow named by the charter.
- **Blockers / intervention state.** Current risks, open decisions, or active reasons to stop.

Leg identifiers distinguish handoffs; they do not predict a fixed route or total number of legs.

Think of `status.md` as the thing passed from runner to runner. If it grows into a history dump, compress it back into current state plus pointers. If finish-line-defining content has crept into status without a stable home, restore it to the charter or a charter-designated artifact before compressing it away. If an older relay lacks leg tracking, repair it when you update status; prefer the leg identifier from the prompt or status, and do not read `log.md` end-to-end just to reconstruct prior identifiers.

**Log** (`log.md`) — append-only history. Each leg appends a concise entry recording what it did, decisions made and why, durable artifacts changed, status updates made, and blockers. The log preserves auditability, including agreed changes to the charter, but it is **not** orientation memory and does not replace the charter as the current agreement.

Do not read `log.md` end-to-end by default. Read targeted log entries only when `status.md` points to them, when the charter requires a specific lookup, or when there is an inconsistency you must resolve before continuing.

Optional files such as `plan.md`, `backlog.md`, specifications, or artifact notes are fine, but runners should read them only when the charter/status points to the relevant part. If the charter designates one as part of the finish line, changing that part follows the same agreement rule as changing the charter itself.

## Context containment rule

A runner normally reads:

1. `charter.md`
2. `status.md`
3. Only the specific files or log entries referenced for the current leg

Do not defensively rebuild the relay's full history. Do not read the full log, the full backlog, or a large artifact tree just because they exist. The relay stays scalable because each runner pays only for the context needed now.

If `status.md` is insufficient, fix the baton rather than compensating by reading everything. Here, fixing means restoring an accurate account of current state, tasks, and pointers within the charter's bounds; it does not mean reconstructing or revising the finish line in status. Use targeted inspection to clarify the current state, update `status.md` so the next runner has a clean start, and continue only if the task is still clear. If resolving the gap would require broad archaeology or judgment about past intent or what “done” should mean, stop and raise the intervention signal.

## Running one leg

This is the loop you run when you are dispatched into a relay.

1. **Orient from the packet.** Read `charter.md` and `status.md`. Confirm from the charter the relay identity/root, finish line, sizing, task-selection policy, handoff protocol, intervention signal, and reading discipline. Confirm from status the current position, last completed leg, next leg to run, current/next task, and blockers. If you are not sure whether a Relay is active, the dispatch prompt or packet must establish it; loading this skill alone does not.
2. **Choose the leg.** Prefer the explicit current/next task in `status.md`, provided it serves the charter's finish line and fits its sizing. If none is named, apply the charter's task selection policy. If that still requires context, inspect only the referenced plan/backlog/artifact sections. Do not adopt a task merely because status is newer. If the next task is still ambiguous, falls outside the charter's bounds, or would require moving the finish line, stop and involve the human.
3. **Re-anchor to the charter.** Does the chosen leg still serve the finish line, and does reality still permit it? Adapting how to get there is your job. If reality indicates that what “done” means should change, stop and raise the intervention signal rather than quietly redefining it.
4. **Run one leg.** Do exactly one well-sized slice, per the charter's sizing. Resist doing "just a bit more" — extra scope bloats context and breaks the containment that makes Relay work.
5. **Document progress.** Make all work durable. Update `status.md` with the new current state, last completed leg, next leg to run (if any), next task or task-selection pointer, relevant context for the next runner, and blockers. Append a concise `log.md` entry with what you did, why, decisions made, artifacts changed, and whether you are handing off or stopping.
6. **Decide: hand off, or stop.**
   - **Hand off** if there is a clear next leg and you are on track. Use `spawn_session` once, with a prompt whose first line is a natural task header containing the relay name and next leg identifier (for example, `Relay "<name>" leg <identifier> begins now.`), followed by the Relay method and pointers to `charter.md` and `status.md` (so this skill loads and they can orient cheaply). Then you are done. Handoff is deliberately fire-and-forget: `spawn_session` starts an independent session you will not see and cannot steer — do not reach for a tracked subsession to keep an eye on it. Letting go is the point. The next runner is trusted to run their own leg, and the relay packet is the only thread between you; if you feel the need to watch downstream work, that usually means the leg wasn't sized or handed off cleanly, or an intervention signal should have fired.
   - **Stop — do not spawn —** if the goal is reached, or you are blocked, or the charter's intervention signal fires. Update `status.md`, append a clear note in `log.md`, and raise the intervention signal so the watching human sees exactly what happened and what they need to decide. A stalled relay that stopped cleanly with a clear blocker is a success; a relay that spawned a confused next runner is a failure.

A good handoff prompt is short and explicit. The example below uses the default packet root; substitute the root recorded in the charter when it differs. Put the relay identity and leg identifier at the very beginning so the handoff is immediately distinguishable:

```text
Relay "<name>" leg <identifier> begins now.

You are the next runner in this Relay method chain.

Read:
- .pi-web/relays/<name>/charter.md
- .pi-web/relays/<name>/status.md

Do not read log.md end-to-end. Use it only for targeted lookup if status.md or charter.md points you there.

Run one leg according to the charter. Before handing off, update status.md, append log.md, make work durable, then either spawn the next leg once or stop with a clear intervention note.
```

## Planning a relay

When the user asks to set up a relay, your job is to produce the relay packet: `charter.md`, `status.md`, and `log.md`. The charter must have the required slots filled: relay identity, goal, sizing, task selection policy, handover, intervention signal, and reading discipline. Before dispatch, preserve the agreed finish line and the stable boundaries needed to judge it in the charter or in supporting material the charter explicitly designates. Do not make the initial status or planning conversation the only place those requirements exist. The initial status must give the first runner a compact baton: current position, leg tracking (for a numeric scheme, usually last completed leg 0 and next leg to run 1 for a new relay), first task or task selection pointer, relevant context, documentation expectations, and known blockers. The log may start empty or with a short seed entry explaining that the relay was created.

Unless the user or dispatching instructions provide these choices or a rule for deriving them, draw them out from the user rather than inventing them: ask what the finish line is, how much should be one leg, how runners pick tasks, how runners hand off, what they should read, and when they must stop and get the human. Sizing, task selection, and the intervention signal especially are not for the generic method to decide — propose options if it helps, but do not quietly settle them yourself.

Do **not** invent what a "good" plan, leg size, or cadence looks like when no policy is supplied — those choices are deeply project-, plan-, and human-specific. Explicit user, project, or dispatch instructions may provide defaults; follow them rather than replacing them with the skill's preferences. Your value in planning is making sure the relay is *runnable*: the finish line exists, sizing is stated, task selection is stated, handover is stated, reading discipline is stated, and the intervention signal is stated. Once the packet is agreed, you can dispatch the first leg with `spawn_session`.

## Smells to watch for

- **No stable finish line** → infinite or self-redefining relay. Refuse to run when “done” exists only in mutable state.
- **Goal drift / baton authority creep** → a leg or `status.md` quietly restates, narrows, or extends what the relay is for. Re-anchor to the charter; changing the destination requires human agreement.
- **Charter churn** → stable policy changes every leg. The design isn't settled; involve the human.
- **Status bloat** → `status.md` turns into a history dump. Compress it to current state plus targeted pointers.
- **Defensive reading** → reading the full log/backlog/artifact tree to feel safe. Use the packet and targeted lookups; stop if the baton is not enough.
- **Eager spawning** → spawning early, spawning several runners, or spawning before work is durable. One leg, at most one handoff, at the end.
- **Silent stall** → getting stuck and stopping with no note, or spawning anyway. Always update status, log the blocker, and surface it.
