---
name: testing-guide
description: "Repository-specific testing guide. Use for any test work: planning coverage, writing/fixing/reviewing Vitest tests, test helpers/fakes, failure triage, choosing test layers, and Lit UI tests, including the happy-dom DOM harness and TemplateResult handler extraction rules."
---

# Testing guide

Use this skill for test-specific decisions in this repository. The goal is useful regression coverage without letting test helpers, mocks, or component harnesses become a second application that is harder to maintain than the code under test.

For production-code design and testability seams, also use the `code-quality-architecture` skill. This guide owns test strategy, test helper conventions, and UI test escape hatches.

## Core principles

- Test behavior and contracts that matter, not branches for their own sake.
- Prefer the smallest layer that proves the behavior: pure helper, service, controller, route/API contract, component boundary, then broader integration.
- Keep tests deterministic. Fake clocks, browser globals, filesystem/process/network boundaries, and hard-to-trigger errors when needed.
- Assert observable outcomes: return values, state transitions, emitted calls/events, HTTP responses, rendered user-facing state, or durable side effects.
- Avoid asserting incidental implementation details unless the selected gap is specifically about that implementation contract.
- Keep setup readable. A small explicit fixture is better than a magical factory that hides the scenario.
- Clean up global stubs, fake timers, DOM state, and pending promises so tests do not leak into one another.

## Choosing the test layer

Prefer this order unless the behavior requires a higher layer:

1. **Pure helper/service tests** for data shaping, validation, cache decisions, command construction, and conversion logic.
2. **Controller/runtime adapter tests** for state orchestration, endpoint selection, cancellation, timers, and injected collaborators.
3. **Route/API contract tests** for HTTP status mapping, path/query/body parsing, proxy allowlists, and compatibility contracts.
4. **Component-boundary tests** for UI event wiring and rendered state. Prefer real DOM/custom-element interaction via the per-file happy-dom harness (see Lit component tests).
5. **Broad verification** (`npm run verify`) when a change is cross-cutting, changes shared helpers/types, or before final merge review.

Do not jump to a broad UI or integration test just because it feels more realistic if a lower layer proves the same behavior with less noise and less flake risk.

## Test helpers and fakes

- Keep helpers local until reuse is clear. If a pattern appears in multiple files, consolidate deliberately rather than copy-pasting variants.
- Type helpers and fakes strictly; avoid `any` unless the test is intentionally modeling an untyped external boundary.
- Fake only the boundary needed for the scenario. Do not mock the unit under test or so many collaborators that the assertion stops proving real behavior.
- Prefer controllable promises, fake timers, and explicit injected dependencies over sleeps or timing guesses.
- Name helpers after the domain behavior they support, not the mechanics of the fake.

## Lit component tests

Test Lit components through public/component boundaries, choosing the narrowest seam that proves the behavior, in this order:

1. **Pure exported seam** for content, ordering, and composition logic: extract an exported pure function from the component (for example `sessiondPanelNotices` or `chatQueuedMessageSections`) and test that, rather than scraping rendered output.
2. **happy-dom harness** for rendered state and real user-like interaction (see below).
3. **TemplateResult handler extraction** only as a narrow legacy escape hatch (see its rule below).

### happy-dom harness

`happy-dom` is the standard DOM environment for Lit component tests. It is a declared devDependency, opted into per file with a docblock on the first line of the test file:

```ts
// @vitest-environment happy-dom
```

Keep the opt-in per file; never set a global `environment` in `vitest.config.ts`. Pure logic tests stay on the fast default node environment, and only DOM-touching tests pay the harness cost.

Use the harness for what the node environment cannot provide and the extraction escape hatch forbids: rendered shadow-DOM state, real events (`click()`, `dispatchEvent`), focus and `activeElement`, native form semantics (radio/checkbox grouping, `checked`), and ARIA wiring such as `aria-describedby` or `aria-live`. Instantiate the component, set properties per its contract, append it to `document.body`, and interact with the rendered controls instead of invoking Lit handlers.

happy-dom is not a browser. Do not assert layout, styling, visual state, real scroll geometry, or `IntersectionObserver`/`ResizeObserver` behavior with it. Stub missing APIs at the boundary — spy on `Element.prototype.scrollIntoView`, stub `window.matchMedia` — and assert the calls, not geometry.

Conventions:

- Clean up in `afterEach`: `document.body.replaceChildren()` and `localStorage.clear()` so DOM and storage state do not leak between tests.
- Await `element.updateComplete` after property changes or events before asserting; await it twice when the component schedules another render from within `updated()`, so any follow-up render has settled.
- Assert user-visible rendered state or controller calls caused by the interaction, not Lit internals.

### TemplateResult event-handler extraction rule

Lit `TemplateResult` event-handler extraction means calling `render()`, inspecting the returned template's `strings`/`values`, finding an event handler near a marker, and invoking that handler directly. It is a legacy escape hatch, not the default: with the happy-dom harness available, the "render harness impractical" precondition below rarely holds, so rule out the pure-seam and happy-dom options before reaching for extraction.

Use TemplateResult handler extraction only when all of these are true:

1. The test is specifically verifying Lit template event wiring.
2. A happy-dom render would add disproportionate setup, flakiness, or noise for the behavior being checked — rare now that the harness exists, so justify it in the required comment.
3. The assertion checks observable component/controller effects, not Lit internals.
4. The lookup is anchored to stable semantic markup, labels, or user-facing text rather than incidental handler order.
5. The test stays narrow; it is not trying to cover a full user flow, accessibility behavior, or visual/layout behavior.

Do not use TemplateResult handler extraction for:

- general content assertions;
- styling, layout, focus, keyboard navigation, or accessibility behavior;
- broad user flows where real DOM events are the point;
- scenarios with an existing public controller/service/helper seam;
- copying a new ad hoc helper variant into another file without reviewing whether the shared helper or the happy-dom harness is now warranted.

When using this escape hatch:

- Add a short comment above the helper or test explaining why direct handler extraction is proportionate.
- Prefer the shared, type-guarded helpers in `src/client/src/templateInspection.testSupport.ts`; keep any genuinely file-specific lookup small and type-guarded rather than copying new variants.
- Anchor searches to stable semantic markers such as accessible labels, button text, ids intentionally used by the component, or nearby form markup.
- Assert the behavior caused by the handler, such as state changes or calls to injected callbacks/controllers.
- Avoid assertions about the exact shape of Lit's private data beyond the minimum needed to find the handler; fail with clear errors if the template cannot be inspected.

Existing extraction tests are acceptable as-is. Convert them to a pure seam or the happy-dom harness opportunistically when the file is touched for other reasons; do not run a big-bang migration.

## Checks to run

Run the narrowest meaningful check first:

- Changed test file: `npm test -- --run <test-file>`.
- Source or exported type changes: also run `npm run typecheck`.
- Non-trivial test helper, component, or lint-sensitive changes: run `npx eslint <changed-file>` or `npm run lint` when broader lint coverage is needed.
- Cross-cutting changes or final merge review: prefer `npm run verify`.

Record exact commands and results when working under relay/audit workflows or when handing work to another agent.
