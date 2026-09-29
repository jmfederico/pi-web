# skills

Distributable agent skills developed alongside pi-web.

## relay

A tool-agnostic foundation for the [Relay Principle](https://relayprinciple.ai/):
carry long work through a chain of fresh agent contexts, one bounded leg and one
durable handoff at a time, without a standing coordinator or role hierarchy.
It defines the method's concepts and invariants but leaves tools and ways of
working to an operational profile.

```bash
npx skills add jmfederico/pi-web --skill relay -a pi -g
```

## relay-runner

The opinionated operational profile used by PI WEB's `/relay` preparation
prompt. The prompt first establishes a shared understanding and obtains explicit
human approval without pre-planning the chain; this profile then binds the base
method to Pi session tools and a Git/software-delivery workflow,
including adaptive leg sizing, verification and commit policy, whole-work
review and remediation, delivery, and intervention. Dispatch and handoff
prompts select both skills before each fresh runner begins.

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
