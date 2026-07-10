---
name: code-quality-architecture
description: Project code quality and architecture expectations for implementation, refactoring, planning, and code review. Use this skill whenever writing, modifying, reviewing, or planning production code or architecture in this repository, especially when making architecture choices, introducing modules/services/components, managing side effects, dependencies, state, or boundaries. Favor composable, contained, intention-revealing, separated, dependency-injected, testable code while respecting the idioms of the framework or library in use.
---

# Code quality and architecture expectations

Use this skill as a design lens, not as a framework tutorial. The goal is to shape code so future agents and humans can understand it, change it safely, and test it without needing to reverse-engineer hidden coupling.

For test-specific strategy, test helper conventions, and UI test harness choices, use the `testing-guide` skill. This skill still treats testability as a production-code design concern.

Respect the project's existing conventions and the framework/library idioms already in use. If a dependency expects a particular pattern, such as inheritance, decorators, lifecycle hooks, or a registration API, use that pattern deliberately and keep the surrounding project code as simple and composable as possible.

## Values we optimize for

### Proportionate

Prefer boring, local changes that solve the problem without surprising future maintainers. Avoid broad rewrites unless the task requires them, and avoid new abstractions that add ceremony without clarifying ownership, reducing duplication, isolating volatility, or improving testability.

### Composable

Build behavior from small pieces with explicit contracts. Prefer functions, modules, factories, services, components, or adapters that can be combined without knowing each other's internals.

Prefer composition over inheritance. Reach for inheritance only when a framework/dependency requires it, when it clearly models a stable relationship, or when it is already the local convention. If you use inheritance, keep the hierarchy shallow and explain the reason in the design or final summary.

### Contained

A unit of code should do its job without leaking state, assumptions, or side effects across the system. Keep effects at clear boundaries: network, filesystem, timers, process state, browser APIs, storage, logging, telemetry, and UI/event dispatch.

Make state ownership explicit: who owns it, who may mutate it, when it is created, and how it is cleaned up. Avoid hidden global coordination, surprise mutation, ad hoc event dispatch, and imports that perform work merely by being loaded. If code must produce side effects, make the trigger, scope, cleanup, and failure behavior visible.

### Clear intention

Names, types, file boundaries, and function boundaries should reveal why the code exists. Prefer a small amount of clear structure over clever compactness.

Use types to express domain meaning, valid states, and boundaries between parts of the system. Do not duplicate lint/type rules here; the point is to make the design easier to understand, not merely to satisfy TypeScript.

Comments are most valuable when they explain why a decision exists, what invariant must be preserved, or why an apparent simpler approach would be unsafe. Avoid comments that merely restate the code.

### Clear separation of concerns

Keep domain decisions, orchestration, framework glue, persistence, transport, rendering, and validation separate when that separation makes the code easier to reason about.

Framework-facing code should usually be thin: gather inputs, call the core logic, map results back to the framework. Core logic should usually be usable without starting the UI, server, session runtime, browser, filesystem, or network.

### Deliberate error handling

Handle errors at meaningful boundaries. Do not swallow errors silently, scatter defensive `try`/`catch` blocks everywhere, or turn every failure into vague fallback behavior. Let core logic communicate failures clearly, and translate them into logs, UI messages, HTTP responses, retries, or cleanup at the edge that has the right context.

### Dependencies injected

Pass collaborators, configuration, clocks, random sources, storage, network clients, and environment-specific services in through parameters, constructors, or small factories where practical. This makes dependencies visible and replaceable.

Do not introduce a heavy dependency-injection framework unless the project already uses one or there is a clear reason. Lightweight dependency injection is enough: explicit inputs beat hidden imports and singletons.

### Testable by design

Testability should emerge from the previous values. Prefer pure or mostly pure core logic, small adapters around side effects, and explicit seams where tests can provide fakes or fixtures.

If a change is hard to test, treat that as design feedback. Look for hidden dependencies, mixed concerns, or side effects happening too deep in the call stack. Avoid designs that require excessive mocking just to reach the behavior under test.

## How to apply this during coding

Before implementing, briefly identify the boundary you are changing:

- What is the core behavior?
- What are the side effects or external dependencies?
- Who owns any mutable state, and how is it cleaned up?
- Where should errors be handled or translated?
- What should stay framework-specific, and what can be plain logic?
- What would make this easy to test?

During implementation:

- Keep the smallest useful public surface.
- Prefer explicit inputs/outputs over ambient state.
- Avoid work at import time; make startup, registration, listeners, timers, and connections explicit.
- Use existing project patterns unless they conflict with these values strongly enough to justify a small refactor.
- Avoid broad rewrites when a contained change will solve the problem.
- Add abstraction only when it makes the code easier to change, test, or understand.
- If you make an architectural tradeoff, mention it briefly in the final response.

## Review checklist

When reviewing or finishing code, check:

- Is the change proportionate, or did it introduce avoidable architecture ceremony?
- Can this behavior be reused or combined without copying internals?
- Are side effects visible, bounded, and cleaned up when needed?
- Is mutable state ownership clear?
- Do names, types, and file boundaries communicate intent?
- Are errors handled at the right boundary with enough context?
- Are domain logic and framework glue separated enough for the size of the change?
- Are important dependencies explicit and replaceable in tests?
- Can the meaningful behavior be tested without booting unnecessary infrastructure?

Do not over-engineer small fixes. The right amount of architecture is the minimum structure that makes the code clear, safe to change, and straightforward to test.
