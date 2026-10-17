# Plugins and Pi packages

Customize PI WEB with workspace tools, useful shortcuts, and integrations. You can install an existing package or ask an agent to build one for your workflow. You do not need to modify PI WEB itself.

This guide explains what is possible and what to expect. For implementation, use the [public contracts and examples](#agent-development), rather than treating this page as a second API reference.

## What can be built

| Goal | Plugin feature |
| --- | --- |
| Show project health, service links, or environment information | Workspace labels and panels |
| Identify a conversation's workflow and link to its saved context | Session-list labels and public session metadata |
| Add a dashboard, file viewer, or project-specific tool | Workspace panels, file helpers, and browser UI |
| Make common actions easier to find | Action-palette commands and shortcuts |
| Act on a chat message | Message-action callbacks |
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

- **Browser entries** add palette and message actions, panels, labels, themes, and content renderers. They use host helpers for workspace files, terminals, and prompt editing.
- **Server entries** run in the session daemon. They can serve their browser entry, store plugin data, use host capabilities, or provide workspaces.
- **Package peers** connect a plugin's browser and server entries. The host handles the selected machine and workspace; a plugin does not need to own that workspace to serve it.
- **Capabilities** let a plugin declare the host or plugin functionality it requires. Dependencies must be available at the requested version before the plugin starts.

For entry declarations and lifecycle details, use the [public contracts and examples](#agent-development).

### Tabs without a workspace

Application panels can show machine dashboards before a project, workspace, or session is selected. Workspace panels require a selected workspace. Both appear in the tool tabs and follow selection changes; terminal-backed actions also require an available Terminal provider.

Older hosts may omit application tabs; update PI WEB to use them.

### Follow selection while a tab is closed

Plugins can follow the selected machine, project, workspace, and session even while their tab is closed. This provides basic selection information, not the transcript or private session-file path. Older hosts may lack selection observation; update PI WEB when a plugin needs it.

### Read public session metadata

Plugins can publish namespaced session metadata to identify workflows and link to saved context. It is browser-public data saved with the conversation, available after reopening without a live Pi connection. Missing metadata is not inferred from titles or conversation text.

Only deliberately published session metadata is exposed, not arbitrary Pi custom entries. Keep secrets and private extension state out of it. Namespaces organize data rather than enforce ownership or authorization, and plugins must validate their own schema and render values as untrusted input. Browser API v4 remains unchanged; older hosts omit the field.

### Dispatch a session from a Pi extension

Trusted hosted Pi extensions can start an independent conversation in a workspace of the same registered project, with a prompt, name, and public metadata. Model and thinking settings inherit from the initiating conversation unless explicitly overridden. Dispatch respects the same delegation restrictions as `spawn_session`.

Older hosts may lack this capability. After upgrading, restart the session daemon when safe to load it; restarting interrupts active sessions and terminals.

### Add indicators to session-list rows

Plugins can add text, links, or custom indicators to conversations, including unselected and archived rows. Indicators can use public session metadata to open saved workflow context on the row's machine and workspace without a live Pi connection.

They appear only in the session list, not the top Session pill or transcript bubbles. Older hosts ignore session labels; update PI WEB to use them.

### Discover projects on the context's machine

Plugins can list registered projects and suggest directories using the same search as **Add Project**, even before a project is selected. Discovery is read-only and stays on the initiating machine; remote failures do not substitute gateway projects. Older hosts may lack project discovery; update PI WEB when a plugin needs it.

### Attach text context to a message

Plugins can stage labeled, removable text chips in a ready, non-archived conversation's composer. Chips stay with that conversation when you switch tabs or selections. **Send** appends their text verbatim to your message; chips can also be sent alone. Messages with chips are ordinary prompts, even if typed text starts with `/` or `!`.

Chips clear when the server accepts the prompt, not when the agent finishes. Failed sends retain them for retry. Staging is browser-memory-only and clears on reload unless the plugin restores its own saved data. Older hosts may lack chip support; update PI WEB to use it.

### Opening workspace files from chat

Chat Markdown links to relative files (including `./file`) or absolute paths inside the session workspace open in the bundled Files panel. The link retains a download URL for modifier/new-tab clicks and when no panel accepts it. File access still uses server-side workspace containment checks.

Other workspace panels can handle these links too, letting a plugin open a file in its own viewer.

### Panel and tab navigation

**Panel ID migration.** `routeAliases` and `navigationAliases` have been removed from application and workspace panel contributions. Remove these options from plugins; declarations that still supply them fail registration. Update saved links to the current qualified contribution ID and its query namespace. Short tool names such as `files` and historical IDs such as `core:workspace.files` or `core:workspace.terminal` no longer select the bundled panels; use `pi-web.files:workspace.files` and `pi-web.terminal:workspace.terminal`. Remote plugins still use the host's source-to-runtime ID mapping; this is not an author-configurable alias mechanism. Action `shortcutAliases` are unchanged.

Links use `view` for `navigation`, `chat`, or `workspace`, and `tool` for a qualified application or workspace tab ID. Contribution IDs do not belong in `view`. Invalid destinations show a warning or unavailable-tab message rather than silently selecting another tool.

Plugin navigation can open a complete destination or patch the current URL, select a saved item within a tab, and push or replace browser history. Complete destinations use host restoration defaults for omitted fields; patches preserve omitted URL fields. When opening a known session elsewhere, supply its machine, project, and workspace explicitly.

**Session IDs.** Browser URLs, plugin navigation, and PI WEB session APIs use exact, case-sensitive IDs. Pass the full `session.id` returned by the session catalog or creation response. Abbreviated IDs produce a missing-session destination instead of matching or expanding a prefix; update old shortened links and integrations to use full IDs. Short IDs shown in labels are display-only.

Older hosts ignore the options argument and still treat the destination as a complete replacement; upgrade PI WEB before relying on patch behavior or history replacement. Hosts without destination-query support also ignore `query`; upgrade before relying on exact item selection.

### Message actions

Plugins can add buttons beside transcript messages, for example to quote text into the next prompt or start a review. Actions can target a saved entry or displayed text, including a streaming message. They receive the clicked message's ordinary text, not thinking, image data, tool payloads, or a whole-transcript subscription.

**Plugin actions do not automatically ask for confirmation.** Plugins must provide any needed safeguards. Built-in **Fork** and **Go back** retain their confirmations. On a non-user message, they retain its checkpoint and intervening history before the next checkpoint; on a user message, they act before that entry and restore its text to the editor. Neither action reruns commands or reverses filesystem changes.

Older hosts may ignore message actions or lack newer display-action features; update PI WEB before relying on them.

### Content previews in chat and Files

Plugins can preview diagrams and other text formats in chat code blocks, Markdown files, and standalone Files previews. Manual rendering is the default: choose **Render** to view a preview. Plugins may opt into automatic rendering. If several renderers match, use the chooser to compare them.

**Raw** shows source; **Copy** copies source even while a preview is visible. Files uses **Raw**/**Preview** beside **Download** and remembers your file-view preference; Preview also permits manual renderers in Markdown files. Chat choices are temporary and clear on reload.

Incomplete, truncated, or oversized input is not rendered. Files also limits the size of inline previews. Failed previews fall back to source. Renderers must treat text as untrusted, sanitize output, and avoid executing source. For implementation, see the [Files consumer](https://github.com/jmfederico/pi-web/blob/main/pi-web-plugins/files/pi-web-plugin.ts) and [Mermaid contribution](https://github.com/jmfederico/pi-web/tree/main/pi-web-plugins/mermaid).

### Conversations and companion extensions

A server plugin can create a normal, visible Pi conversation, with or without an initial prompt. A companion Pi extension can exchange messages with the backend and use Pi's own APIs to do agent work.

**The conversation belongs to the user once it is published.** Finishing the initial task, closing the browser, or disposing the initiating plugin does not discard it or stop later user work. Users can continue it like any other conversation.

A messaging connection targets a session already hosted on that machine; it does not open saved sessions automatically. Sending a message is not proof that a companion is installed or that its work succeeded. Integrations must report their own progress and results. Connections have no startup-message replay, and closing a connection does not stop agent work.

### Companion tools calling a v5 backend

Companion Pi extensions can call the same v5 `peer` handlers as a plugin's browser entry. Import `createCompanionBackend` from `@jmfederico/pi-web/server-plugin-api`; no additional server handler, HTTP listener, or browser panel is needed.

```ts
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createCompanionBackend } from "@jmfederico/pi-web/server-plugin-api";

export default function (pi: ExtensionAPI) {
  pi.registerTool(defineTool({
    name: "save_bookmark",
    label: "Save bookmark",
    description: "Save a bookmark through the bookmarks plugin",
    parameters: Type.Object({ url: Type.String(), title: Type.String() }),
    async execute(_id, input, signal) {
      const backend = createCompanionBackend(pi.events, "bookmarks");
      const machine = backend.forScope({ kind: "machine" });
      if (machine.request === undefined) throw new Error("Bookmarks backend does not support requests");
      const result = await machine.request("save", input, signal === undefined ? {} : { signal });
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  }));
}
```

Use the package manifest's stable PI WEB plugin ID and obtain the backend during tool execution or `session_start`, not while the extension factory loads. The helper returns the existing v5 backend interface, with `machineId: "local"` meaning the hosted session's machine, regardless of browser selection. `forScope` accepts machine scope, `{ kind: "project", projectId }`, or `{ kind: "workspace", projectId, workspaceId }`; the host resolves IDs rather than trusting extension-supplied paths. Available request/channel methods follow the active v5 peer's capabilities. Normal JSON bounds, deadlines, cancellation, and revision checks apply; this helper does not add remote transport or retry failed operations.

The matching v5 server entry must be enabled and healthy enough to serve requests. Discovery before daemon backend initialization finishes rejects explicitly. Retained facades stay bound to that backend revision and concrete hosted session; closing or replacing it revokes access and cancels pending work. Native extension reload needs no host reconnect; extensions should still close their own channels during `session_shutdown`.

Outside a supporting PI WEB host, discovery throws rather than falling back to HTTP. Plugin authors decide whether to offer CLI behavior, handle that error, or expose the tool only in PI WEB. Extensions are trusted in-process code; the helper is not a new permission boundary. Update PI WEB and manually restart its session daemon before using the helper in existing deployments.

### Storage and background work

Server plugins receive a persistent `dataDirectory`, separate from installed package code. The directory is shared across that plugin's projects on the machine. Plugins own their data format, migrations, and cleanup; there is no host storage API to learn.

Requests and channels are bounded and can fail, time out, or disconnect. A successful send does not guarantee delivery, and the host does not automatically retry uncertain work. Long-running jobs should maintain their own state and let the UI reconnect without accidentally starting the job twice.

### Workspace providers

A provider decides which workspaces belong to a project. A primary provider can replace bundled Git for projects it claims. Git is the fallback; without a claimant, the project folder remains usable as a workspace.

Conflicting claims produce a visible error. A provider that claims a project and then fails does not silently hand ownership to another provider. Providers can also offer workspace removal, which runs as a visible terminal operation.

External integrations can send a project-scoped discovery hint through the core CLI on the project's machine:

```sh
pi-web workspaces notify --project ID --plugin git
```

`ID` is the registered project ID, not a filesystem path. `--plugin` identifies the provider (`git` here), which must own the project and accept notifications. Connected browsers re-read the workspace list; the command does not register projects or workspaces.

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

Most plugins are enabled by default. Packages can opt out, and Settings can override the default. Plugin settings live in the normal [PI WEB configuration](https://pi-web.dev/config), not inside the package's installed files. Enablement stays global; server plugins supporting project settings, including Git, can use `plugins.<id>.settings` overrides in the registered project's `.pi-web/config.json`. See [Project plugin settings](https://pi-web.dev/config#project-plugin-settings) for override and restart rules.

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
- **Git** discovers Git workspaces and provides status/diff, including [automatic discovery of new worktrees](#automatic-git-worktree-discovery) on supported Git builds. Disabling it leaves the project-folder workspace available unless another provider takes over.
- **Mermaid** uses the default manual mode: choose **Render** to preview `mermaid` fences and `.mmd`/`.mermaid` text files. Its bundled engine runs locally in an opaque-origin sandbox with network access blocked; no diagram service receives your source. Interactive links and external resources are intentionally unavailable. Disable Mermaid in plugin Settings to keep plain code rendering. Only a browser reload is needed after changing this browser-only plugin.
<<<<<<< HEAD
- **Code highlighting** colours completed chat code fences in common languages automatically, including JavaScript/TypeScript, Python, shell, HTML/CSS, JSON, Go, Rust, SQL, and diff. Choose **Raw** to view plain source or **Preview** to restore colours; Copy always copies the source. Unsupported, unlabelled, incomplete, and oversized blocks stay plain. Highlighting runs locally without executing code. Disable Code highlighting in plugin Settings to keep plain code rendering; reload the browser after changing this browser-only plugin.
- **Info** displays machine and PI WEB status without requiring a workspace, adds workspace details when selected, and provides copyable diagnostics.
- **Code highlighting** colours completed chat code fences in common languages automatically, including JavaScript/TypeScript, Python, shell, HTML/CSS, JSON, Go, Rust, SQL, and diff. Choose **Raw** to view plain source or **Preview** to restore colours; Copy always copies the source. Unsupported, unlabelled, incomplete, and oversized blocks stay plain. Highlighting runs locally without executing code. Disable Code highlighting in plugin Settings to keep plain code rendering; reload the browser after changing this browser-only plugin.
- **Info** displays machine and PI WEB status without requiring a workspace, adds workspace details when selected, and provides copyable diagnostics. It reports the JavaScript runtime and engine version for both the Web/UI process and the session daemon, so a machine running one service on Bun and the other on Node.js is visible at a glance. **Copy PI WEB Diagnostics** writes an anonymous-ready block for bug reports: it adds the browser and its version, and replaces your home directory with `~` and your username elsewhere with `<user>` so a pasted report does not disclose your system account. The panel itself still shows real paths.
- **Updates** shows update/restart guidance when relevant and offers a manual update check. Guidance and Copy work without a workspace; Run requires a selected workspace with an available Terminal provider on that machine.
- **Workspace Tasks** turns project commands into runnable buttons.

### Automatic Git worktree discovery

New worktrees can appear without a browser reload or loss of the current conversation or draft. On Git builds supporting native config-based named hooks (introduced in Git 2.54), the bundled Git provider registers a local `post-checkout` hook. Existing hook scripts and `core.hooksPath` are preserved, and notification failures do not fail Git operations.

Running dev and production on the same repositories? Docker dev handles this automatically. For other setups, see [running multiple instances](https://pi-web.dev/config#git-instance-namespace).

`workspaceDiscoveryHooks` defaults to `true`. See [Git hook opt-out configuration](https://pi-web.dev/config#git-worktree-discovery-hooks) to disable it globally or per project. Setting changes require a manual session-daemon restart, which can interrupt active sessions and terminals; a browser reload is insufficient.

Unsupported Git builds are left untouched, and `git worktree add --no-checkout` skips the notification. When hooks are skipped, disabled, or unavailable, discovery catches up on browser focus, navigation, manual refresh, or reconnect.

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

### Workflows

Workflows is a shipped Pi package for PI WEB's opinionated prompts and shortcuts. It currently provides `/worktree` with the free-form hint **Purpose and/or base branch**, plus a **Create Worktree** palette action. The action prepares `/worktree` in an empty Chat prompt for an active conversation; add your description and send it when ready.

```text
/worktree fix login redirects
/worktree add search based on origin/main
```

The prompt asks the agent to create a worktree named for your purpose, using the requested base or the current worktree's HEAD. If you give no purpose or description, the agent asks for one.

PI WEB installs Workflows automatically for the active agent profile at session-daemon startup. Its web plugin is enabled by default. Disable **Workflows** in **Settings → PI WEB plugins**, then reload the browser, to hide the shortcut while keeping `/worktree`. To remove its prompts as well, remove the package in **Settings → Pi packages** and run `/reload` in each idle conversation. Removal is remembered across daemon restarts; reinstall from **Available packages** if you change your mind, then reload idle conversations and the browser.

### Relays

The shipped Relay package adds `/relay` for the current checkout and `/relay-worktree` for a fresh worktree. It clarifies a goal and boundaries with you, then starts only after explicit approval. Fresh sessions record progress and hand off until the goal is reached or human help is needed. Project instructions and skills govern the work, and completion requires a fresh-context review.

The read-only **Relays** tab lists saved packets under `.pi-web/relays/` and shows their goal, current baton, history, and any recorded decisions. It does not start or edit a relay. A session-list indicator opens the associated packet on that conversation's machine and workspace, including custom packet locations inside the workspace. Older sessions without public Relay metadata have no indicator.

PI WEB installs Relay automatically for the active agent profile if it is not configured. Removing it through **Settings → Pi packages** is remembered; it will not be silently reinstalled. Reinstall from **Available packages** if you change your mind. Disabling just the Relays plugin hides its tab and row indicators but leaves its agent resources available.

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

Dialogs use the extension's timeout and the host's configured [dialog timeout](https://pi-web.dev/config#extension-dialogs). Aborting work, replacing a runtime, or reloading extensions closes the relevant outstanding questions. Answered cards are browser-local and need not survive a reload. If you reload during startup, find the live conversation in Sessions and open it to answer its pending questions.

These three dialog methods are supported; other Pi extension UI surfaces, such as custom editors and widgets, are not. An extension should not assume every UI feature works just because `hasUI` is true.

### Extension tree commands

Pi extension commands can rewind with `ctx.navigateTree()` and fork with `ctx.fork()`, including follow-up work using the fresh `withSession` context. These operations run independently of browser connections. Rewinds refresh the viewed conversation; forks appear in Sessions for you to open. Other viewers keep their own selection and unsent drafts.

Prepared text appears as suggested input. Choose **Use suggested input** to replace this browser's current draft; it is never applied automatically. The latest suggestion survives browser reloads while the daemon hosts the conversation. A later tree action, submitted user message, runtime close, or daemon restart can clear it. Explicit web rewind/fork buttons keep their response-driven navigation and editor behavior.

Extension idle/reload actions are supported. `ctx.newSession()` and `ctx.switchSession()` report that they are unsupported; use the web UI for those actions. Other terminal editor and widget APIs remain unsupported.

### Pi Markdown transformers

PI WEB applies a session's `pi.registerMarkdownTransformer()` chain to completed and historical user text, assistant text, and assistant thinking. Transformations run in the session daemon before browser Markdown sanitization and code-fence previews; file previews are unaffected. Original session content and **Copy message** stay unchanged. Code-fence Raw/copy controls use the transformed fence source.

Live partial responses remain untransformed until completion, including after reconnect. Transformers receive `isStreaming: false` and a fixed `availableWidth: 80` (a compatibility approximation, not browser geometry). Empty transformed parts are hidden, but their message row remains. Failed transformers are logged and skipped; later transformers receive the last successful result. Keep transformers synchronous and cheap, since history reads also invoke them.

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

The current browser and server contracts are both **API v5**. Browser v4 and server v3 remain supported with a once-per-plugin deprecation diagnostic; no removal date is set. Other versions are unsupported. The public source contracts and their tests are the reference for signatures, validation, limits, and lifecycle details.

### Host-provided UI styles

Browser plugins can reuse PI WEB's button, toolbar, tab, and file/tree-row styles without bundling a stylesheet or a UI framework. Request the host capability `{ pluginId: "pi-web", id: "ui-styles", version: 1 }` in `requires`, then resolve it in `start`. The value is `UiStylesCapabilityV1`, containing a read-only `cssText` string.

```ts
import type { PiWebPlugin, PluginCapability, UiStylesCapabilityV1 } from "@jmfederico/pi-web/plugin-api";

const uiStylesV1: PluginCapability<UiStylesCapabilityV1> = {
  pluginId: "pi-web", id: "ui-styles", version: 1,
  parse(value) {
    if (typeof value !== "object" || value === null || !("cssText" in value)
        || typeof value.cssText !== "string") throw new Error("UI styles v1 unavailable");
    return { cssText: value.cssText };
  },
};

export default {
  apiVersion: 5,
  name: "Example panel",
  requires: [uiStylesV1],
  activate({ html }) {
    let uiCssText = "";
    return {
      start({ capabilities }) {
        uiCssText = capabilities.resolve(uiStylesV1).cssText;
      },
      contributions: {
        workspacePanels: [{
          id: "example", title: "Example",
          render: () => html`<my-panel .uiCssText=${uiCssText}></my-panel>`,
        }],
      },
    };
  },
} satisfies PiWebPlugin;
```

Your panel applies the string inside its own shadow root:

```ts
const style = document.createElement("style");
style.textContent = uiCssText;
shadowRoot.prepend(style);
```

Set `textContent` (or use an escaped text binding in a template library), rather than building HTML strings containing CSS. Reuse or update that style element when the property changes; do not recreate the panel's content just to apply styles. No runtime package import is needed; the public import above supplies build-time types only. The shipped [Relay panel](https://github.com/jmfederico/pi-web/tree/main/pi-packages/relays) is a plain-DOM example.

Version 1 supports these native HTML patterns:

| Pattern | Classes and states |
| --- | --- |
| Button | `button.ui-button`; optional `ui-button--compact`, `ui-button--icon`, `ui-button--primary`, or `danger`; native `disabled` |
| Select | `select.ui-select`; preserve its native label and change handling |
| Toolbar | `.ui-toolbar`, optionally `ui-toolbar--primary`; group controls with `.ui-toolbar-group` and label areas with `.ui-toolbar-title` |
| Trailing group boundary | Add `ui-toolbar-group--bounded` when a group meets empty bar space, not the bar's edge |
| Tabs | `.ui-tabs` containing `button.ui-button.ui-tab`; optionally `ui-tabs--primary` for main navigation; nested groups can use `.ui-toolbar-group` |
| Active tab | `.selected`, `aria-current="page"`, or `aria-pressed="true"` on the tab button |

Toolbars and tabs use compact 32px desktop controls by default. Primary variants use 44px controls; coarse-pointer targets grow to at least 44px. Icon-only buttons need an accessible name. Keep grouped controls gapless and let the shared styles provide separators and hover/focus states. Use existing `--pi-*` colour tokens in plugin-specific content styles so theme changes continue to propagate through shadow roots.

Version 1 also provides compact file/tree lists:

```html
<div class="ui-file-list">
  <button type="button" class="ui-button ui-file-row selected" style="--depth: 1" aria-current="page" title="src/main.ts">
    <span class="ui-file-leading" aria-hidden="true"><!-- file icon or disclosure chevron --></span>
    <span class="ui-file-label">main.ts</span>
    <span class="ui-file-meta">M</span>
  </button>
</div>
```

File rows are gapless and **32px high for every pointer type**, intentionally remaining compact on touch devices too. The leading slot is 16px wide; integer `--depth` adds 16px indentation per level. `.ui-file-label` truncates long names; provide the full path through `title`. `.ui-file-meta` is optional trailing metadata. Use `.selected` or `aria-current="page"` for the active file, and `aria-expanded` on folder buttons. The Files and Git plugins use this pattern without sharing their controllers or viewer layout.

These are appearance patterns: the plugin still owns events, selection, keyboard navigation, and ARIA semantics. Styling a row as tabs does not implement an ARIA tab widget. Do not deep-import client source files or depend on undocumented selectors, even if they appear in the stylesheet. Menu, form, and dialog styles are not part of the public UI style contract.

The capability works with supported browser APIs v4 and v5. A host without the requested `ui-styles` version rejects the plugin, rather than silently rendering an unstyled fallback. Compatible visual improvements arrive with the running PI WEB frontend after reload; the plugin does not need rebuilding. Breaking class, markup, or state changes require a new capability version. This does not add custom theme CSS loading.

### Read-only catalogs and scoped backends (v5)

Browser v5 action, panel, label, and invoked message-action contexts include `catalog`. It lists and resolves registered projects, their workspaces, and saved sessions without requiring a plugin backend. Each catalog captures `machineId`; changing selection creates a new callback context, never retargets an existing catalog. Activation still provides plugin identity, template helpers, selection observation, and lifecycle signals—not a selection-bound catalog.

```ts
export default {
  apiVersion: 5,
  name: "Project dashboard",
  activate({ html }) {
    return {
      contributions: {
        applicationPanels: [{
          id: "dashboard",
          title: "Projects",
          render(context) {
            return html`<my-dashboard .catalog=${context.catalog}
              .backend=${context.backend}></my-dashboard>`;
          },
        }],
      },
    };
  },
};
```

Components and event handlers can call `catalog.projects.list()` / `get(projectId)`, `catalog.workspaces.list(projectId)` / `get({ projectId, workspaceId })`, and `catalog.sessions.list({ projectId, workspaceId })` / `get({ projectId, workspaceId, sessionId })`. Reads accept an optional abort signal. Session snapshots include public metadata and `runtime` (`not-hosted`, `idle`, or `busy`); discovery does not open a saved session or expose its transcript/private file path.

Paired plugins also receive `backend` in these browser contexts. `backend.forScope({ kind: "machine" })`, `{ kind: "project", projectId }`, or `{ kind: "workspace", projectId, workspaceId }` returns the package's paired request/channel interface on that context's machine. Portable browser-only plugins have no paired backend. Existing workspace `peer` helpers remain available.

Server v5 peer callbacks receive `scope` instead of always requiring `project` and `workspace`. Machine scope carries no project; project scope contains host-resolved `project`; workspace scope contains host-resolved `project` and `workspace`. Browser/server package revisions, cancellation, and host authority checks still apply. Server v3 retains its workspace-only callback shape and cannot accept machine/project-scoped calls.

Backend plugins declare `PI_WEB_HOST_CATALOG_CAPABILITY` in `requires`, then resolve it in `start({ capabilities })`. This provides the same read-only discovery locally to that daemon. Workspace providers must not depend on the catalog: it becomes available only after provider topology settles. No project, workspace, or session mutation methods are added.

Machine-specific contributions are visible only on their owning machine; portable browser contributions follow selection. Switching machines does not stop backend work. Plugins must discard obsolete asynchronous UI results and clean up component-owned connections when their context changes.

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
