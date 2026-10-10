---
name: relay
description: "Carry work across a chain of fresh agent contexts using a shared goal, compact baton, and durable record. Use when a user invokes Relay, discusses the Relay method, prepares a Relay, or continues an active Relay. Do not load for generic multi-step work or ordinary delegation."
---

# Relay

A Relay carries work across fresh agent contexts until the agreed goal is reached or an agent needs human help. Each context owns one useful slice, called a **leg**. There is no standing coordinator or fixed set of agent roles.

Follow the [Relay Principle](https://relayprinciple.ai/): give agents a destination and enough continuity to act, rather than recreating a management structure around them.

## Finish line over plan

Help the human express what they want built and how they will recognize it is done. Resolve material ambiguity before dispatch. An existing requirements document can supply the goal; reference it rather than rewriting it into a larger specification.

Keep the goal stable and the route adaptable. Each runner checks the finish line against the current work and chooses the next useful slice. Changing the goal requires human agreement; changing implementation or sequencing within scope does not.

## Scope over script

Record the relay-specific boundaries, limitations, conditions, and clarifications needed to understand the request. Preserve technical requirements and any other details the human explicitly asks to include.

Do not invent an implementation roadmap, speculative requirements, or a new software process. Project instructions, skills, and harness conventions remain where they belong; each runner discovers and follows what applies to its work. A Relay does not replace or weaken those rules.

## Handoff over handhold

A baton says **where we are**, not **how you must work**. Avoid suggesting or assigning the next slice: even a provisional suggestion can anchor the successor. Record remaining gaps and concrete dependencies instead, and trust the successor to inspect reality and choose its slice.

Choose a meaningful increment that fits one context, not the tiniest possible task. Investigation and related work can stay together. Leg boundaries protect context quality, not organizational ownership.

Finish ongoing work and preserve the state before starting at most one fresh successor. Handoff is the final operational action; only a user-facing summary follows. Do not watch or steer the successor.

## Record over memory

Keep three kinds of durable information:

- **Goal:** the agreed finish line and relay-specific scope. Current status cannot override it.
- **Baton:** current position, completed work, what remains, relevant evidence and decisions, useful pointers, and any blocker.
- **History:** concise entries recording each leg's result, decisions, artifacts, checks, and handoff or stop.

Keep the baton compact. Use history for targeted lookup, not mandatory reconstruction. Inspect the actual work as needed; the record saves rediscovering prior decisions, not reading the project.

## Signal over spin

Stop when the finish line is met, with evidence. Completion does not require finding another improvement.

Stop visibly when progress needs human input: record the blocker, what was tried, and the specific decision or help needed. If successive legs keep revisiting the same issue without new evidence or meaningful progress, surface that stall instead of spawning another attempt.

Optional cleanup, hypothetical risks, and a desire for perfection are not reasons to prolong the chain. Revisit a settled decision when facts change or concrete evidence shows it was wrong, not merely because a fresh agent has arrived.

Tools, storage, and session creation belong to the environment-specific runner skill, not the definition of Relay.
