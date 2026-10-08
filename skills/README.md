# skills

Distributable agent skills developed alongside pi-web.

## relay

A tool-agnostic foundation for the [Relay Principle](https://relayprinciple.ai/):
carry long work through a chain of fresh agent contexts, one bounded leg and one
durable handoff at a time, without a standing coordinator or role hierarchy.
It centers the agreed finish line, relay-specific scope, compact baton, durable
history, and visible completion or need for help.

```bash
npx skills add jmfederico/pi-web --skill relay -a pi -g
```

## relay-runner

The Pi session and record mechanics used by `/relay` and `/relay-worktree`.
Preparation clarifies the goal and boundaries with the human and requires explicit
approval before dispatch. Each fresh runner chooses its next useful slice, keeps
`charter.md`, `status.md`, and `log.md` durable, and hands off once or stops.
An optional `decisions.md` keeps consequential reasoning out of the baton.
The runner requires a fresh-context final review, with at most three attempts,
without scripting the development route. Project instructions and applicable
skills govern the work. Dispatch and handoff prompts select both Relay skills.

```bash
npx skills add jmfederico/pi-web --skill relay-runner -a pi -g
```

`relay-runner` is not standalone; install the base `relay` skill as well when
using these commands directly. The `relays` Pi package ships and installs both
skills atomically. Its files under
`pi-packages/relays/skills/` are symlinks to the canonical `SKILL.md` files in
this directory; the package build (`npm run build:plugins`, or the dev watch)
materializes them as real packaged files. Edit the canonical copies here, not
the package links.
