---
name: ux-guide
description: Use whenever designing, implementing, changing, or reviewing PI WEB UI interactions, controls, layouts, styling, or accessibility, including plugin surfaces. Guides reuse and extension of shared UI primitives and browser verification rather than prescribing per-screen styling. For interface copy, also use ux-writing.
---

# UX guide

Make interactions consistent through shared primitives, not repeated styling instructions or screen-specific copies.

## Start from the existing surface

1. Identify the user task, the interaction being changed, and the states it needs to support.
2. Read [UI primitives](../../../docs/ui-primitives.md) and inspect the relevant primitive implementation and nearby consumers. The reference documents available patterns, ownership, and plugin compatibility; implementation is the source for current styling behavior.
3. Reuse a suitable primitive where possible. Keep existing layout and behavior unless the task calls for changing them. Migrate touched controls incrementally rather than expanding the task into a whole-app restyle.

## Put reusable behavior in the right place

- Let primitives own common control treatments. Keep consumer styles focused on layout and domain content.
- If a treatment is missing, consider extending an existing primitive before creating a local variant. Add a new primitive when it represents a reusable pattern, not merely to wrap one screen's markup.
- Keep control sizes consistent across input types; touch capability alone should not change button dimensions. When responsive sizing is needed, base it on available viewport or container space.
- Prefer consistent visibility and behavior too. Avoid pointer/hover capability queries by default. Use hover-specific adaptations sparingly, only for genuinely hover-dependent interactions, while keeping actions discoverable and reachable without hover and by keyboard. Review existing input-specific treatments as legacy behavior rather than extending them; migrate within the scope of the task.
- Preserve native semantics, accessible names, keyboard interaction, focus management, and action behavior. Styling alone does not supply an interaction contract.
- For plugins, use the supported host UI styles capability and respect its compatibility boundary; see the primitive reference rather than deep-importing internal styles.
- When a shared treatment changes, update its reference documentation alongside the implementation. Keep dimensions, selectors, and exceptions there instead of duplicating them in this skill or `AGENTS.md`.

## Review the result

Check hierarchy, grouping, target boundaries, and feedback in the context of the user task. Related actions should read as related; risky or unrelated actions should remain distinguishable. Check relevant hover, focus, selected, disabled, loading, and error states rather than judging only the idle screenshot.

Verify changed geometry in a real browser at relevant viewport sizes and pointer modes. Look for gaps, overlapping targets, clipped focus indicators, and scroll-container problems. DOM-only tests cannot establish visual geometry. Use the testing guide for behavioral coverage, and report any browser verification that could not be completed.
