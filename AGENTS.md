# Agent Notes

This project is expected to run locally using split systemd user services:

- `pi-web-sessiond.service` runs `npm run start:sessiond` in non-autoreload, non-auto-restart mode.
- `pi-web-ui-dev.service` runs the web/API and Vite UI in dev autoreload mode with `npm run dev:web` and `npm run dev:client`.

When working on this project, assume the session runtime owner is long-lived and separate from the autoreloading UI/API process. Browser disconnects and UI/API restarts should not stop active Pi sessions.

If you make changes that affect `src/server/sessiond.ts`, session runtime ownership, the session daemon protocol, or any code path only loaded by the session daemon, inform the user that a manual restart of the session daemon is needed.

Changes to the web/API/UI side generally only require the `pi-web-ui-dev.service` autoreload/restart path.

## Package management

Use npm for dependency work in this repository (`package-lock.json` is the committed lockfile). Running `bun install` or `bun add` here rewrites `package.json` from `node_modules` state and leaves `package-lock.json` out of sync, so installs and CI resolve different trees.

Running PI WEB on Bun is a supported *runtime*, which is separate from dependency management: build the package with npm, then start it with Bun.

Pi extension packages used while developing in this workspace (`pi-subagents`, `pi-effort`, `@hicaru/pi-rlm`) are `devDependencies`, not `dependencies`, so they never reach the published package, and `knip.json` lists them under `ignoreDependencies` because Pi loads them at runtime rather than the source importing them.

## Documentation boundaries

`README.md` is a concise landing page and quick start. Keep it focused on what PI WEB is, basic requirements, the shortest supported install path, essential commands, the core model, and links to detailed documentation.

Put installation variants, troubleshooting, configuration details, operational behavior, architecture, edge cases, and exhaustive explanations under `docs/`. Avoid duplicating detailed documentation in the README; link to its canonical location instead.

Use `.agents/skills/documentation-guide/SKILL.md` whenever writing, modifying, reviewing, or planning user-facing documentation.

## Testing guidance

Project-specific testing rules live in `.agents/skills/testing-guide/SKILL.md`.

Use that skill whenever writing, modifying, reviewing, or planning tests, closing coverage gaps, triaging test failures, or creating test helpers/harnesses. Keep detailed testing conventions there rather than growing this top-level orientation file.

## Verification reporting

Never report failed, incomplete, or skipped verification as passing. Identify any expected check that was not run and why, and do not mask a non-zero result. If a command intentionally probes a failure path or captures an exit for inspection, state that purpose and interpret the result.

## Client application URL convention

- Build PI WEB-owned browser paths as application-relative references without a leading slash, for example `api/...` and `pi-web-plugins/...`.
- Encode every dynamic path segment with `encodeURIComponent`; encode query values, using `URLSearchParams` for multi-field queries.
- Resolve each reference exactly once at the browser boundary: ordinary JSON HTTP paths go to `request()`, direct browser APIs receive URLs from helpers backed by `resolveAppUrl()`, and WebSockets use `resolveAppWebSocketUrl()`.
- Name helpers returning unresolved application references with a `Path` suffix and helpers returning browser-ready absolute values with a `Url` suffix.
- Plugin module references must go through `resolvePluginModuleUrl()`. Its leading-slash handling is the documented rolling-compatibility exception; do not introduce other leading-root app references.
- Pre-JavaScript HTML assets use Vite `%BASE_URL%`; PWA manifest references stay `./`-relative. External links, data URLs, and module-relative plugin assets are not application paths.
- To assess deviations, search production client code for raw `fetch`, `WebSocket`, `XMLHttpRequest`, URL-bearing DOM attributes, and leading `/api` or `/pi-web-plugins` literals. Every app-owned result must follow one of the boundaries above.
- Published nested deployments require a canonical trailing slash; the reverse proxy must redirect a slashless prefix before serving the app.

## Configuration conventions

- `$PI_WEB_DATA_DIR` (`~/.pi-web` by default) contains PI WEB-managed state such as `projects.json` and `machines.json`; do not treat it as the user-editable config API.
- Global user/machine config lives at `$PI_WEB_CONFIG` or `~/.config/pi-web/config.json`.
- Project-local PI WEB core config should use one commit-able file: `<project>/.pi-web/config.json`.
- Core features should add keys to these config files, not create one project file per feature.
- Plugins may own separate project config files, such as `.pi-web/tasks.json`.
