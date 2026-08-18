---
name: documentation-guide
description: Repository documentation placement and writing guidance. Use this skill whenever writing, modifying, reviewing, or planning README.md, anything under docs/, setup or installation instructions, troubleshooting or FAQ content, configuration references, operational guidance, or user-facing documentation in a feature or fix. Keep the README concise and put detailed material in its canonical documentation page.
---

# Documentation guide

Use this guide to decide where documentation belongs and how much detail each surface should carry. The goal is a short, useful path for new users without losing the detailed guidance needed by operators and experienced users.

## Core rule

Treat `README.md` as the project landing page and quick start, not the complete manual.

A reader should be able to understand what PI WEB is, decide whether it is relevant, satisfy the basic prerequisites, complete the shortest supported installation, and find the detailed documentation. Once that path is clear, additional explanation belongs under `docs/`.

Do not add every new feature, caveat, implementation detail, troubleshooting case, or behavioral guarantee to the README. Update the canonical detailed page and link to it when discovery from the README materially helps a new user.

## README contract

The README may contain concise versions of:

- the product identity and value proposition;
- high-level capabilities that help someone decide whether to use PI WEB;
- basic runtime requirements;
- the shortest supported install and first-run path;
- essential day-to-day commands;
- the core user-facing model;
- a brief security warning needed before exposing the service;
- links to canonical documentation.

Put these elsewhere:

- installation variants, platform-specific setup, service-manager behavior, and PATH details;
- troubleshooting steps, diagnostics, failure modes, and edge cases;
- exhaustive command options or feature behavior;
- configuration schemas, precedence, defaults, and migration guidance;
- internal architecture and implementation mechanics;
- detailed plugin, machine, federation, or remote-access workflows;
- release-note-style descriptions of individual fixes and enhancements.

A feature belongs in the README only when it materially changes the top-level product story or the shortest path to a successful first run. Being user-visible by itself is not enough.

## Choose the canonical destination

| Content | Canonical destination |
| --- | --- |
| Product overview and shortest successful start | `README.md` |
| Website landing-page summaries and navigation | `docs/index.html` |
| Requirements, installation modes, PATH setup, service managers, WSL, and manual operation | `docs/install.html` |
| Troubleshooting, diagnostics, known failure modes, and edge cases | `docs/faq.html` |
| Configuration keys, files, precedence, defaults, and reload behavior | `docs/config.md` and `docs/config.html` |
| Remote access and deployment model | `docs/remote-first.html` |
| Machine federation and selected-machine behavior | `docs/machines.html` |
| Plugin and Pi package behavior | `docs/plugins.md` and `docs/plugins.html` |
| Internal invariants that maintainers need while changing code | Focused code comments, `AGENTS.md`, or a dedicated developer document |

When a topic has both Markdown and HTML representations, inspect the local convention and keep user-visible claims synchronized. Do not copy large passages into multiple surfaces merely for convenience.

## Placement decision

Before adding documentation, ask:

1. Does a user need this information before their first successful run?
2. Is it a short orientation statement, or does it need qualifications and examples?
3. Is it troubleshooting, configuration, platform-specific, operational, or implementation detail?
4. Is there already a canonical page for the topic?
5. Would a link provide a clearer README than another paragraph?

If the content needs multiple sentences of caveats, explains how an internal mechanism works, or applies only after installation, it almost always belongs under `docs/`.

## Documentation workflow

1. Identify the user task and audience before choosing a file.
2. Find the canonical existing page and update it rather than creating a competing explanation.
3. Keep the README unchanged unless its quick-start path or high-level product story must change.
4. If discovery is important, add a short link from the README or relevant docs index instead of duplicating the detail.
5. Check nearby pages for stale or contradictory claims.
6. Keep commands, names, defaults, and platform statements consistent with the implementation and tests.
7. Review the final diff specifically for README growth and duplicated prose.

## Writing principles

- Lead with the user outcome, then the command or action needed.
- State what the software does rather than listing what it does not do; reserve "does not" statements for the rare case where behavior genuinely contradicts the most obvious expectation.
- Prefer concrete guidance over internal type, module, or orchestration terminology.
- Explain implementation details only when they help users make a decision or recover from a failure.
- Distinguish supported behavior from recommendations and prospective behavior.
- Avoid promises broader than the tested platform and compatibility contract.
- Keep examples copyable and make destructive or security-sensitive effects explicit.
- Link to one canonical source instead of maintaining subtly different versions of the same guidance.

## Release notes and checks

Use `.agents/skills/changeset-changelog/SKILL.md` when a documentation change is user-visible and belongs in the published release. Do not add a Changeset for internal agent guidance or purely editorial movement that leaves user-facing guidance intact unless the release policy calls for it.

Run the narrowest checks that cover the edited documentation. At minimum:

- inspect links and referenced paths;
- run any focused docs, packaging, or build-content tests associated with the changed files;
- use `git diff --check`;
- confirm the README remains a concise entry point rather than a second documentation site.

## Review checklist

- Is the README still optimized for a new user reaching a successful first run?
- Does each detailed explanation have one canonical home under `docs/`?
- Did the change avoid copying release notes or implementation design into the README?
- Are links sufficient for readers who need more detail?
- Are paired or related documentation surfaces consistent?
- Are user-visible commands and claims supported by current behavior?
