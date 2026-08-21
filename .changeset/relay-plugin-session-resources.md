---
"@jmfederico/pi-web": patch
---

Ship a generic Relay workflow with the bundled relays plugin: the `/relay` and `/relay-worktree` prompt templates and the `relay` skill are added to sessions while the plugin is enabled, working in any Git-based project. Project or user prompt templates and skills with the same name shadow the shipped ones, and disabling the plugin removes them at the next session-daemon start. Bundled and local plugins can now contribute Pi prompt templates (`prompts/*.md`) and skills (`skills/<name>/SKILL.md`) to sessions in general.
