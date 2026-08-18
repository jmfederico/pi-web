# Testing-guide compliance audit (relay input)

## Purpose

Audit tests added/modified while the `testing-guide` skill was silently
non-loading, and identify concrete gaps for a relay to fix. This document is the
input to that relay: each finding is a discrete, actionable work item.

## Why the skill was broken, and the exact window

The skill failed to load because its YAML frontmatter `description` contained an
unquoted colon:

```
description: Repository-specific testing guide. Use for any test work: planning ...
```

A bare `:` inside an unquoted YAML scalar breaks parsing, so the skill silently
did not load. It was quoted (fixed) later.

- **Broken by:** `a266541` — `docs: shorten testing guide skill description` (2026-07-04)
- **Fixed by:** `aedcbf8` — `feat(sessions): surface live session startup warnings in the web UI` (2026-07-17 19:16), which quoted the description string.

**Audit window:** commits `a266541..aedcbf8` (exclusive of the break commit,
inclusive of the fix commit). Any test authored in this window was written
without the skill in context.

- New test files in window: **61**
- Modified test files in window: **72**

The dominant, systemic compliance problem is concentrated in **Lit client
component tests** that use TemplateResult / private-member reflection. That is
the focus below. Server/helper tests sampled in the window were largely
compliant; the two timing exceptions are listed in Finding 4.

---

## Skill rules most relevant to the findings

From `.agents/skills/testing-guide/SKILL.md`:

- **Component tests** should prefer public/component boundaries: instantiate and
  set properties, dispatch events against rendered DOM, assert user-visible
  rendered state or controller calls.
- **TemplateResult event-handler extraction** (calling `render()`, inspecting
  `strings`/`values`, invoking a handler directly) is an **escape hatch**, usable
  only when all of: (1) specifically verifying Lit template event wiring; (2) a
  DOM harness would add disproportionate setup/flakiness; (3) the assertion
  checks observable component/controller effects, not Lit internals; (4) the
  lookup anchors to stable semantic markup/labels; (5) the test stays narrow.
- **Do NOT** use TemplateResult extraction for: general content assertions;
  styling/layout/focus/keyboard/accessibility; broad user flows; scenarios with
  an existing public seam; or copying an ad hoc helper variant into another file
  without considering a shared helper/DOM harness.
- When the escape hatch is used: **add a short comment** explaining why it is
  proportionate; keep the helper **small, type-guarded, and file-local unless
  reuse is justified**; anchor to stable semantic markers; assert the caused
  behavior.
- **Test helpers:** keep local until reuse is clear; if a pattern appears in
  multiple files, **consolidate deliberately rather than copy-pasting variants**.
- **Determinism:** prefer controllable promises / fake timers / injected deps
  over sleeps or timing guesses.

Note on environment: `vitest.config.ts` sets **no DOM environment** (node
default). So real shadow-DOM click harnesses are not available today. This is
important context — it partially justifies handler extraction, but per the skill
it makes deliberate helper consolidation and clear scoping *more* important, not
less. The relay should treat "introduce a shared, type-guarded template-inspection
helper (and/or a jsdom/happy-dom harness option)" as the strategic fix rather
than blessing per-file copies.

---

## Finding 1 — Duplicated TemplateResult-inspection helpers across many files (HIGH)

The same private helper cluster (`templateStrings`, `templateValues`,
`isTemplateResult`, `isStringArray`, plus per-file variants like
`templateStaticMarkup`, `collectTemplateStrings`, `flattenTemplateContent`,
`templateValuesAfterMarker`, `findTemplateClickHandlerForText`) is copy-pasted
across at least these window files:

| File | Local helper defs | Escape-hatch comment? |
| --- | --- | --- |
| `src/client/src/components/ChatView.image.test.ts` | 6 | partial |
| `src/client/src/components/ChatView.test.ts` | 6 | partial |
| `src/client/src/components/PiWebApp.clearQueue.test.ts` | 3 | **none** |
| `src/client/src/components/settings/SettingsSessiondPanel.test.ts` | 5 | **none** |
| `src/client/src/components/WorkspaceFilesPanel.test.ts` | 5 | partial |
| `src/client/src/promptAttachmentCapture.test.ts` | 4 | partial |
| `src/client/src/components/SettingsDialog.testSupport.ts` | 5 | **none** |

Also carrying the same duplicated helpers (pre-window, but same cluster — verify
before consolidating): `settings/SettingsGeneralPanel.test.ts`,
`SettingsPluginsPanel.test.ts`, `SettingsShortcutsPanel.test.ts`,
`SettingsPackagesPanel.test.ts`, `SettingsPanelFrame.test.ts`.

**Violation:** "If a pattern appears in multiple files, consolidate deliberately
rather than copy-pasting variants." This is now a maintenance liability (a second
mini-application of Lit-internal reflection).

**Relay action:** Create one shared, strictly-typed, type-guarded template
inspection helper module for tests (e.g. under a test-support path), covering:
static-markup flattening, value-after-marker lookup, and event-handler-after-marker
lookup. Migrate the files above to it. Delete the per-file copies. Keep the API
minimal and documented as an escape hatch. Confirm each call site still anchors to
stable semantic markers.

---

## Finding 2 — TemplateResult inspection used for general content assertions (HIGH)

The skill explicitly forbids TemplateResult inspection for "general content
assertions" and "styling/layout" — it is only for verifying event wiring with
observable effects.

Offending patterns:

- **`src/client/src/components/settings/SettingsSessiondPanel.test.ts`** — uses
  `flattenTemplateContent(...)` + `expectTextOrder(...)` / `countOccurrences(...)`
  to assert rendered *text content and ordering* (labels like "Session daemon",
  "Config file", "Companion CLI command"). This is general content/layout
  assertion via Lit internals, not event-wiring verification. No escape-hatch
  comment.
- **`src/client/src/components/SettingsDialog.general.test.ts`** (and the
  `.packages`, `.plugins`, `.sessiond` siblings) — use
  `collectTemplateStrings(dialog.render())` to assert presence/absence of markup
  substrings (`"<settings-general-panel"`, `"scope-note"`, `"This tab edits:"`).
  General content assertions through template-string reflection. No comment.
- **`src/client/src/components/ChatView.image.test.ts` / `ChatView.test.ts`** —
  mix legitimate handler-extraction (the `@load`/`@click`/Clear-queue wiring) with
  static-markup content assertions (`templateStaticMarkup(...)` checking
  `loading="lazy"`, `role="button"`, `class="msg tool-image-output"`, titles).
  The wiring assertions may be justified; the markup/attribute assertions are the
  kind of content/styling checks the skill steers away from.

**Relay action:** For each, decide per assertion:
- If it verifies **event wiring** with an observable effect → keep, but route
  through the shared helper (Finding 1) and add the required comment (Finding 3).
- If it is **content/text/attribute/ordering** → move to a public boundary. Where
  a public seam already exists, prefer it. Options: assert the public
  method/controller output (e.g. `chatQueuedMessageSections` is already tested
  this way in `ChatView.test.ts` — extend that pattern), set public properties and
  assert observable state, or add a minimal jsdom/happy-dom render check.
- If no lower/public seam exists and content coverage is genuinely needed,
  flag for a small render-harness (see strategic note) rather than string-scraping
  Lit internals.

---

## Finding 3 — Missing required escape-hatch comments (MEDIUM)

When the extraction escape hatch is used, the skill requires a short comment
explaining why it is proportionate. Window files using extraction with **no such
comment**:

- `src/client/src/components/PiWebApp.clearQueue.test.ts`
- `src/client/src/components/settings/SettingsSessiondPanel.test.ts`
- `src/client/src/components/SettingsDialog.general.test.ts`
- `src/client/src/components/SettingsDialog.packages.test.ts`
- `src/client/src/components/SettingsDialog.plugins.test.ts`
- `src/client/src/components/SettingsDialog.sessiond.test.ts`
- `src/client/src/components/SettingsDialog.testSupport.ts` (shared helper module
  — should carry the canonical explanation once consolidated)

Files that already include a proportionality comment (use as the style
reference): `ChatView.image.test.ts`, `ChatView.test.ts`,
`WorkspaceFilesPanel.test.ts`, `promptAttachmentCapture.test.ts`.

**Relay action:** After Findings 1–2 resolve which tests legitimately keep
extraction, add a concise comment at each remaining extraction site (or once on
the shared helper) explaining why a DOM harness is disproportionate here.

---

## Finding 4 — Sleep-based timing instead of deterministic waits (MEDIUM)

The skill: "prefer controllable promises, fake timers, and explicit injected
dependencies over sleeps or timing guesses." Real wall-clock sleeps found:

- **`src/server/sessions/piSessionService.promptQueue.test.ts`** — lines ~201,
  ~211: `await new Promise((resolve) => setTimeout(resolve, 5))` after emitting
  `compaction_end` / `agent_start` to let the async prompt drain. Flake-prone.
- **`src/server/sessions/piSessionService.spawnSubsession.test.ts`** — ~14 sites
  using `setTimeout(resolve, 20)` (and one `40`) to await async custom-message
  delivery after emitting `agent_end`. Comment at line ~797 confirms these wait on
  "the async custom-message path."

Both files already have access to controllable fakes (the service is constructed
with injected collaborators). `piSessionService.lifecycle.test.ts` in the same
window uses `useFakeTimers`, showing the deterministic pattern is available here.

**Relay action:** Replace fixed sleeps with a deterministic wait: expose/await the
service's drain promise, use an injected controllable clock / `vi.useFakeTimers()`
+ advance, or poll a condition via `vi.waitFor`. Do not merely shorten the delays.

---

## Out of scope / verified clean

- No `any`, `@ts-ignore`, or `@ts-expect-error` in window test files.
- No `.skip`/`.only`/`xit`/`xdescribe` (the `xhrs.only()` hits are a test-helper
  method, not Vitest focus).
- Server/helper/route tests sampled (nativeServices, machines, workspaces file
  content, sessionRoutes, parsers) follow the layer guidance and use injected
  fakes; no additional violations noted beyond Finding 4.

## Suggested relay sequencing

1. **Slice A (strategic seam):** Add the shared, type-guarded template-inspection
   test helper (Finding 1). Decide whether to also enable a jsdom/happy-dom
   environment option for genuine DOM assertions.
2. **Slice B (client component tests):** Migrate each window component test to the
   shared helper; reclassify assertions (Finding 2); move content/layout checks to
   public seams or the render harness; add escape-hatch comments (Finding 3).
   Suggested per-file order: `SettingsSessiondPanel.test.ts`, the four
   `SettingsDialog.*` files + `SettingsDialog.testSupport.ts`, `PiWebApp.clearQueue.test.ts`,
   `ChatView.test.ts`, `ChatView.image.test.ts`, `WorkspaceFilesPanel.test.ts`,
   `promptAttachmentCapture.test.ts`.
3. **Slice C (determinism):** Replace sleeps in `piSessionService.promptQueue.test.ts`
   and `piSessionService.spawnSubsession.test.ts` (Finding 4).
4. **Verify:** `npm test -- --run <changed files>`, then `npm run typecheck` and
   `npx eslint <changed files>`; `npm run verify` before final review.

## Checks used to produce this report

- Window: `git log a266541..aedcbf8 -- '*.test.ts'` (added vs modified via
  `--diff-filter`).
- Pattern scans over existing window files for: `Reflect.(set|get)`,
  `templateStrings`/`templateValues`/`isTemplateResult`, `collectTemplateStrings`,
  `flattenTemplateContent`, `setTimeout`/`sleep`, `any`, `@ts-ignore`,
  `.skip/.only`, and escape-hatch comment keywords.
- Read of the representative offenders listed under each finding.
