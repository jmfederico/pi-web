# PI WEB plugin API

PI WEB plugins are trusted packages that can extend the browser UI, provide workspace semantics in the session daemon, or pair both entries. They are intended for personal, team, and project-local customization, and simple enough for an LLM to create or modify directly.

Plugins can currently:

- add action-palette commands;
- add workspace tools/panels next to Files and Terminal;
- add compact workspace-label items in the workspace list, panel header, and status bar;
- call browser APIs and documented PI WEB plugin context helpers;
- read workspace files and start workspace terminal commands through documented helpers;
- serve browser-public files from an explicitly declared `browserRoot`;
- contribute one server-side workspace provider, with optional JSON or raw-binary backend requests and workspace-removal planning.

Browser entries run in the PI WEB page through browser plugin API v2. Declared server entries run in the session daemon through the separate server-plugin API v1. Plugins do not get raw Fastify access, arbitrary routes, concrete core services, a generic event bus, Pi model-provider registration, or a general server-hook API. Neither entry is sandboxed.

## Pi packages, Pi extensions, and PI WEB plugins

**Pi packages** are distribution bundles managed by Pi (`pi install`, `pi remove`, `pi update`). A Pi package can provide Pi extensions, skills, prompt templates, themes, context/system prompt files, and/or PI WEB plugins. Many Pi packages do not include a PI WEB plugin.

**Pi extensions** are runtime modules loaded by the session daemon. They can register Pi tools, hooks, commands, and model providers. They are not PI WEB plugins and use a different API and lifecycle.

**PI WEB plugins** are packages discovered from bundled, local, dev, and installed Pi-package sources. A plugin can declare a browser `module`, a sessiond `serverModule`, or both. A server entry can participate only in the documented PI WEB plugin lifecycle and workspace-provider contract; it cannot register Pi model providers or arbitrary hooks.

Use **Settings → Pi packages** to view configured Pi packages or install/remove/update a package. Enter only the package source, such as `npm:@scope/package`, a git/URL source, or a local path. PI WEB uses Pi's default package location, equivalent to `pi install <source>`, and does not ask for an install location.

When machine federation is enabled, **Settings → Pi packages** targets the currently selected machine. The panel labels whether changes will run on the local/gateway machine or on a selected remote PI WEB machine.

Use **Settings → PI WEB plugins** to edit the desired enablement of discovered plugins on the selected machine. Browser-only changes apply after a page reload. A server-backed change also requires a session-daemon restart before its paired browser module can load against the new active revision. If an older or unavailable remote PI WEB server does not support the versioned plugin lifecycle, PI WEB reports plugin settings as unsupported or unavailable instead of silently falling back to the gateway.

After installing, removing, or updating a Pi package, type `/reload` in each idle PI WEB session on the target machine to refresh ordinary Pi resources such as extensions, skills, prompt templates, themes, and context/system prompt files. For PI WEB plugins, manually restart the target session daemon when the package has a server entry, then reload the browser page. A provider-registering Pi extension follows a separate daemon-start policy; see [Pi extension provider baseline](https://pi-web.dev/config#pi-extension-provider-baseline).

## Pi extension dialogs in PI WEB

Pi extensions running under PI WEB's session daemon can ask the user questions with `ctx.ui.confirm()`, `ctx.ui.select()`, and `ctx.ui.input()`. PI WEB reports `ctx.hasUI === true`, and for these three dialog methods that is true in fact: the call renders a dialog card inline in the session transcript and the returned Promise resolves with the user's actual answer — a boolean for confirm, the chosen option for select, the typed text for input.

- **Works from hooks, without the prompt queue.** Answers travel over a dedicated session-daemon channel, so a dialog opened inside an in-flight `tool_call` hook parks safely — the agent loop waits for the hook and the run continues with the answer. Consent-gating a tool from a `tool_call` hook is a supported pattern.
- **`session_start` dialogs are reachable.** A dialog opened from a `session_start` hook is answerable while the session is still starting, both when creating a session and when opening an existing one; startup completes once the dialog settles.
- **Survives browser reloads; first answer wins.** Reloading the browser re-renders open dialogs from the session status. With several tabs on the same session, the first answer settles the dialog and the other tabs re-render the settled card.
- **Settled cards stay until dismissed.** An answered or closed dialog leaves its outcome card in the transcript so the user can see what became of it — answers travel to the extension alone, so the card is the only record of the exchange. The card is browser-local: only a browser that saw the dialog open renders it, and switching sessions or reloading drops it.
- **Timeouts.** The extension's own `timeout` option applies, and the daemon adds an unattended-dialog safety valve, `extensionDialogsTimeoutMs` (default 5 minutes, `0` waits forever — see [Extension dialogs](https://pi-web.dev/config#extension-dialogs)). The effective deadline is the sooner of the two. A dialog that closes without an answer resolves with its kind's cancel value: `false` for confirm, `undefined` for select and input.
- **Abort and runtime replacement.** Aborting the current run settles a dialog opened during that run immediately, at abort-request time, with its cancel value. Replacing the session runtime (`/reload`, session disposal) settles any still-open dialog the same way; hooks on the new runtime open fresh dialogs. The extension's own `AbortSignal` is honored: aborting it dismisses the dialog and resolves with the cancel value.
- **Other UI surfaces are still no-ops.** `ExtensionUIContext` methods beyond the three dialogs (widgets, status, editor, `custom`) remain unimplemented under PI WEB even though `hasUI` is `true`; do not rely on `hasUI` alone to detect them.

One browser-local caveat: reloading the browser while a new session is still being created loses the browser-local pending-start row, so the dialog card disappears from view. The daemon-side dialog still settles at its deadline and the session appears in the sidebar once creation completes.

## Trust model

Treat every plugin package as trusted code:

- browser entries can call browser APIs, read workspace files, start terminal commands through helpers, and render arbitrary UI;
- server entries execute in-process inside sessiond with the PI WEB service user's filesystem, environment, and process permissions, and they share sessiond's event loop;
- a CPU-bound, blocking, or deadlocked callback can stall sessions, terminals, and health endpoints; abort/deadline signals bound only cooperative asynchronous code and cannot preempt code that ignores them;
- ordinary import, activation, start, health, and stop failures are attributed and quarantined where the host can catch them, but this is a stability boundary rather than a security boundary;
- plugins should not be installed from untrusted sources.

PI WEB's `/api/...` HTTP and WebSocket endpoints are internal implementation details. Browser code should use documented context helpers, including `context.backend.request()` for a paired server entry. Server code should use only `@jmfederico/pi-web/server-plugin-api`. Private routes, runtime objects, and source-internal imports are experimental and may change or disappear.

## Workspace providers and replacement ownership

Sessiond is the single authority for project workspace discovery and spawned-session target validation. One active plugin exclusively owns a project's workspace semantics:

1. Healthy or degraded primary providers probe first.
2. If exactly one primary returns `"claim"`, it owns the project.
3. If no primary claims, fallback providers probe. Bundled Git is a fallback provider.
4. Multiple claimants in the winning tier produce a visible conflict; PI WEB does not select by plugin id or import order.
5. If no provider claims, PI WEB exposes the project folder as the kernel workspace. If a winner claims and then fails to list, PI WEB reports degraded state instead of silently switching owners.

PI WEB ships only the bundled Git production provider. Replacement integrations, including Jujutsu providers, are owned and distributed by third parties. An installed and enabled primary provider can claim its projects and suppress fallback Git without any PI WEB core changes; this documentation does not promise or ship a reference replacement.

## What to ask AI to build

Humans should not need to hand-code plugins. Give an AI agent a concrete UI goal and ask it to create or modify a local plugin.

Good plugin requests:

- "Show a workspace badge with the dev server URL from `.env`."
- "Add a workspace panel with links to logs, dashboards, and local services for this repo."
- "Add an action-palette command that starts a standard code-review prompt."
- "Show whether the current workspace is a git worktree, main checkout, staging env, or feature branch."
- "Add a compact status badge based on a project health file or command output saved in the repo."

Copy-paste prompt for creating a plugin:

```text
Build a PI WEB plugin for this project.
Goal: <describe the UI behavior>.
Before coding, read the PI WEB plugin docs:
https://pi-web.dev/plugins
Full API reference:
https://pi-web.dev/plugins.md
Create it as a local plugin under ~/.pi-web/plugins/<plugin-id>.
Use the appropriate extension points from the docs.
Validate by checking /pi-web-plugins/manifest.json and explain how to reload/debug it.
Do not modify PI WEB itself.
```

Copy-paste prompt for modifying a plugin:

```text
Improve the PI WEB plugin at <path>.
Before coding, read the PI WEB plugin docs:
https://pi-web.dev/plugins
Full API reference:
https://pi-web.dev/plugins.md
Keep the browser entry on API v2 and any server entry on API v1.
After editing, check the manifest endpoint and browser-console failure cases.
```

## Canonical example: bundled Info plugin

PI WEB ships a real bundled `info` plugin. Use it as the reference example because it is intentionally small while still exercising all core contribution types: an action, a workspace label, and a workspace panel.

Bundled PI WEB plugins are developed as TypeScript in the repository, but their `package.json` metadata still points at built JavaScript because plugins are loaded by the browser as JS ES modules. `npm run dev:web` watches and rebuilds bundled plugin TS into `dist/pi-web-plugins/` during development, and `npm run build` emits the JS before packaging a release.

Source files:

```text
pi-web-plugins/info/package.json
pi-web-plugins/info/pi-web-plugin.ts
pi-web-plugins/info/infoInternals.ts
```

`pi-web-plugin.ts` is the plugin skeleton: metadata plus contribution definitions. `infoInternals.ts` holds everything the bundled panel and action actually render, so you can ignore or replace it when copying the plugin.

Built module:

```text
dist/pi-web-plugins/info/pi-web-plugin.js
```

Package metadata:

```json
{
  "name": "@pi-web/info-plugin",
  "private": true,
  "piWeb": {
    "plugins": [
      { "id": "info", "browserRoot": ".", "module": "pi-web-plugin.js" }
    ]
  }
}
```

Module shape excerpt:

```js
export default {
  apiVersion: 2,
  name: "Info Plugin",
  activate: ({ html, svg }) => ({
    contributions: {
      actions: [/* action definitions */],
      workspaceLabels: [/* compact label definitions */],
      workspacePanels: [/* panel definitions using html, optional icons using svg */],
    },
  }),
};
```

When copying the Info plugin, choose a new plugin id so it does not conflict with the bundled `info` plugin.

The Info panel doubles as an always-available PI WEB status view: it renders the host-provided `context.state.piWebStatus` (PI WEB and Pi versions, installation, release state, machine, and workspace details) without issuing its own requests, and its action copies a plain-text diagnostics summary suitable for bug reports.

PI WEB also ships an `updates` plugin that demonstrates dynamic `visible` and `badge` callbacks for tabs that only appear when the host has status messages or needs extra install visibility.

## Canonical dual-entry provider: bundled Git

The bundled `git` plugin is the production example for a paired browser module and workspace-provider server module. Both entries use the same public contracts available to an installed plugin:

```text
pi-web-plugins/git/package.json
pi-web-plugins/git/browser/pi-web-plugin.ts
pi-web-plugins/git/server-plugin.ts
```

Its built `.js` server entry is a Node ES module, so its package declares `"type": "module"`. Do the same for an installed provider whose `serverModule` ends in `.js`, or emit `.mjs`; do not rely on Node's typeless-module reparsing.

Its TypeScript entries import declarations only from the published package subpaths:

```ts
import type { PiWebPlugin } from "@jmfederico/pi-web/plugin-api";
import type { PiWebServerPlugin, WorkspaceProvider } from "@jmfederico/pi-web/server-plugin-api";
```

Git declares `machineSpecific: true`, contributes a fallback workspace provider, and implements its status/diff backend and removal plan through the public provider callbacks. It receives no raw routes or private PI WEB services. Use it to understand the demonstrated contract, not as a template for Git-specific fields: replacement providers define their own private data, public metadata, backend operations, and removal wording.

## Copyable standalone workspace-provider example

The repository and published npm package include [`examples/workspace-provider-plugin/`](https://github.com/jmfederico/pi-web/tree/main/examples/workspace-provider-plugin), a small standalone package you can copy without PI WEB source imports. It includes package metadata, a strict NodeNext TypeScript configuration, browser and server source, and build/install instructions.

The example uses browser API v2 and server API v1. Its browser entry compares `workspace.provider.pluginId` with the stable source `pluginId`, uses `runtimePluginId` only to open its qualified panel, displays non-secret `publicMetadata`, and calls the backend owned by the selected workspace. Its server provider conservatively claims only projects containing `.pi-web/example-workspace-provider`. The explicit `browserRoot: "dist/browser"` keeps `dist/server.js`, source, package metadata, and dependencies outside browser asset routes.

Copy the example from a checkout or from `node_modules/@jmfederico/pi-web/examples/workspace-provider-plugin`, then follow its README. It deliberately does not advertise removal; use the removal contract below when adding that capability.

## Local plugin usage

This works with the production native-service install. PI WEB discovers packages from `~/.pi-web/plugins/<plugin-package>/`; if `PI_WEB_DATA_DIR` is set, use `$PI_WEB_DATA_DIR/plugins` instead. No PI WEB rebuild is required.

Symlink a plugin folder into PI WEB's local plugin directory:

```bash
mkdir -p ~/.pi-web/plugins
ln -s /path/to/plugin-folder ~/.pi-web/plugins/plugin-id
```

For a browser-only package, reload the PI WEB tab after installing or editing it. PI WEB uses a package-content revision in the module URL; hard reload if an already-open page still holds old JavaScript. For a package with `serverModule`, restart sessiond to activate the startup snapshot, then reload the browser. Editing files alone never hot-reloads or unloads server code.

## Remote machine plugins

When [machine federation](https://pi-web.dev/machines) is enabled, PI WEB loads the selected remote machine's compatible browser plugins through the gateway and runs its server entries in that remote machine's session daemon. Contributions and helpers are machine-scoped:

- actions, workspace panels, and workspace labels appear only for the applicable selected machine;
- file and terminal helpers run against that machine;
- `context.backend.request()` and `context.backend.requestBinary()` are routed through the gateway to the current workspace owner on that machine;
- a server-backed browser module is published only when its package source, scope, settings fingerprint, browser revision, and backend revision match the active sessiond snapshot and the backend is not unhealthy;
- if gateway and remote packages share an original id, `machineSpecific` controls whether the portable gateway copy is reused or the selected machine's own copy is required;
- remote theme contributions are ignored for now because themes are app-wide.

The remote manifest and backend bridge use a versioned lifecycle contract. A future/unsupported lifecycle version, a missing backend route, or a mismatched frontend/backend revision produces an explicit compatibility error; PI WEB does not silently run an unpaired server-backed UI.

Plugin/provider compatibility is intentionally all-or-nothing during a mixed-version fleet rollout. A newer gateway rejects an older target's whole remote plugin manifest when the target lacks the current lifecycle contract, so even that target's browser-only plugin contributions and Git panel are unavailable. In the other upgrade order, an older gateway still calls the legacy core Git routes removed by an updated target, so remote Git status/diff requests return `404`. Upgrade the gateway and target together, restart their updated web/API processes and the target session daemon, then reload the gateway tab. Other machine features remain subject to their own capability negotiation.

Remote desired enablement is stored in the remote machine's PI WEB config. Select that machine in **Settings → PI WEB plugins** to edit it, or open the machine directly/edit its config. Browser-only changes need a page reload. Server-backed changes need a restart of that remote session daemon followed by a page reload.

Plugin package metadata may set `machineSpecific: true` when the plugin's meaning is tied to the selected PI WEB machine:

- Omitted or `false`: valid for browser-only plugins; use the gateway copy when the same id is present remotely.
- `true`: the gateway copy appears only for the local machine, and a selected remote machine uses only its own copy. Dual browser/server entries are always machine-specific; omitting the field defaults them to `true`, while explicitly setting `false` is invalid.

For portable plugin assets, prefer URLs relative to the plugin module:

```js
const url = new URL("./asset.json", import.meta.url);
```

In browser API v2, activation `pluginId` is always the stable package/source id, locally and through federation. Compare it directly with `workspace.provider.pluginId` for ownership. `runtimePluginId` is the separately named host-unique id for qualified contribution references such as `${runtimePluginId}:workspace.panel`; a remote host may machine-scope it.

Do not construct absolute plugin asset routes from either identity. Module-relative URLs keep the host-selected runtime scope and deployment base automatically; hard-coded `/pi-web-plugins/...` paths can point at the wrong machine or break nested deployments.

## Manage PI WEB plugins

Open **Settings → PI WEB plugins** to compare desired package/config state with the active sessiond startup snapshot on the selected machine. The list includes bundled, local, dev, and Pi-package-supplied plugins, disabled discovered entries, and entries known only to the still-active snapshot. It reports browser-only, active, failed, incompatible, disabled, not-active, unknown, conflict, stale-revision, health, safe-mode, and restart-required states. Settings and diagnostics expose fingerprints and revisions, not plugin setting values.

Plugin enablement is separate from package installation. Use **Settings → Pi packages** to install, remove, or update a Pi package. The PI WEB plugin panel writes the selected machine's top-level `plugins` config key. It remains possible to edit desired config while sessiond is unavailable, although active state cannot then be verified.

```json
{
  "plugins": {
    "git": {
      "enabled": true,
      "settings": {}
    },
    "info": {
      "enabled": false
    }
  }
}
```

Plugins are enabled by default. `plugins.<id>.enabled: false` removes a browser-only entry on the next page load and prevents a server entry from loading on the next sessiond start. The optional `settings` object must be JSON-compatible and is captured for a server entry only at sessiond startup.

### Desired versus active state

Sessiond resolves one immutable enabled server-plugin snapshot at startup and remains the workspace authority for its lifetime. Saving config or replacing package files changes **desired** state only. The existing backend can remain active until sessiond restarts; conversely, its paired browser module is withheld when active and desired revisions no longer match. A web/API restart or browser reload does not change sessiond's active provider registry.

Use this sequence:

1. Install or update the package on the target machine.
2. Set the desired plugin enablement/settings.
3. For a browser-only plugin, reload the browser tab.
4. For a server-backed plugin, manually restart sessiond, wait for it to become available, then reload the browser tab.

> **Manual session-daemon restart:** for the native systemd user service, run `systemctl --user restart pi-web-sessiond` (the unit is `pi-web-sessiond.service`). Restarting sessiond may interrupt active sessions and runtime ownership. Web/UI autoreload, restarting only the web/API service, browser reload, and Pi's `/reload` command do not activate server-plugin changes.

### Offline disable and safe start

Recovery commands edit global PI WEB config without contacting sessiond, discovering packages, or importing plugin code. Run them on the affected target machine. Add `--config /path/to/config.json` when its services use a non-default `PI_WEB_CONFIG`.

```bash
pi-web plugins disable <plugin-id> --restart
pi-web plugins safe-start show
pi-web plugins safe-start set bundled-only --restart
pi-web plugins safe-start set none --restart
pi-web plugins safe-start clear --restart
```

- `disable` sets that plugin's desired `enabled` value to `false` while preserving unrelated config.
- `bundled-only` persists safe start and filters discovery before external local or Pi-package server modules are considered.
- `none` persists the emergency level and imports no server plugins; the kernel folder workspace remains available.
- `clear` returns the next startup to ordinary configured discovery.
- `--restart` requests an automatic restart only when PI WEB recognizes a safe installed-service action. Otherwise the command prints manual guidance.

An unsupported `serverPlugins.safeStart` shape or value in otherwise valid JSON fails closed as effective `none`: sessiond imports no server plugins and reports a diagnostic. Use `safe-start show`, then `set` or `clear`, to repair it offline. Recovery config is written before an automatic restart is attempted; if that service-manager command fails, restart sessiond manually.

Ordinary plugin failures are normally quarantined, but safe start provides a recovery path for code that blocks or terminates sessiond before normal containment can help. Any restart can interrupt active sessions/runtime ownership; inspect active work before using `--restart` or running the manual service command.

## Built-in plugins

PI WEB ships core, discoverable plugins in the main `@jmfederico/pi-web` npm package. No separate `pi install` step is required. After updating PI WEB, manually restart sessiond so bundled server entries use the installed revision, then reload the browser tab. Browser-only bundled entries need only the tab reload.

Built-in plugins can be managed from **Settings → PI WEB plugins** or with the top-level `plugins` config key.

### Git

**Plugin id:** `git`
**What it does:** claims Git projects as a fallback workspace provider, discovers worktrees, supplies provider-owned removal plans, and adds the Git status/diff workspace panel through its paired backend.

Git is enabled by default and is the only production workspace provider bundled with PI WEB. An enabled primary third-party provider can claim a project before Git. Disabling `git` and restarting sessiond leaves the kernel project-folder workspace available; reload the browser afterward so Git contributions disappear. The generic Files, Terminal, and Session features continue to work in that folder workspace.

### Updates

**Plugin id:** `updates`
**What it does:** adds a conditional **Updates** workspace tab with PI WEB update, restart, and installed-service guidance, plus a **Check for PI WEB Updates** action for the selected machine.

While a browser tab is connected, PI WEB refreshes the selected machine's status every 15 minutes. npm release lookups are cached on that machine for six hours, so the automatic refresh normally contacts npm at most once in that window. Run **Check for PI WEB Updates** from the action palette to bypass both caches and check immediately. Operator settings that skip remote version checks, such as `PI_WEB_OFFLINE`, are still respected.

Updates is enabled by default. It declares `machineSpecific: true` so the gateway Updates tab and action only appear for the local machine; while a remote machine is selected, that remote machine's Updates plugin is used if available. To hide it, disable `updates` in **Settings → PI WEB plugins** or set:

```json
{
  "plugins": {
    "updates": { "enabled": false }
  }
}
```

### Workspace Tasks

**Plugin id:** `workspace-tasks`
**Config file:** `.pi-web/tasks.json`
**What it does:** adds a **Tasks** workspace tab for running configured shell commands in dedicated PI WEB terminals.

Workspace Tasks is enabled by default. To hide it, disable `workspace-tasks` in **Settings → PI WEB plugins** or set:

```json
{
  "plugins": {
    "workspace-tasks": { "enabled": false }
  }
}
```

Configure workspace tasks in `.pi-web/tasks.json`:

```json
{
  "version": 1,
  "tasks": [
    {
      "id": "app.start",
      "title": "Start app",
      "group": "Development",
      "description": "Start the local development server.",
      "command": "npm run dev"
    },
    {
      "id": "db.reset",
      "title": "Reset DB",
      "group": "Database",
      "command": "go -C klingit-go run ./cli db reset",
      "confirm": true
    }
  ]
}
```

Open a workspace, choose the **Tasks** tab, and click **Run** next to a task. Commands run in the workspace root because PI WEB creates the terminal for that workspace.

Task fields:

- `version`: must be `1`.
- `tasks`: array of task definitions.
- `id`: stable task id, matching `^[a-z][a-z0-9.-]*$`.
- `title`: button label.
- `command`: literal shell command sent to the terminal.
- `description`: optional explanatory text.
- `group`: optional group heading.
- `confirm`: optional boolean. When true, the browser asks before dispatching the command.

Review task configs before running them, especially in shared projects. Workspace Tasks runs trusted shell commands from your repositories.

### Relays

**Plugin id:** `relays`
**What it does:** adds a read-only **Relays** workspace tab for browsing the workspace's relays, plus an **Open Workspace Relays** action for the selected workspace that opens the same tab.

A relay is a directory of markdown notes under `.pi-web/relays/<name>/` in the workspace root — the convention used by the Relay method for chaining agent sessions. The tab lists each relay's documents with `status.md`, `charter.md`, and `log.md` first (in that order), followed by any other files alphabetically, and opens `status.md` by default. Markdown documents render as sanitized HTML; other files render as preformatted text, and binary files have no preview. Truncated documents show a notice, and **Refresh** re-scans the workspace and reloads the open document.

Documents in subfolders are listed too. Folders appear as chips in the document strip, and expanding one inserts its files inline right after it — accordion-style, so expanding a folder collapses its siblings on the same level. An expanded folder wraps its chip and documents in a group bubble, so nested entries stay visually contained. Collapsing the folder that holds the open document keeps the selection and highlights the folder instead. Relay trees deeper than five levels, larger than 200 documents, or with more than 50 folders are listed partially, with a notice.

With several relays, a picker pre-selects the most recently modified one; a single relay opens directly. A workspace without `.pi-web/relays/` shows an empty state explaining the convention. The tab never creates, edits, or deletes relay files.

Relays is enabled by default. To hide it, disable `relays` in **Settings → PI WEB plugins** or set:

```json
{
  "plugins": {
    "relays": { "enabled": false }
  }
}
```

## Discovery and packaging

The web/API catalog and sessiond startup catalog use the same package sources. The browser manifest includes only compatible entries that declare `module`; sessiond considers enabled entries that declare `serverModule`:

1. Bundled plugins in the PI WEB package:

   ```text
   pi-web-plugins/<plugin-package>/
   ```

2. User-local plugins:

   ```text
   ~/.pi-web/plugins/<plugin-package>/
   ```

   Entries may be real directories or symlinks. This is the recommended development workflow.

3. Installed Pi packages that expose PI WEB plugin metadata. Pi packages may be user or project scoped. Installing/removing/updating Pi packages is done from **Settings → Pi packages** (or Pi's package manager), not from the PI WEB plugin enable/disable list.

Remote machines expose their versioned browser manifests through the gateway at `/api/machines/<machine-id>/pi-web-plugins/manifest.json`. Those plugin modules are rewritten to gateway-scoped asset URLs and registered under machine-scoped runtime ids so package copies on different machines do not collide.

Plugin package directory names and plugin ids must be valid identifiers:

```text
^[a-z][a-z0-9.-]*$
```

A package can expose one or more PI WEB plugin entries. There is exactly one supported `package.json` metadata shape:

```json
{
  "private": true,
  "type": "module",
  "piWeb": {
    "plugins": [
      {
        "id": "review",
        "browserRoot": "dist/review",
        "module": "dist/review/index.js"
      },
      {
        "id": "workspaces",
        "browserRoot": "dist/browser",
        "module": "dist/browser/index.js",
        "serverModule": "dist/server.js",
        "machineSpecific": true
      },
      { "id": "server-only", "serverModule": "dist/server-only.js" }
    ]
  }
}
```

Rules:

- `piWeb.plugins` must be an array of objects.
- Each entry must have an explicit `id` and at least one of `module` or `serverModule`.
- `id` must match `^[a-z][a-z0-9.-]*$`. Externally declared ids `core`, `themes`, and every `machine.*` id are reserved for the host and rejected with an attributed package diagnostic.
- Both module paths must be safe canonical relative paths to existing files inside the package root. Backslashes, absolute or Windows drive-qualified paths, and empty, `.`, `..`, `.git`, or `node_modules` segments are rejected.
- Every browser entry must declare `browserRoot`; a server-only entry must not. The root is `.` or a safe canonical package-relative directory with no empty, `.`, `..`, `.git`, or `node_modules` segment; Windows drive-qualified roots are rejected. It must resolve inside the package, and the browser module must remain inside it both logically and after symlink resolution.
- Server entries are imported as Node ES modules. When a `serverModule` uses a `.js` path, declare `"type": "module"` in that plugin package; `.mjs` is the explicit-extension alternative.
- `machineSpecific` is optional and must be boolean. Browser-only and server-only entries default to `false`. Dual browser/server entries default to `true` and cannot explicitly set it to `false`.
- `plugins.<id>.settings` must be JSON-compatible for server entries; sessiond captures a private copy at startup and diagnostics expose only a fingerprint.
- A plugin id has one package owner across its browser and server capabilities. Duplicates are diagnosed and never merged or auto-renamed; later package records are skipped.
- Legacy shortcuts such as `piWeb.plugin`, string entries in `piWeb.plugins`, `piWeb.id` fallback ids, and no-`package.json` fallbacks are not supported.

Discovery hashes the package (without traversing `.git` or `node_modules`) to produce one package-wide revision and enforce one package-wide artifact budget. A package is rejected when the scan exceeds **4,096 directory entries** or **16 MiB of file content**. These limits include files outside `browserRoot`, even though those files are not served. Keep generated caches and unrelated large artifacts out of the installed plugin package.

### Manifest and assets

The manifest contains a lifecycle version and each publishable browser module. Current PI WEB releases emit `module` as a leading application-root reference and include `backendRevision` only for a paired active server entry:

```json
{
  "lifecycleVersion": 1,
  "plugins": [
    {
      "id": "workspaces",
      "module": "/pi-web-plugins/workspaces/dist/browser/index.js?v=<content-revision>",
      "backendRevision": "<active-server-revision>",
      "source": "local",
      "scope": "local",
      "machineSpecific": true
    }
  ]
}
```

The browser maps leading application-root references into the current application base, so the same manifest works at the origin root or under a reverse-proxy path prefix. Federated gateways additionally accept explicit manifest-relative references such as `./my-plugin/pi-web-plugin.js` and legacy plugin-root-relative references such as `nested/pi-web-plugin.js`; all accepted forms are rewritten to deployment-portable, gateway-relative references.

`source` describes where the plugin came from (`bundled`, `local`, or the Pi package source). `scope` is `bundled`, `local`, `user`, or `project`. `machineSpecific` controls whether the gateway copy is valid for remote machines or only each selected machine's own copy can appear. A server-only entry has no browser manifest record. A dual entry is omitted unless sessiond reports the exact active, compatible, non-unhealthy package pairing.

At an origin-root deployment, a browser-public file is available under its package-relative path:

```text
/pi-web-plugins/<plugin-id>/<package-relative-path-under-browserRoot>
```

Only files logically inside `browserRoot` and canonically inside that same directory after symlink resolution are captured and served. Files elsewhere in the package—including a sibling server module, source, metadata, and dependencies—return not found through plugin asset routes. Declaring `browserRoot: "."` therefore makes almost the whole scanned package browser-public; prefer a narrow output directory and never place secrets inside it. Unsafe, missing, package-escaping, or module-excluding roots fail discovery with an attributed diagnostic.

Prefer module-relative asset URLs so they also work for remote machine plugins and nested deployments. For example, a built plugin module can reference an SVG shipped beside it:

```js
const iconUrl = new URL("./assets/icon.svg", import.meta.url);
```

The final installed plugin package must contain `assets/icon.svg` at that path relative to the final built module and inside `browserRoot`. PI WEB serves files that already exist in the package; it does not copy a source `public/` directory or apply Vite-style public-directory semantics. Configure the plugin build and package contents to emit or copy the asset into its final module-relative location.

PI WEB returns executable JavaScript MIME types for both `.js` and `.mjs`. JSON, CSS, HTML, and SVG receive their corresponding content types; unknown file types are served as octet-stream.

## Browser module shape and v2 migration

TypeScript browser entries should use a type-only import from the published declaration entrypoint. The built JavaScript must not import PI WEB source internals:

```ts
import type { PiWebPlugin } from "@jmfederico/pi-web/plugin-api";

const plugin: PiWebPlugin = {
  apiVersion: 2,
  name: "My Plugin",
  activate: ({ pluginId, runtimePluginId, html }) => ({
    contributions: {
      actions: [{
        id: "workspace.open",
        title: "Open my panel",
        run: ({ selectWorkspaceTool }) => {
          selectWorkspaceTool(`${runtimePluginId}:workspace.my-panel`);
        },
      }],
      workspacePanels: [{
        id: "workspace.my-panel",
        title: "My panel",
        visible: ({ workspace }) => workspace.provider?.pluginId === pluginId,
        render: ({ workspace }) => html`<p>${workspace.label}</p>`,
      }],
    },
  }),
};

export default plugin;
```

The activation boundary is:

```ts
interface PiWebPlugin {
  apiVersion: 2;
  name: string;
  activate(context: PluginActivationContext): PluginActivationResult;
}

interface PluginActivationContext {
  readonly apiVersion: 2;
  readonly pluginId: string;
  readonly runtimePluginId: string;
  readonly html: HtmlTemplateTag;
  readonly svg: SvgTemplateTag;
}
```

`activate()` is called once when the UI loads the plugin. Keep it cheap and synchronous: define contributions there, but move expensive or async work into actions, custom elements, or explicit user interactions.

Browser API v2 is a deliberate break: the host rejects browser v1 entries with the plugin/module identity and expected version; there is no v1 compatibility shim. Migrate a browser entry by setting `apiVersion: 2`, using stable `pluginId` for package/provider ownership, and using `runtimePluginId` when constructing a host-qualified contribution reference. Replace browser-v1 `refreshGit` with `refreshWorkspacePanels()` plus panel `onInvalidate()`. The browser-v1 `isGitRepo`, `isGitWorktree`, and top-level `workspace.branch` aliases were removed; use the provider-authored `workspace.label` for generic presentation, and keep provider-specific facts in `workspace.provider.metadata` or the owning backend. The former `@jmfederico/pi-web/plugin-api/unstable` type path is not part of v2 and is no longer exported.

Contribution ids authored in arrays remain local to the plugin. PI WEB qualifies them internally under the runtime identity:

```text
<runtime-plugin-id>:<local-contribution-id>
```

For a local plugin the runtime and source ids are normally equal. A federated registration may machine-scope `runtimePluginId`, while `pluginId` and `workspace.provider.pluginId` remain the same source id.

## Server module and workspace provider shape

TypeScript server entries import the separately published Node declarations with `import type`:

```ts
import type {
  PiWebServerPlugin,
  WorkspaceProvider,
} from "@jmfederico/pi-web/server-plugin-api";

const provider: WorkspaceProvider = {
  async probe(project, signal) {
    // Return "claim" only when this provider owns the project's semantics.
    return await projectIsSupported(project, signal) ? "claim" : "pass";
  },
  async list(project, signal) {
    return await listProviderWorkspaces(project, signal);
  },
  async request({ project, workspace, operation, input, signal }) {
    return await handleProviderOperation({ project, workspace, operation, input, signal });
  },
};

const plugin: PiWebServerPlugin = {
  apiVersion: 1,
  name: "My Workspace Provider",
  activate(context) {
    return {
      workspaceProvider: provider,
      health: async (signal) => ({ status: "healthy" }),
      stop: async (signal) => { /* release plugin-owned resources */ },
    };
  },
};

export default plugin;
```

The default export has `apiVersion: 1`, a non-empty `name`, and `activate(context)`. The activation result can contain:

```ts
interface ServerPluginActivation {
  workspaceProvider?: WorkspaceProvider;
  start?(signal: AbortSignal): void | Promise<void>;
  stop?(signal: AbortSignal): void | Promise<void>;
  health?(signal: AbortSignal): ServerPluginHealth | Promise<ServerPluginHealth>;
}
```

A server plugin may contribute at most one `workspaceProvider`. The host-owned frozen activation context contains its `pluginId`, `packageRoot`, JSON settings snapshot, scoped logger, activation `AbortSignal`, and an argv-based `execFile()` helper. `execFile()` has host-owned timeout/output bounds and accepts an optional bounded stdin payload — see [Command stdin and sensitive payloads](#command-stdin-and-sensitive-payloads). Pass the current callback's signal into every command request. The API exposes no shell parser, Fastify instance, route registration, concrete service, event bus, or service locator.

Every activation, lifecycle, provider, and request signal is scoped to that one invocation. The host aborts it when the invocation times out or settles. Do not retain a signal as a plugin-lifetime shutdown notification; release plugin-owned resources in the explicit `stop()` callback. Deadlines remain cooperative, so plugins must observe each supplied signal.

### Command stdin and sensitive payloads

`execFile()` accepts an optional `stdin: string | Uint8Array` payload that the host pipes to the command's standard input — no shell is involved, so the bytes reach the command exactly as given. Prefer stdin over `args` or `env` for secrets: argv is visible in process listings, and environment blocks propagate to child processes.

- Strings are UTF-8 encoded; `Uint8Array` payloads pass through byte for byte. An empty payload behaves like an absent stdin.
- The host enforces a byte cap on the payload (1 MiB by default; the host controls the bound) and rejects over-cap requests before spawning. Cap errors report byte counts only, never payload content.
- The host never logs the payload, never includes it in errors, and zeroes its retained copy once the command settles. The plugin remains responsible for its own copy.
- A command that exits without reading stdin does not fail the operation; the command's own exit status remains the outcome.
- Command results return captured stdout/stderr as text to the plugin. Never echo a secret back through a provider `request()` response: those responses cross to browser callers.

Sessiond resolves the enabled catalog once per process start. It imports, validates, activates, and starts each server entry before publishing its contribution. A failed entry is attributed and skipped without aborting ordinary activation of other plugins; a failed `start` is rolled back with `stop` when available. Successful plugins stop in reverse activation order. Sessiond inspects each optional `health()` callback once while building the startup workspace authority; an unhealthy provider is excluded, a degraded provider remains eligible, and that inspection is not polled again during the process lifetime. Server entries are never hot-reloaded or unloaded after config/package edits.

### Workspace provider contract

```ts
interface WorkspaceProvider {
  fallback?: boolean;
  probe(project: ProjectInput, signal: AbortSignal): Promise<"claim" | "pass">;
  list(project: ProjectInput, signal: AbortSignal): Promise<ProviderWorkspace[]>;
  request?(context: ProviderRequestContext): Promise<JsonValue>;
  requestBinary?(context: ProviderBinaryRequestContext): Promise<JsonValue>;
  prepareRemove?(context: ProviderRemoveContext): Promise<WorkspaceRemovePlan>;
}

interface ProviderWorkspace {
  key: string;
  path: string;
  label: string;
  isMain: boolean;
  data?: JsonValue;
  publicMetadata?: JsonObject;
  removal?: { actionLabel: string; confirmation: string };
}
```

- `probe()` must return only `"claim"` or `"pass"`. Leave `fallback` unset/false for a replacement that should run before bundled Git.
- `list()` runs only for the selected owner. Return stable provider-local keys, accessible absolute directory paths, unique paths/keys, non-empty labels, and exactly one main workspace.
- `data` is round-tripped privately to that provider during the current resolution. `publicMetadata` appears under `workspace.provider.metadata` and is visible to **all browser code and API consumers**. Never put secrets in `publicMetadata` or removal wording.
- `request()` is optional and receives a host-validated frozen current owner/workspace projection plus a bounded operation id, JSON input, and operation-scoped abort signal. It must return JSON.
- `requestBinary()` is the opt-in raw binary counterpart of `request()`: it receives a bounded (1 MiB) opaque `Uint8Array` body instead of JSON input — see [Raw binary backend request bodies](#raw-binary-backend-request-bodies). The host holds the body in memory only for the invocation and never logs or persists it; the result remains JSON.
- `removal` is display text only and requires `prepareRemove()`. It advertises removal for that specific workspace; browser `workspace.provider.capabilities.remove` is true only when that workspace advertises it and the owning provider implements removal.
- `prepareRemove()` returns a plan for a visible host-owned terminal run; returning the plan approves the operation but does **not** mean removal has completed. `command` is shell source interpreted by the host's login shell. The host chooses a safe current working directory outside the target, so the provider must use the supplied absolute `workspace.path`, shell-quote it, and keep removal in the foreground. The host records completion when the shell exits, with exit status 0 meaning success.
- Provider failures and conflicts are diagnostics. A claimant that fails `list()` does not permit fallback takeover for the same resolution.

The only supported plugin type entrypoints are the type-only package exports `@jmfederico/pi-web/plugin-api` and `@jmfederico/pi-web/server-plugin-api`. Use them with `import type`; there is no runtime JavaScript export. Private `dist/**` deep imports and any other plugin API subpath are not part of the package contract.

## Contributions

The workspace-related contribution arrays returned by `activate()` are:

```ts
interface PluginContributions {
  actions?: PluginAction[];
  workspacePanels?: WorkspacePanelContribution[];
  workspaceLabels?: WorkspaceLabelContribution[];
}
```

### Actions

Actions appear in the action palette. They can inspect app state and call UI/runtime helpers.

```js
actions: [
  {
    id: "copy-diagnostics",
    title: "Copy PI WEB Diagnostics",
    description: "Copy version, installation, and status details for this machine",
    group: "Info",
    run: async (context) => {
      const version = context.state.piWebStatus?.components.web.runtimeVersion ?? "unknown";
      await navigator.clipboard.writeText(`PI WEB ${version}`);
    },
  },
]
```

Action type:

```ts
interface PluginAction {
  id: string;
  title: string;
  description?: string;
  shortcut?: string;
  shortcutAliases?: QualifiedContributionId[];
  group?: string;
  enabled?: (context: PluginRuntimeContext) => boolean;
  disabledReason?: (context: PluginRuntimeContext) => string | undefined;
  run: (context: PluginRuntimeContext) => void | Promise<void>;
}
```

If an action is disabled and returns `disabledReason`, PI WEB can keep it visible in the action palette with that explanation instead of hiding it.

Stable runtime context fields:

```ts
interface PluginRuntimeContext {
  state: {
    selectedMachine?: PluginMachine;
    selectedWorkspace?: Workspace;
    selectedSession?: unknown;
    workspaceTool?: string;
    mainView?: string;
    piWebStatus?: PiWebStatusResponse;
  };
  prompt: PluginPromptEditor;
  openActionPalette: () => void;
  focusPrompt: () => void;
  addProject: () => void | Promise<void>;
  configureAuth: () => void | Promise<void>;
  logoutAuth: () => void | Promise<void>;
  openThemePicker: () => void;
  selectMainView: (view: string) => void;
  selectWorkspaceTool: (tool: QualifiedContributionId) => void;
  openTerminal: (options?: { terminalId?: string }) => void;
  refreshFiles: () => void | Promise<void>;
  refreshWorkspacePanels: (panelId?: QualifiedContributionId) => void | Promise<void>;
  refreshAppData: () => void | Promise<void>;
  checkForPiWebUpdates?: () => void | Promise<void>;
  reloadPage: () => void;
  startSession: () => void | Promise<void>;
  archiveSession: () => void | Promise<void>;
  stopActiveWork: () => void | Promise<void>;
}
```

Notes:

- `state` is a snapshot of current UI state when actions are built.
- The stable state fields are `state.selectedMachine`, `state.selectedWorkspace`, `state.selectedSession`, `state.workspaceTool`, `state.mainView`, and `state.piWebStatus`. `state.selectedMachine` identifies the currently selected machine. `state.piWebStatus` describes the currently selected machine's PI WEB runtime, or the gateway/local runtime when the local machine is selected.
- Other `state` fields may exist at runtime, but they are private PI WEB internals that may graduate into stable helpers, change shape, or disappear.
- `enabled` is evaluated when the action palette asks for actions.
- `shortcutAliases` is for migration only: list former fully qualified action ids whose saved shortcut preference should still apply to this action.
- `selectWorkspaceTool()` expects a qualified panel id such as `my-plugin:workspace.info`.
- `openTerminal()` switches to the built-in terminal panel. Pass `{ terminalId }` to deep-link to a specific terminal.
- `refreshWorkspacePanels()` invokes `onInvalidate` for the selected workspace, either for every plugin panel or for one qualified `panelId`. The callback owns its refresh and should request a render when its visible state changes.
- `checkForPiWebUpdates()` forces a fresh update check on the selected machine and refreshes `state.piWebStatus`. It is optional so plugins remain compatible with older PI WEB hosts.
- Only fields documented here and declared by `@jmfederico/pi-web/plugin-api` are stable public browser API. Anything else is experimental: it may become public API later, change shape, or disappear.

### Prompt editor API

The `prompt` helper on `PluginRuntimeContext` and `WorkspacePanelContext` provides stable access to the chat prompt editor:

| Method | Description |
| --- | --- |
| `insertText(text)` | Insert text at cursor position. When text is selected, replaces the selection. Focuses the editor first if not focused. |
| `getText()` | Returns the full prompt text. |
| `getSelection()` | Returns `{ start, end, text }` if text is selected, or `null`. |

Usage:

```js
// Insert text at the cursor (e.g. a file mention)
context.prompt.insertText("@file.txt");

// Read the current prompt and selection
const text = context.prompt.getText();
const selection = context.prompt.getSelection(); // { start, end, text } | null
```

Use `focusPrompt()` on `PluginRuntimeContext` to move focus to the prompt editor. Workspace panels can call `context.prompt.insertText()` from explicit user interactions such as button clicks; panel contexts target the currently selected session's mounted prompt editor.

#### Keyboard shortcuts

- App-level keyboard shortcuts must be attached to actions. PI WEB does not support standalone plugin keyboard commands; contribute an action first, then add a `shortcut` if it needs a keybinding.
- `shortcut` is the action's default keybinding. It is displayed in the action palette and handled by the global shortcut dispatcher when the action is enabled.
- Use modified shortcuts such as `mod+shift+p`; plain letter shortcuts are intentionally ignored so normal typing is never captured.
- Future PI WEB versions may allow users to override or disable action shortcuts by action id, so plugins should treat `shortcut` as a default rather than a guaranteed final binding.
- Choose shortcuts carefully to avoid conflicts. There is no user-facing shortcut override or conflict resolver yet.
- Local text input, terminal input, list navigation, and dialog keys such as Enter, Escape, and arrow keys do not need to be plugin actions unless they are app-level commands.

### Workspace panels

Workspace panels add tools next to built-in workspace tools. They render inside the workspace side panel on desktop and as mobile tabs on smaller screens.

```js
workspacePanels: [
  {
    id: "workspace.info",
    title: "Info",
    icon: svg`
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="9"></circle>
        <path d="M12 10v6"></path>
        <path d="M12 7h.01"></path>
      </svg>
    `,
    order: 100,
    visible: ({ workspace }) => workspace.isMain,
    render: ({ workspace }) => html`
      <section class="toolbar"><strong>Info</strong></section>
      <section class="viewer">
        <p class="muted">${workspace.label}</p>
        <p class="muted">${workspace.path}</p>
      </section>
    `,
  },
]
```

Panel type:

```ts
interface WorkspacePanelContribution {
  id: string;
  title: string;
  icon?: TemplateResult;
  order?: number;
  routeAliases?: string[];
  visible?: (context: WorkspacePanelContext) => boolean;
  badge?: (context: WorkspacePanelContext) => string | number | TemplateResult | undefined;
  onInvalidate?: (context: WorkspacePanelContext) => void | Promise<void>;
  render: (context: WorkspacePanelContext) => TemplateResult;
}

interface WorkspacePanelContext {
  machine: PluginMachine;
  workspace: Workspace;
  state?: PluginRuntimeState;
  files: {
    readFile(path: string): Promise<FileContentResponse>;
    listFiles(path: string): Promise<FileTreeResponse>;
    writeFile(path: string, content: string | Uint8Array, options?: WriteWorkspaceFileOptions): Promise<WriteWorkspaceFileResponse>;
    deleteFile(path: string): Promise<DeleteWorkspaceFileResponse>;
    moveFile(fromPath: string, toPath: string, options?: MoveWorkspaceFileOptions): Promise<MoveWorkspaceFileResponse>;
  };
  backend?: {
    request(operation: string, input: JsonValue): Promise<JsonValue>;
  };
  prompt: PluginPromptEditor;
  terminal: {
    open(options?: { terminalId?: string }): void;
    runCommand(input: {
      title: string;
      command: string;
      metadata?: Record<string, string>;
      open?: boolean;
    }): Promise<TerminalCommandRunHandle>;
  };
  host: {
    requestRender(): void;
  };
}
```

`icon` is optional and is used in the compact mobile tab bar. Prefer an SVG rendered with the `svg` helper from `PluginActivationContext`; use `currentColor` so PI WEB themes can style it. If `icon` is omitted, mobile tabs fall back to initials from the panel title, or to the full title when initials collide.

`machine`, `workspace`, `files`, optional `backend`, `prompt`, `terminal`, and `host` are documented as stable for panel callbacks. The `files` helper supports `readFile`, `listFiles`, `writeFile`, `deleteFile`, and `moveFile` — see [Reading workspace files](#reading-workspace-files), [Listing workspace files](#listing-workspace-files), and [Writing, deleting, and moving workspace files](#writing-deleting-and-moving-workspace-files). A browser entry with a paired active provider uses `backend.request()` instead of constructing API routes — see [Calling paired workspace backends](#calling-paired-workspace-backends). The `prompt` helper supports panel interactions that insert workspace context into the current prompt — see [Prompt editor API](#prompt-editor-api). Use `terminal.open()` to switch to the built-in terminal panel; pass `{ terminalId }` to deep-link to a specific terminal. `routeAliases` is only for migrating former URL tool/view values. Implement `onInvalidate()` to refresh plugin-owned panel data when an action or host refresh calls `refreshWorkspacePanels()`; call `host.requestRender()` when async state changes should make PI WEB re-evaluate `badge`, `visible`, or `render`.

Useful workspace and machine shapes:

```ts
interface PluginMachine {
  id: string;
  name: string;
  kind: "local" | "remote";
}

interface Workspace {
  readonly id: string;
  readonly projectId: string;
  readonly path: string;
  readonly label: string;
  readonly isMain: boolean;
  readonly provider?: {
    readonly pluginId: string;
    readonly capabilities: { readonly request: boolean; readonly remove: boolean };
    readonly metadata?: JsonObject;
  };
  readonly removal?: { readonly actionLabel: string; readonly confirmation: string };
}
```

`machine.id` is included in panel contexts so plugins can keep caches machine-scoped. Do not infer the selected machine from global browser state. Use the provider-authored `workspace.label` for provider-neutral presentation. `workspace.provider.pluginId` is the stable source id, and provider-published details such as Git status live in `workspace.provider.metadata`, which the server provider fills from browser-public `publicMetadata`. Provider-specific browser code may interpret metadata it owns; PI WEB core does not assign branch semantics to the generic workspace shape. `capabilities.remove` describes only this workspace, not the provider in general. The browser-v1 `isGitRepo`, `isGitWorktree`, and top-level `branch` aliases were removed.

Use existing classes such as `toolbar`, `viewer`, `empty`, and `muted` for panel content when possible. Do not assume a panel owns the whole page; keep layout contained.

### Workspace labels

Workspace labels add compact inline metadata wherever PI WEB displays a workspace label: workspace list, workspace panel header, and status bar.

Use them for short facts like project environment, local URL, branch status, container name, or health state.

```js
workspaceLabels: [
  {
    id: "dev-url",
    order: 10,
    visible: ({ workspace }) => workspace.path.includes("my-app"),
    items: () => [{
      type: "link",
      text: "web:5173",
      href: "http://localhost:5173",
      title: "Open dev server",
      target: "_blank",
    }],
  },
]
```

Label contribution type:

```ts
interface WorkspaceLabelContribution {
  id: string;
  order?: number;
  visible?: (context: WorkspaceLabelContext) => boolean;
  items: (context: WorkspaceLabelContext) => WorkspaceLabelItem[];
}

interface WorkspaceLabelContext {
  machine: PluginMachine;
  workspace: Workspace;
  state?: PluginRuntimeState;
  files: {
    readFile(path: string): Promise<FileContentResponse>;
    listFiles(path: string): Promise<FileTreeResponse>;
    writeFile(path: string, content: string | Uint8Array, options?: WriteWorkspaceFileOptions): Promise<WriteWorkspaceFileResponse>;
    deleteFile(path: string): Promise<DeleteWorkspaceFileResponse>;
    moveFile(fromPath: string, toPath: string, options?: MoveWorkspaceFileOptions): Promise<MoveWorkspaceFileResponse>;
  };
  backend?: {
    request(operation: string, input: JsonValue): Promise<JsonValue>;
  };
  host: {
    requestRender(): void;
  };
}
```

`machine`, `workspace`, `files`, optional `backend`, and `host` are documented as stable for label callbacks. The `files` helper supports `readFile`, `listFiles`, `writeFile`, `deleteFile`, and `moveFile` — see [Reading workspace files](#reading-workspace-files), [Listing workspace files](#listing-workspace-files), and [Writing, deleting, and moving workspace files](#writing-deleting-and-moving-workspace-files). A browser entry with a paired active provider can call `backend.request()` from a label-owned async cache after checking that the optional helper is present. Include `machine.id` in caches that depend on workspace data. Call `host.requestRender()` when async plugin-owned state changes should make PI WEB re-evaluate label `visible` or `items` callbacks.

Items are sorted by `order` and then id. Return an empty array to render nothing. Keep callbacks synchronous and lightweight; start async work from the callback, return cached items, then call `host.requestRender()` when the cache changes.

#### Text items

```js
{ type: "text", text: "staging", title: "Staging workspace" }
```

#### Link items

```js
{
  type: "link",
  text: "web:5173",
  href: "http://localhost:5173",
  title: "Open dev server",
  target: "_blank"
}
```

PI WEB renders the anchor and adds safe defaults such as `rel="noopener noreferrer"` for `_blank` links. `javascript:` and `data:` links are rendered as plain text instead of links.

#### Render items

Use render items when a label contribution needs custom UI, async data, or caching. Render items should stay compact and inline.

```js
class MyWorkspaceBadge extends HTMLElement {
  set workspace(value) {
    this._workspace = value;
    this.textContent = value?.label ?? "workspace";
  }
}

if (!customElements.get("my-workspace-badge")) {
  customElements.define("my-workspace-badge", MyWorkspaceBadge);
}

export default {
  apiVersion: 2,
  name: "My Plugin",
  activate: ({ html }) => ({
    contributions: {
      workspaceLabels: [
        {
          id: "badge",
          order: 10,
          items: ({ workspace }) => [{
            type: "render",
            render: () => html`<my-workspace-badge .workspace=${workspace}></my-workspace-badge>`,
          }],
        },
      ],
    },
  }),
};
```

## Calling paired workspace backends

Workspace panel and label contexts include an optional backend helper with JSON and raw binary request variants. It is present only for a browser entry paired with an active server backend:

```js
if (context.backend === undefined) throw new Error("Workspace backend unavailable");
const result = await context.backend.request("summary", {
  includeIgnored: false,
});
```

PI WEB binds the request to the browser module's original package id and active backend revision, plus the callback's selected machine, project, and workspace. The host resolves the current workspace owner again before dispatch. The call succeeds only when that same active plugin still owns the workspace and implements `WorkspaceProvider.request()`.

Operation ids must match `^[a-z][a-z0-9.-]*$` and be at most 128 characters. Inputs and results must contain only finite JSON values; functions, classes, `undefined`, cycles, and non-finite numbers are rejected. Requests, responses, owner resolution, and provider callbacks are size- and time-bounded.

The same helper works locally and through machine federation. It preserves machine scoping and active frontend/backend revision pairing, so browser plugins must not construct `/api/plugin-backends/...` or `/api/machines/...` URLs themselves. Missing/inactive backends, stale revisions/workspaces, ownership changes/conflicts, unsupported operations, invalid JSON, failures, and timeouts reject the promise with an attributed error.

### Raw binary backend request bodies

`context.backend.requestBinary(operation, body)` is the opt-in counterpart for operations that must receive an opaque byte payload rather than a JSON envelope — the motivating case is a sensitive value (for example a secret from a form field) that should cross the wire as an unlogged raw body instead of a JSON string. The server module opts in per operation by implementing `WorkspaceProvider.requestBinary()`:

```js
// browser entry
const secret = new TextEncoder().encode(form.value.secret);
await context.backend.requestBinary("secrets.store", secret);

// server entry
requestBinary: async ({ operation, body, signal }) => {
  if (operation !== "secrets.store") throw new Error(`Unsupported operation: ${operation}`);
  await execFile({ file: "receiver", args: ["store"], stdin: body, signal });
  return { stored: true };
},
```

- The body is a `Uint8Array` of at most 1 MiB; the bound is enforced at every hop (browser helper, web proxy, session daemon, and provider dispatch) and over-cap requests are rejected with byte-count-only errors.
- The host holds the body in memory only for the duration of the request: it is never logged, never written to disk, and never included in error messages. The plugin remains responsible for its own copy.
- Results stay bounded JSON. Never echo a sensitive payload back through the result: responses cross to browser callers.
- The active backend revision travels in a request header; the byte body is the entire request payload. Ownership re-resolution, revision pairing, deadlines, and federation support match the JSON variant, and a machine or session daemon without binary support fails with an explicit compatibility error.
- To hand the payload to a command, pass it as `execFile()` `stdin` — see [Command stdin and sensitive payloads](#command-stdin-and-sensitive-payloads).

## Reading workspace files

Workspace panels and workspace labels can read files through the documented `files` helper. PI WEB binds this helper to the callback's machine and workspace, so it works the same for local and federated machines.

```js
workspacePanels: [
  {
    id: "workspace.env",
    title: "Env",
    render: ({ files }) => html`
      <my-env-viewer .files=${files}></my-env-viewer>
    `,
  },
]

class MyEnvViewer extends HTMLElement {
  set files(value) {
    this._files = value;
    void this.load();
  }

  async load() {
    try {
      const file = await this._files.readFile(".env.example");
      this.textContent = file.binary ? "Binary file" : file.content;
    } catch (error) {
      this.textContent = error instanceof Error ? error.message : String(error);
    }
  }
}
```

Labels should use the same helper through a plugin-owned cache because `items()` itself must return synchronously:

```js
const envCache = new Map();

function envKey(machine, workspace) {
  return `${machine.id}:${workspace.id}:.env.local`;
}

function loadEnvLabel(context) {
  const key = envKey(context.machine, context.workspace);
  const cached = envCache.get(key);
  if (cached !== undefined) return cached;

  const pending = { status: "loading", label: undefined };
  envCache.set(key, pending);
  context.files.readFile(".env.local")
    .then((file) => {
      pending.status = "ready";
      pending.label = file.content.match(/^DEV_URL=(.+)$/m)?.[1];
      context.host.requestRender();
    })
    .catch(() => {
      pending.status = "missing";
      context.host.requestRender();
    });
  return pending;
}

workspaceLabels: [
  {
    id: "dev-url",
    items: (context) => {
      const cached = loadEnvLabel(context);
      return cached.label === undefined ? [] : [{
        type: "link",
        text: cached.label,
        href: cached.label,
        target: "_blank",
      }];
    },
  },
]
```

The file response includes fields such as `path`, `content`, `truncated`, and `binary`. Be careful with sensitive files such as `.env`: browser entries are trusted code, and file contents are exposed to the plugin.

## Listing workspace files

`files.listFiles(path)` lists the entries of a workspace directory. Pass `""` for the workspace root. Like `readFile`, PI WEB binds the call to the callback's machine and workspace, so it works the same for local and federated machines.

```js
const listing = await context.files.listFiles("src");
for (const entry of listing.entries) {
  // entry: { name, path, type: "file" | "directory" | "symlink", size?, modifiedAt? }
}
```

The listing response includes `path`, `entries`, `scannedAt`, and `truncated`. When `truncated` is true, the server cut the listing short, so treat the entries as partial.

`listFiles` rejects when the directory does not exist or cannot be read, matching `readFile` error behavior. When a directory is optional, catch the error and treat it as an empty listing:

```js
async function listSubdirectoryNames(context, path) {
  try {
    const listing = await context.files.listFiles(path);
    return listing.entries.filter((entry) => entry.type === "directory").map((entry) => entry.name);
  } catch {
    return [];
  }
}
```

## Writing, deleting, and moving workspace files

Workspace panels and workspace labels can write, delete, and move files through the documented `files` helper. Like `readFile`, PI WEB binds these helpers to the callback's machine and workspace, so they work the same for local and federated machines.

### Writing files

```js
workspacePanels: [
  {
    id: "workspace.generate",
    title: "Generate",
    render: ({ files }) => html`
      <button @click=${async () => {
        const result = await files.writeFile("output/result.txt", "Generated content\n");
        console.log("Wrote", result.path, result.size, "bytes");
      }}>Generate</button>
    `,
  },
]
```

### Binary writes

Pass a `Uint8Array` for binary content such as images:

```js
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
await files.writeFile("screenshots/thumb.png", png);
```

### Options

`files.writeFile` accepts an optional third argument:

- `createDirs` (default `true`): create intermediate directories, like `mkdir -p`.
- `overwrite` (default `true`): overwrite existing files. Set to `false` to throw if the file already exists.

```js
// Create only — throw if the file already exists
await files.writeFile("config/new-config.json", jsonContent, { overwrite: false });
```

### Deleting files

`files.deleteFile` removes a workspace file. It is idempotent: deleting a file that does not exist returns `{ existed: false }` instead of throwing.

```js
const result = await files.deleteFile("temp/cache.json");
console.log(result.existed ? "File deleted" : "File did not exist");
```

### Moving files

`files.moveFile` renames or moves a file within the workspace, like `mv`. The default is safe: it will not overwrite an existing target file.

```js
// Rename a file
await files.moveFile("old-name.txt", "new-name.txt");

// Move into a subdirectory (creates intermediate dirs by default)
await files.moveFile("file.txt", "archive/file.txt");

// Overwrite an existing target
await files.moveFile("incoming.txt", "current.txt", { overwrite: true });

// Move without creating intermediate directories
await files.moveFile("file.txt", "deep/nested/file.txt", { createDirs: false }); // throws if dirs don't exist
```

`files.moveFile` accepts an optional third argument:

- `createDirs` (default `true`): create intermediate directories for the target path.
- `overwrite` (default `false`): overwrite the target file if it exists. The default is safer than `writeFile` because moving is a more destructive operation.

### Error handling

All file mutations share the same safety layer:

- `overwrite: false` on `writeFile` or existing target on `moveFile` (default) throws if the file already exists.
- Path traversal (e.g., `../../etc/passwd`) is blocked by the workspace safety layer.
- Writing to or moving to a path that is a directory returns an error.
- Deleting a directory returns an error.
- Intermediate directory creation with `createDirs: false` fails if the parent directory does not exist.

After any mutation (`writeFile`, `deleteFile`, or `moveFile`), the File Explorer updates automatically. No explicit `refreshFiles()` call is needed from plugin code. For label and badge updates, call `context.host.requestRender()` if the UI should reflect the change.

### Security

Browser plugin entries are trusted code. File writes go through the same path safety validation as reads — paths are resolved and checked to stay inside the workspace root.

## Running workspace terminal commands

Workspace panels can start terminal commands through the documented `terminal` helper. Commands run in the current workspace on the panel's machine.

```js
render: ({ terminal }) => html`
  <button @click=${() => terminal.runCommand({
    title: "Build",
    command: "npm run build",
    open: true,
    metadata: { "my-plugin.task": "build" },
  })}>Build</button>
`
```

Review command strings carefully. They are trusted shell commands executed in the workspace terminal.

## Private and experimental PI WEB APIs

PI WEB's `/api/...` HTTP and WebSocket routes, runtime-only browser fields, source files, Fastify instance, and internal services are private implementation details. They are outside the supported browser-v2 and server-v1 package contracts and may change or disappear.

The stable browser API is the documented helpers and the type-only `@jmfederico/pi-web/plugin-api` export; the stable server API is the narrow type-only `@jmfederico/pi-web/server-plugin-api` export. Use `context.backend.request()` for paired browser/server work. If browser code intentionally relies on another private surface, keep that dependency local and expect to revisit it after PI WEB upgrades. A server plugin must not import PI WEB source internals or private `dist/**` declarations.

## Async data and caching

PI WEB does not provide a plugin cache/invalidation framework. Keep host callbacks cheap:

- simple contributions should be synchronous and cheap;
- expensive or async work should live inside the plugin;
- custom elements in `type: "render"` label items or panels are a good place to own async loading;
- dedupe async reads/commands and avoid unbounded polling;
- clean up intervals/event listeners in custom elements' `disconnectedCallback()`.

## Agent implementation checklist

If you are an AI agent building or editing a PI WEB plugin, follow this checklist:

1. Create or update a package folder with `package.json` and at least one built JavaScript entry. Declare `"type": "module"` when a `.js` server entry is present, or emit it as `.mjs`.
2. Use `piWeb.plugins` entries shaped as `{ id, browserRoot?, module?, serverModule?, machineSpecific? }`; declare at least one module, give every browser entry a safe root containing its module, and use non-reserved ids matching `^[a-z][a-z0-9.-]*$`.
3. Import browser types only from `@jmfederico/pi-web/plugin-api` and server types only from `@jmfederico/pi-web/server-plugin-api`, always with `import type`; do not use private subpaths or source internals.
4. Default-export `{ apiVersion: 2, name, activate }` from a browser entry and `{ apiVersion: 1, name, activate }` from a server entry.
5. In a browser entry, use source `pluginId` for ownership and `runtimePluginId` for qualified contribution references; return contributions synchronously and use the activation context's `html`/`svg` tags.
6. Add actions for command-palette operations, panels for larger workspace UI, and labels for compact inline metadata.
7. Return arrays synchronously from workspace label `items()`; return an empty array to render nothing.
8. Use documented browser helpers first: `files`, `terminal`, `backend`, `host.requestRender`, `workspace`, `machine`, `state`, and `prompt`. Never construct PI WEB backend, federation, or absolute asset URLs.
9. In a server entry, return only the demonstrated lifecycle callbacks and at most one `workspaceProvider`; treat every supplied `AbortSignal` as operation-scoped and forward it to bounded work.
10. Make provider claims conservative. Return exactly one main workspace, stable keys, absolute accessible directories, JSON data/metadata, and optional request/removal capabilities.
11. Keep backend operations bounded and provider-owned: JSON by default, raw binary only for payloads that must stay out of JSON envelopes (such as secrets — see [Raw binary backend request bodies](#raw-binary-backend-request-bodies)). Put no secrets in `publicMetadata`, browser responses, removal wording, or diagnostics.
12. Keep the installed package at or below 4,096 entries and 16 MiB, and keep every browser-public file inside a narrow `browserRoot`.
13. Treat both entries as trusted code. A server module shares sessiond's process and user permissions.
14. For browser-only edits, reload or hard-reload the page. For a server-backed edit, restart sessiond and then reload the page.
15. Warn that restarting `pi-web-sessiond.service` may interrupt active sessions/runtime ownership.

## Troubleshooting

Check discovery:

```bash
curl http://127.0.0.1:8504/pi-web-plugins/manifest.json
```

Check a plugin module:

```bash
curl http://127.0.0.1:8504/pi-web-plugins/my-plugin/pi-web-plugin.js
```

Common issues:

- invalid plugin or contribution id;
- missing default export, browser `apiVersion: 2` or server `apiVersion: 1`, non-empty `name`, or `activate` function;
- missing `package.json`, incorrect `piWeb.plugins` metadata, neither module declared, missing/unsafe `browserRoot`, a browser module outside its root, a `.js` server entry without `"type": "module"`, or a dual entry explicitly marked `machineSpecific: false`;
- legacy shortcuts such as `piWeb.plugin`, string plugin entries, or no-`package.json` fallback;
- duplicate plugin ids; records are diagnosed, skipped rather than merged, and never renamed;
- entry/root path is unsafe, points outside the package, enters `.git`/`node_modules`, does not exist, or the package exceeds 4,096 entries/16 MiB;
- package is not installed through Pi or under `$PI_WEB_DATA_DIR/plugins` (`~/.pi-web/plugins` by default);
- browser import/activation/render failure; check the browser console;
- server state is failed, incompatible, unhealthy, disabled, missing, stale, or conflicted; check **Settings → PI WEB plugins** and `pi-web logs` on the target machine;
- a server-backed browser entry is absent because sessiond is unavailable or its active source/settings/revisions do not match desired package state; restart sessiond, then reload the tab;
- a federated target lacks the lifecycle/backend capability; update and restart PI WEB on that target instead of falling back to the gateway;
- recovery is needed before plugin discovery/import; use `pi-web plugins safe-start show`, offline disable, or one of the documented safe-start levels.

A manual restart of `pi-web-sessiond.service` may interrupt active sessions/runtime ownership. Inspect active work first and do not assume a web/UI restart is sufficient.
