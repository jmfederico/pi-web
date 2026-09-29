# Plugins and Pi packages

Customize PI WEB with workspace tools, useful shortcuts, and integrations. You can install an existing package or ask an agent to build one for your workflow. You do not need to modify PI WEB itself.

This guide explains what is possible and what to expect. For implementation, use the [public contracts and examples](#agent-development), rather than treating this page as a second API reference.

## What can be built

| Goal | Plugin feature |
| --- | --- |
| Show project health, service links, or environment information | Workspace labels and panels |
| Add a dashboard, file viewer, or project-specific tool | Workspace panels, file helpers, and browser UI |
| Make common actions easier to find | Action-palette commands and shortcuts |
| Run builds, tests, or development servers | Workspace terminal commands |
| Customize the appearance | Themes and light/dark theme pairs |
| Preview diagrams or other text formats in chat and Files | Browser content renderers |
| Read or change workspace files | File listing, reading, writing, moving, deleting, and uploads |
| Show live backend results | Requests or streaming channels between a plugin's browser and server entries |
| Save plugin-owned results or preferences | A persistent server-side plugin directory |
| Start a Pi conversation or collaborate with a Pi extension | Host session capabilities and session-local messaging |
| Replace Git's workspace discovery with another system | A workspace provider |

Panels can support deep links and browser history, and refresh when workspace files change or agent work finishes. File and terminal helpers target the panel's machine and workspace, including remote machines.

For example, ask an agent to build “a panel that runs our checks and shows their results,” “a badge linking to this workspace's preview deployment,” or “a review tool that starts a conversation and saves its findings.”

## Pi packages, extensions, and plugins

These are related, but serve different purposes:

- **Pi packages** are installable bundles. They can contain extensions, skills, prompt templates, themes, and PI WEB plugins.
- **Pi extensions** customize the agent: tools, commands, hooks, model providers, and session behavior.
- **PI WEB plugins** customize the web application and its workspace integrations.

One package can contain all three kinds of customization. Installing a package and enabling its PI WEB plugin are separate decisions. Disabling a PI WEB plugin does not remove the package's Pi extensions, skills, or prompts.

Use a Pi extension for agent behavior and a PI WEB plugin for web UI. When a feature needs both, ship them together and let them communicate through the hosted session connection.

## How plugins work

A plugin package declares a browser entry, a server entry, or both:

- **Browser entries** add actions, panels, labels, themes, and content renderers. They use host helpers for workspace files, terminals, and prompt editing.
- **Server entries** run in the session daemon. They can serve their browser entry, store plugin data, use host capabilities, or provide workspaces.
- **Package peers** connect a plugin's browser and server entries. The host handles the selected machine and workspace; a plugin does not need to own that workspace to serve it.
- **Capabilities** let a plugin declare the host or plugin functionality it requires. Dependencies must be available at the requested version before the plugin starts.

Plugins declare contributions in `activate()`, initialize dependency-backed work in `start()`, and release resources in `dispose()`. Long-lived work follows the plugin's `lifetimeSignal`. Simple browser plugins only need to return their contributions.

### Opening workspace files from chat

Chat Markdown links to relative files (including `./file`) or absolute paths inside the session workspace open in the bundled Files panel. The link retains a download URL for modifier/new-tab clicks and when no panel accepts it. File access still uses server-side workspace containment checks.

A workspace panel can opt in with `fileOpenQuery(context, path)`. This synchronous hook receives its contribution-scoped context and a decoded workspace-relative path; return a navigation query such as `{ file: path }`, or `undefined` to decline. Keep the hook free of side effects: the host opens the first accepting visible, enabled panel for the selected machine, ordered by panel `order` then title, and applies its namespaced query through normal panel navigation. The panel reads the selection from `context.navigation.query`; no Files-plugin dependency is required.

### Panel and tab navigation

The URL's `view` selects a responsive panel: `navigation`, `chat`, or `workspace`. The independent `tool` parameter selects a workspace tab by contribution ID. Opening a workspace tool sets `view=workspace` and `tool` to its ID; switching to chat keeps the selected tool. Contribution IDs are not accepted in `view`. Browser plugins use `selectMainView("workspace")` to show the workspace panel without changing its selected tab, or `selectWorkspaceTool(panelId)` to select and show a particular tool.

Invalid values remain in the URL rather than triggering a redirect. An invalid `view` shows a warning and displays navigation on mobile; on two-column layouts, navigation remains alongside a valid requested tool or, otherwise, chat. Desktop keeps its normal columns. A valid workspace view with an invalid tool shows an unavailable-tab message inside the workspace panel, without selecting another tab or adding a duplicate warning. Omitted parameters use defaults and are not errors.

Action and workspace-panel contexts expose `navigate(destination): Promise<void>` for complete destinations:

```ts
await context.navigate({
  machineId: context.machine.id,
  projectId: context.workspace.projectId,
  workspaceId: context.workspace.id,
  sessionId: sourceSessionId,
  view: "chat",
});
```

All destination fields are optional: `machineId`, `projectId`, `workspaceId`, `sessionId`, `view` (`navigation`, `chat`, or `workspace`), and `tool` (a qualified contribution ID). Omitted `machineId` means the machine selected when called. This is not a route patch: omitted fields use normal host restoration defaults rather than copying the current route's session, tool, or contribution query. Those defaults can select a remembered session. Supply the project/workspace scope when opening a known session; the host does not search for IDs or create missing destinations.

The promise settles after host restoration, or normally when newer navigation supersedes it. Missing or unavailable destinations use the normal host UI and do not also reject the promise. Malformed argument types and invalid `view` values reject with `TypeError` before changing the URL or UI. Captain's Log uses this API for **Open source session** on translations that record a source session.

### Content previews in chat and Files

Browser plugins can contribute `contentRenderers` with an `id`, `languages` (Markdown fence labels), `fileExtensions` (without a dot), and a synchronous `render(input)` returning a Lit template. Selectors are case-insensitive and match by language OR file extension. `renderMode?: 'manual' | 'automatic'` defaults to `manual`: raw source and a **Render** button appear without calling the renderer. This is the initial policy, not a restriction on explicit user intent; unrelated prose updates retain activation. Authors may explicitly opt into `automatic` and are responsible for efficient activation and asynchronous work. The same renderer serves chat fences, Files Markdown preview fences, and standalone text files. Selection follows the effective machine's plugin availability and portable/machine-specific precedence. When several renderers match, a chooser lets you compare alternatives for each diagram or file, with only the selected renderer mounted. Choices default to alphabetical source plugin ID order (not remote runtime prefixes), then local contribution ID, using locale-independent, case-sensitive code-unit comparison. The chooser labels identify the plugin and contribution. Chat remembers explicit renderer and Raw/Preview choices per code block in this browser tab for 15 minutes from the last explicit choice. Viewing or remounting never extends that deadline; expiry applies on revisit, without removing a visible preview. Entries are bounded to the 128 most recently chosen blocks and scoped by machine, session, message/entry, part, block and exact source. Changed source or an unavailable selected renderer invalidates the choice and restores the deterministic default and its policy. Automatic rendering alone creates no remembered override. DOM is not cached; previews render again on remount. Reloading or closing the tab clears this memory. Files Markdown previews do not use chat intent memory. For standalone files, the plugin policy supplies the initial default only when no browser-local Raw/Preview preference exists. Saved Preview authorizes all file rendering, including manual renderers inside Markdown fences; saved Raw suppresses previews. Per-block Raw and renderer choices remain available within Markdown Preview. URL mode still takes precedence. Defaults are not automatically saved as explicit choices. Built-in file previews retain their existing defaults. There is no plugin order field or sorting UI.

Chat keeps **Raw**, **Preview**, and **Copy source** available in a toolbar on each supported diagram block. Standalone Files previews use the file header's **Raw**/**Preview** controls beside **Download** and follow the saved file-view mode; diagrams within Markdown files retain per-block controls. Incomplete fences stay raw and copyable; closed fences preview before the message finishes. Appending prose does not restart an unchanged completed block. Preview failure shows the source instead. Unknown formats retain normal code rendering.

`input` contains `text`, an abort `signal`, and `fail(error)`. Render synchronously, own async work in a component, clean up on disconnect or abort, and report asynchronous failures with `fail`. Obsolete failures are ignored. Renderers receive untrusted text: escape or sanitize output, avoid executing source, and do not relax the surrounding Markdown policy. The host skips plugin rendering for truncated input and blocks over 100,000 UTF-16 code units; Files also retains its inline byte-size limit. Ordinary chat Markdown and Files Markdown retain their distinct sanitizers.

A browser consumer such as Files declares the host capability `{ pluginId: "pi-web", id: "content-rendering", version: 1, parse }` in `requires`, then resolves it in `start`. The exported `ContentRenderingCapability` type describes `listRenderers(request)`, `renderText(request)`, and `renderMarkdown({ machineId, text, truncated?, toSafeHtml, allowManualPreview? })`. `listRenderers` returns sorted eligible `{ id, label, renderMode }` choices without invoking renderers. `renderText` accepts an optional `rendererId` only with `controls: "external"`; absent or unavailable IDs select the first match. Embedded controls own their selection and ignore externally supplied IDs. Use `controls: "external"` when the consumer owns the renderer chooser, mode switching, and raw-source access (as Files does in its header beside Download); otherwise controls remain embedded. Consumers own their user-intent policy and may pass `allowManualPreview: true` to `renderText` or `renderMarkdown` to authorize manual previews (for example, an explicit Render click or Files’ saved or URL Preview preference). For Markdown this applies to eligible fences without overriding per-block Raw choices. Omitting it or passing false retains renderer defaults, including automatic previews. Chat never passes this override. External Raw controls must remove the preview. The public capability stores no remembered intent. Chat’s bounded per-block memory is private host policy, not a plugin option. Markdown requests have their own shape without file-path or language selectors; languages come from fences. Creating a `renderText` template does not invoke a renderer. Markdown diagrams each own an independent chooser. Switching renderers cancels the previous preview and clears its failure state. `renderMarkdown` requires the consumer's trusted sanitizer; it is not permission to insert untrusted HTML. See the [Files consumer](https://github.com/jmfederico/pi-web/blob/main/pi-web-plugins/files/pi-web-plugin.ts) and [Mermaid contribution](https://github.com/jmfederico/pi-web/tree/main/pi-web-plugins/mermaid) for complete implementations.

### Conversations and companion extensions

A server plugin can create a normal, visible Pi conversation, with or without an initial prompt. A companion Pi extension can exchange messages with the backend and use Pi's own APIs to do agent work.

**The conversation belongs to the user once it is published.** Finishing the initial task, closing the browser, or disposing the initiating plugin does not discard it or stop later user work. Users can continue it like any other conversation.

A messaging connection targets a session already hosted on that machine; it does not open saved sessions automatically. Sending a message is not proof that a companion is installed or that its work succeeded. Integrations must report their own progress and results. Connections have no startup-message replay, and closing a connection does not stop agent work.

### Storage and background work

Server plugins receive a persistent `dataDirectory`, separate from installed package code. The directory is shared across that plugin's projects on the machine. Plugins own their data format, migrations, and cleanup; there is no host storage API to learn.

Requests and channels are bounded and can fail, time out, or disconnect. A successful send does not guarantee delivery, and the host does not automatically retry uncertain work. Long-running jobs should maintain their own state and let the UI reconnect without accidentally starting the job twice.

### Workspace providers

A provider decides which workspaces belong to a project. A primary provider can replace bundled Git for projects it claims. Git is the fallback; without a claimant, the project folder remains usable as a workspace.

Conflicting claims produce a visible error. A provider that claims a project and then fails does not silently hand ownership to another provider. Providers can also offer workspace removal, which runs as a visible terminal operation.

Workspace discovery must be available before host session services start. If a package needs both a provider and session-backed features, use two plugin entries in the same package. There is no need to split the distribution into separate packages.

## Install and manage

Use **Settings → Pi packages** to install, update, or remove a package. Enter its npm, git/URL, or local package source. Use **Settings → PI WEB plugins** to enable or disable its web integration and see whether it is active or needs a restart.

| Change | What to do next |
| --- | --- |
| Install or edit a browser-only plugin | Reload the browser page |
| Install, update, configure, enable, or disable a server-backed plugin | Restart the target session daemon, then reload the browser |
| Change ordinary Pi resources such as extensions, skills, or prompts | Run `/reload` in each idle session |
| Change an extension that registers model providers | Follow the separate [provider restart guidance](https://pi-web.dev/config#pi-extension-provider-baseline) |

**Restarting the session daemon may interrupt active sessions and terminals.** Inspect active work first and restart from outside the sessions it hosts. For the native systemd user install:

```sh
systemctl --user restart pi-web-sessiond
```

A browser reload, web/API restart, or Pi's `/reload` does not activate server-plugin changes. Until the daemon restarts, Settings can show different desired and active states. A paired browser entry is withheld when it no longer matches the active server entry, rather than running incompatible code.

Most plugins are enabled by default. Packages can opt out, and Settings can override the default. Plugin settings live in the normal [PI WEB configuration](https://pi-web.dev/config), not inside the package's installed files.

### Local development

An agent can develop a package anywhere and symlink it into the local plugin directory:

```sh
mkdir -p ~/.pi-web/plugins
ln -s /path/to/plugin-folder ~/.pi-web/plugins/my-plugin
```

If `PI_WEB_DATA_DIR` is set, use `$PI_WEB_DATA_DIR/plugins` instead. No PI WEB rebuild is required. The package must contain its built JavaScript; PI WEB does not compile arbitrary installed plugin source.

## Remote machines

Plugin installation and settings target the machine selected in Settings. A remote plugin's server code runs on that remote machine; its browser UI appears through the gateway.

File, terminal, and peer helpers keep operations on the selected machine. Plugins tied to a particular machine use that machine's own installation. Portable browser-only plugins can reuse a gateway copy; themes remain app-wide and remote theme contributions are ignored.

Keep gateways and targets compatible. During this plugin API transition, upgrade them together, restart the updated web/API processes and affected session daemons, then reload the browser. Mixed versions can make remote plugins and Git unavailable; PI WEB does not silently substitute a gateway backend.

## Included tools and optional packages

- **Terminal** supplies terminals and command runs. It is required in normal operation; disable it only through emergency safe start.
- **Files** supplies file browsing, previews, and uploads. Disabling its panel does not remove other plugins' file helpers.
- **Git** discovers Git workspaces and provides status/diff. Disabling it leaves the project-folder workspace available unless another provider takes over.
- **Mermaid** uses the default manual mode: choose **Render** to preview `mermaid` fences and `.mmd`/`.mermaid` text files. Its bundled engine runs locally in an opaque-origin sandbox with network access blocked; no diagram service receives your source. Interactive links and external resources are intentionally unavailable. Disable Mermaid in plugin Settings to keep plain code rendering. Only a browser reload is needed after changing this browser-only plugin.
- **Info** displays PI WEB status and copyable diagnostics.
- **Updates** shows update/restart guidance when relevant and offers a manual update check.
- **Workspace Tasks** turns project commands into runnable buttons.

### Workspace Tasks

Create `.pi-web/tasks.json` in a project:

```json
{
  "version": 1,
  "tasks": [
    { "id": "app.start", "title": "Start app", "command": "npm run dev" },
    { "id": "db.reset", "title": "Reset database", "command": "npm run db:reset", "confirm": true }
  ]
}
```

Open the **Tasks** tab to run a command in a workspace terminal. Tasks can also have a `description`. Review commands before running them, especially in shared repositories. Disabling the plugin hides the tab without changing the project file.

### Relays

The shipped Relay package adds agent prompts and skills for carrying work across sessions, plus a read-only **Relays** tab for inspecting plans and progress under `.pi-web/relays/`. The tab does not start or edit a relay.

PI WEB installs Relay automatically for the active agent profile if it is not configured. Removing it through **Settings → Pi packages** is remembered; it will not be silently reinstalled. Reinstall from **Available packages** if you change your mind. Disabling just the Relays plugin hides its tab but leaves its agent resources available.

### Try Captain's Log

Captain's Log is an optional example that retells a conversation's latest assistant reply as a pirate briefing. It demonstrates a browser panel, backend, and Pi companion working together.

1. On the target machine, install **Captain's Log** from **Settings → Pi packages → Available packages**.
2. Enable it in **Settings → PI WEB plugins**.
3. Restart that machine's session daemon when safe, then reload the browser.
4. Select a conversation, open **Captain's Log**, and choose **Let the Captain tell it**.

The package is prebuilt; no compilation is required. It reads the source reply without modifying that conversation and uses a separate pirate conversation. Model credentials are required, and the source text goes to the pirate's model provider. Previous results are saved. After a daemon restart, open the previous pirate conversation in Sessions if you want to reuse its context.

See the [Captain's Log usage guide](https://github.com/jmfederico/pi-web/blob/main/pi-packages/captains-log/docs/usage.md) for the demo's behavior and troubleshooting.

## Pi extension dialogs

Pi extensions can ask for confirmation, a selection, or text input. PI WEB shows these questions inline in the conversation, including during session startup or while a tool is waiting. They remain answerable after a browser reload, and the first answer wins across tabs.

Dialogs use the extension's timeout and the host's configured [dialog timeout](https://pi-web.dev/config#extension-dialogs). Aborting work or replacing its runtime closes the relevant outstanding questions. Answered cards are browser-local and need not survive a reload. Reloading while a new session is still being created can temporarily lose its question card; the pending question still has its deadline.

These three dialog methods are supported; other Pi extension UI surfaces, such as custom editors and widgets, are not. An extension should not assume every UI feature works just because `hasUI` is true.

## Agent development

Give the agent a goal, the data it should use, and the actions it may take:

```text
Build a PI WEB plugin for this project.
Goal: <describe the workflow and expected UI>.
Read https://pi-web.dev/plugins.md, then follow its public-contract
and example links for the PI WEB version installed here.
Use supported plugin APIs; do not modify PI WEB or call private routes.
Explain installation, any permissions or model use, and how to reload it.
Test the behavior, including failures and cleanup.
```

### Where to implement

Use the smallest example that fits. Source links below track development on `main`; **use the tag or installed declarations matching your PI WEB version** when implementing against a release.

| Need | Start here |
| --- | --- |
| Browser contributions and helpers | [`plugin-api.ts`](https://github.com/jmfederico/pi-web/blob/main/src/plugin-api.ts), published as `@jmfederico/pi-web/plugin-api` |
| Server lifecycle, peers, providers, and host capabilities | [`server-plugin-api.ts`](https://github.com/jmfederico/pi-web/blob/main/src/server-plugin-api.ts), published as `@jmfederico/pi-web/server-plugin-api` |
| A small browser plugin | [Info](https://github.com/jmfederico/pi-web/tree/main/pi-web-plugins/info) |
| A standalone browser/server package | [Workspace-provider example](https://github.com/jmfederico/pi-web/tree/main/examples/workspace-provider-plugin) |
| A production workspace provider and paired UI | [Git](https://github.com/jmfederico/pi-web/tree/main/pi-web-plugins/git) |
| Hosted sessions, live updates, and a Pi companion | [Captain's Log](https://github.com/jmfederico/pi-web/tree/main/pi-packages/captains-log) |
| A simpler initial-prompt workflow | [Workspace Reviews example](https://github.com/jmfederico/pi-web/tree/main/examples/session-bridge-plugin) |
| Package discovery rules and diagnostics | [Plugin catalog](https://github.com/jmfederico/pi-web/blob/main/src/server/piWebPluginCatalog.ts) |

The current browser contract is **API v4** and the server contract is **API v3**. Older entries need migration; there is no compatibility shim. The public source contracts and their tests are the reference for signatures, validation, limits, and lifecycle details.

A few design boundaries matter before implementation:

- Declare entries in `package.json` under `piWeb.plugins`; copy packaging from a standalone example. A package can contain multiple entries.
- Use only the public package entrypoints. Internal routes, services, and `dist/**` imports are not supported APIs.
- Keep browser assets in a narrow `browserRoot`: everything inside it is browser-public. Include the built dependencies and assets it needs, and keep secrets outside it. The installed plugin package is limited to 4,096 entries and 16 MiB, excluding `.git` and `node_modules`.
- Use host helpers for machine/workspace operations and module-relative URLs for plugin assets. Avoid hard-coded application paths.
- Rendering can happen repeatedly without a panel being mounted again. Own asynchronous state and use ordinary component lifecycle cleanup for connections, timers, and listeners.
- Keep workspace discovery separate from session-backed features, and keep agent behavior in a Pi companion rather than importing host internals.

## Trust and recovery

**Install only trusted plugins.** Browser entries run in your page. Server entries run inside the session daemon with its filesystem, environment, and process permissions. They are not sandboxed; blocking or faulty server code can affect every session on that daemon. Timeouts help with cooperative work but cannot stop blocking code.

If a plugin is missing or fails, first check **Settings → PI WEB plugins** on the affected machine. Confirm it is installed, enabled, compatible, and active. Check the browser console for browser failures and `pi-web logs` on the target for server failures. A restart-required or stale state usually needs a session-daemon restart followed by a browser reload.

When the UI cannot recover, run these commands on the affected machine:

```sh
pi-web plugins disable <plugin-id> --restart
pi-web plugins safe-start show
pi-web plugins safe-start set bundled-only --restart
pi-web plugins safe-start set none --restart
pi-web plugins safe-start clear --restart
```

- **Disable** keeps a named optional plugin from loading on the next daemon start.
- **Bundled-only** excludes external server plugins while retaining bundled tools.
- **None** imports no server plugins. Diagnosis and project-folder workspaces remain available, but Terminal and terminal-backed workflows do not.
- **Clear** restores ordinary startup after you repair or remove the problem package.

Safe start remains set until cleared. `--restart` restarts only when PI WEB recognizes a safe installed-service action; otherwise it prints manual instructions. These commands edit configuration without loading plugin code. Use `--config /path/to/config.json` for a non-default configuration, and inspect active work before any restart.
