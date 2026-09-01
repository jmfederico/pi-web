---
name: relay
description: "Foundational, tool-agnostic Relay method for carrying long work across a chain of independent agent contexts, one bounded leg at a time. Use when a user asks what Relay is, invokes Relay directly, designs a Relay workflow or operational profile, or refers to an active Relay chain or packet. Do not load for generic multi-step plans, ordinary delegation, or unrelated session spawning."
---

# Relay

Relay is a way to carry a long or complex effort across a chain of independent agent contexts. Each runner completes one bounded **leg**, makes progress durable, and hands the work to one fresh successor. The chain continues until the finish line is reached or human intervention is needed.

The method follows the [Relay Principle](https://relayprinciple.ai/): do not recreate human management structures around agents by default. There is no standing coordinator, referee, role hierarchy, or “god-agent” supervising the chain. Each runner owns its leg, adapts the route within agreed bounds, and trusts the next runner to do the same.

Relay is safe because it combines distributed trust with **context containment**. A fresh runner receives compact durable state instead of inheriting an ever-growing conversation or defensively reconstructing the full history.

## Core model

- **Relay:** the complete chain and its stable destination.
- **Runner:** the agent context responsible for one leg. It coordinates its own slice; it does not supervise later runners.
- **Leg:** one context-contained, coherent unit of progress. Leg boundaries protect context quality, not organizational ownership.
- **Packet:** durable state shared across otherwise independent contexts.
- **Baton:** the packet's compact current-state view: where the Relay is now, what comes next, and the targeted context needed by the next runner.
- **Handoff:** the final operational act that starts or designates at most one successor after current work is durable. A user-facing summary may follow, but no further work, durable-state mutation, tool use, or downstream steering.
- **Intervention:** a visible stop when the destination cannot be pursued responsibly within the current agreement.
- **Operational profile:** the tool- and workflow-specific policy that binds these concepts to a concrete environment.

## Invariants

A workflow keeps the spirit of Relay when these properties hold:

1. **Stable destination, adaptive route.** The finish line and material bounds remain authoritative while runners adapt sequencing and implementation. Changing the destination requires the agreement authority defined by the Relay.
2. **One bounded leg per context.** A runner does not keep accumulating unrelated work or execute several nominal legs in one context.
3. **Durability before handoff.** Decisions, artifacts, current state, and blockers needed downstream are preserved outside transient conversation before a successor begins.
4. **At most one successor.** A runner either hands off once at the end or stops. It does not fan out the chain or hand off while its own work remains in flight.
5. **Fresh-context trust.** The successor is allowed to own its leg. If a runner feels it must watch and correct downstream work, the slice, packet, or intervention policy is not ready.
6. **Bounded orientation.** A successor starts from the stable agreement and baton, then reads only targeted supporting context. Full-history reconstruction is exceptional, not routine.
7. **Visible stopping.** Completion, blockers, and intervention are recorded clearly. Spawning a confused successor is worse than stopping cleanly.
8. **No silent goal drift.** Current-state updates cannot redefine what the Relay is trying to achieve.

## Durable state by role

Relay needs durable state with three distinct authorities. An implementation may use files, records, messages, or another medium; the roles matter more than their names.

### Stable agreement

Defines identity, goal and observable finish line, scope edges, explicit non-goals, and material assumptions or human decisions. It changes rarely. Clarification is normal; moving the finish line or an edge is an agreement change, not routine adaptation.

Keep this destination-focused. Do not turn it into an implementation plan, technical design, quality checklist, risk inventory, or copy of project instructions. Those details anchor later runners to route assumptions and blur what requires human agreement.

### Current baton

Defines present position, the last completed and next leg identifiers, current or next task, targeted context pointers, blockers, and required progress updates. It stays compact. It carries position, not destination.

### History

Preserves concise append-only evidence of completed legs, decisions, artifacts, agreement changes, and stops. It supports targeted lookup and auditability; it is not the default orientation surface.

Separating these roles prevents recency from becoming authority. A newer baton cannot silently override the stable agreement, and a large history does not become mandatory context.

## Operational profiles

This base skill is intentionally non-operational and tool agnostic. It does not choose:

- how a successor context is created;
- where or in what format durable state lives;
- how large a leg should be or how tasks are selected;
- whether work uses source control, worktrees, commits, tests, reviews, or delivery gates;
- how intervention reaches a human; or
- what project-specific quality standard applies.

An operational profile supplies those bindings and decides where to keep its identity and any operational record. Each handoff makes the active profile visible to the fresh runner. A profile may be strongly opinionated without putting its mechanics into the destination agreement or turning its choices into the definition of Relay.

Projects can layer any operational profile that fits their environment while preserving the invariants above.

## Context containment

A fresh runner normally needs only:

1. the stable agreement;
2. the current baton; and
3. the specific supporting material those surfaces identify for the leg.

A baton that routinely requires full-history or whole-artifact-tree reconstruction violates bounded orientation. A state gap that can be resolved only through broad archaeology or guessing about the destination is an intervention condition, not ordinary continuation.

## Failure smells

- **Coordinator creep:** a persistent supervisor plans, watches, or approves every leg.
- **Role bureaucracy:** fixed agent roles or layer ownership replace fluid, outcome-driven slices without a real constraint requiring them.
- **No stable finish line:** mutable current state is the only definition of done.
- **Baton authority creep:** status quietly narrows or expands the agreement.
- **Context leakage:** every runner reloads the full history or inherits an unbounded conversation.
- **Eager or parallel handoff:** successors begin before the current leg is durable, or one runner fans out the chain.
- **Oversized legs:** a runner continues beyond a coherent context-contained checkpoint.
- **Silent stall:** work stops without durable blocker or intervention state.

Operational details may vary widely. These failures matter because they undermine the principle, not because a particular tool or file convention was violated.
