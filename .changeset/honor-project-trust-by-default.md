---
"@jmfederico/pi-web": patch
---

PI WEB now always honors pi's project-trust model; the `respectProjectTrust` opt-in (env var and config key) is removed. At session start a workspace's project-local `.pi/` resources load only when the workspace is trusted, resolved the way `pi` resolves it with no browser prompt: a saved decision in the agent directory's `trust.json` wins, a user/global extension may decide through the `project_trust` event (and request that the choice be remembered), and otherwise `defaultProjectTrust` applies — with `ask` or no decision a workspace is untrusted, matching headless `pi`.

You can trust a workspace from the new workspace-menu toggle or when adding a project; both link to the project-trust documentation instead of spelling out the details in the UI. The trust routes are federated, so the toggle reads and stores the decision on the machine where the workspace runs.

This is a breaking change for existing projects without a saved trust decision: after this release they become untrusted by default, so their project-local `.pi/` resources — settings, extensions, skills, prompts, themes, SYSTEM.md, APPEND_SYSTEM.md — do not load until you trust the workspace (workspace-menu toggle) or set `defaultProjectTrust` to `always`.