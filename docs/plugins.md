# PI WEB plugin implementation reference

This is the documentation entry point for agents and developers building PI WEB plugins. For a short overview of possibilities and installation, use the [plugin guide](https://pi-web.dev/plugins).

## Start here

1. Read [public contracts and examples](#where-to-implement). Use declarations matching the installed PI WEB version; source links track development on `main`.
2. Choose the smallest example that fits the requested workflow. Use supported plugin APIs rather than modifying PI WEB or calling private routes.
3. Follow the relevant sections below for behavior, compatibility, and lifecycle requirements.
4. Test the requested behavior, failure paths, and cleanup. Explain installation, reload/restart steps, and any permissions or model use.

### Find the relevant guidance

- [Capabilities and possible contributions](#what-can-be-built)
- [Browser/server roles and feature behavior](#how-plugins-work)
- [Installation and local development](#install-and-manage)
- [Remote machines](#remote-machines)
- [Contracts, examples, and design boundaries](#agent-development)
- [Shared UI styles](#host-provided-ui-styles), [CSS integration](#css-files-and-shadow-roots), and [themes](#css-first-themes)
- [Read-only catalogs and scoped backends](#read-only-catalogs-and-scoped-backends-v5)
- [Binary resources and media delivery](#binary-resources-and-media-delivery)
- [Trust and recovery](#trust-and-recovery)

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
| Add file-type previews to Files, including binary files | Browser v5 file previewers |
| Highlight additional programming languages in Files and chat | Syntax highlighters |
| Read or change workspace files | File listing, reading, writing, moving, deleting, and uploads |
| Show live backend results | Requests or streaming channels between a plugin's browser and server entries |
| Deliver generated documents, media, or binary data | Scoped backend resources with browser-ready URLs |
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

Application-panel command helpers keep their execution scope explicit. `context.terminal` targets the selected workspace and returns workspace run records. `context.maintenanceTerminal` targets the machine's maintenance directory and returns maintenance run records, without workspace identity. Use the latter only for an explicit application action, such as Update; viewing Terminal does not create a maintenance shell.

Older hosts may omit application tabs or maintenance commands; update PI WEB to use them.

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

Plugins can render source as highlighted code, diagrams, or other presentations in chat code blocks, Markdown files, and standalone Files previews. Manual rendering is the default for contributions; plugins may opt into automatic rendering. Every matching renderer has a named header button alongside **Raw**. Clicking a view button selects and activates it, including manual renderers. The buttons stay on one horizontally scrollable row when space is limited.

The last matching automatic renderer in plugin discovery order is the default. Bundled plugins are discovered before installed/project plugins; asynchronous import completion does not change precedence. Later manual renderers do not take over. An explicit renderer choice or **Raw** takes precedence over automatic defaults. **Raw** is always available as unhighlighted source, including when rendering fails.

**Raw** shows source; **Copy** copies source even while a rendered view is visible. Files puts the view buttons beside **Download** and remembers your Raw/rendered preference; rendered Markdown also permits manual renderers in its code blocks. Chat choices are temporary and clear on reload.

Incomplete, truncated, or oversized input is not rendered. Files also limits the size of inline previews. Failed previews fall back to source. Renderers must treat text as untrusted, sanitize output, and avoid executing source. For implementation, see the [Files consumer](https://github.com/jmfederico/pi-web/blob/main/pi-web-plugins/files/pi-web-plugin.ts) and [Mermaid contribution](https://github.com/jmfederico/pi-web/tree/main/pi-web-plugins/mermaid).

### Contribute file previewers

Browser v5 plugins can contribute `filePreviewers` to the existing Files panel. Use these for file-specific views, including binary formats; use `contentRenderers` for text presentations shared with chat code blocks. A previewer does not need its own file browser or companion backend.

Each previewer declares an `id`, a human-readable `title`, and `fileExtensions` (without leading dots), `mimeTypes` (exact types or `audio/*`-style wildcards), or a synchronous `supports(request)` callback. Extension and MIME selectors are alternatives; `supports`, when supplied, further restricts them. With only `supports`, it decides eligibility. Matching is case-insensitive. Unknown formats may have no MIME metadata, so extension matching is useful.

```ts
export default {
  apiVersion: 5,
  name: "Custom file views",
  activate({ html }) {
    return {
      contributions: {
        filePreviewers: [{
          id: "model",
          title: "3D model",
          fileExtensions: ["mesh"],
          supports: ({ file }) => file.size <= 20 * 1024 * 1024,
          // Manual by default: no rendering or file fetch until selected.
          render({ file, files, signal, fail }) {
            return html`<my-model-viewer .path=${file.path}
              .files=${files} .signal=${signal} .fail=${fail}></my-model-viewer>`;
          },
        }],
      },
    };
  },
};
```

The plugin owns `my-model-viewer` in this example. Its component can fetch existing workspace bytes using the supplied file helpers:

```ts
if (files.capabilityVersion !== 1) throw new Error("Workspace download URLs are unavailable");
const response = await fetch(files.downloadUrl(path), { signal });
if (!response.ok) throw new Error(`File load failed: HTTP ${response.status}`);
const bytes = await response.arrayBuffer();
```

This uses the same authenticated file-serving path as downloads, including remote machines. `Content-Disposition: attachment` does not trigger a download when using `fetch()`. For browser media, construct a `Blob` with the appropriate MIME type and revoke its object URL during cleanup. Fetching into a blob loads the whole file; apply a suitable size limit. A companion backend is optional for processing, generated resources, or plugin-managed range streaming; see [binary resources](#binary-resources-and-media-delivery).

Files shows all eligible previewers as named view buttons and keeps **Download** available. Images, SVG, PDF, HTML, and Markdown are contributions from the bundled Files plugin, using the same discovery, selection, and lifecycle API as Audio and third-party previews. Existing text `contentRenderers` are adapted into this file-preview pipeline; their chat behavior and public contribution API remain unchanged. Files itself owns only selection, Raw source, and download fallback. `renderMode: "automatic"` opts into automatic rendering; otherwise selection is explicit. Later matching automatic previewers take precedence over earlier defaults, but an explicit view choice takes priority. Raster images and PDF opt into automatic rendering. SVG, HTML, and Markdown keep Raw as their fresh-browser default; a saved or linked Preview preference activates their registered previewer. Built-in document previewers retain the core size limits, safe file URLs, HTML sandboxing, and native PDF policy. Previewers can handle large files without inheriting the core inline-preview size cap; they must enforce their own limits.

`render` receives a frozen file snapshot, `machineId`, `projectId`, `workspaceId`, workspace `files`, and—when this package has one—its own paired `backend`. It never receives another plugin's backend. The host aborts `signal` when the file, selected view, mounting, or plugin lifetime changes. Stop requests and release media, object URLs, observers, and workers when aborted or disconnected. Report asynchronous failures through `fail(error)`; synchronous failures are caught by the host. Files displays the failure and retains a source/download fallback; failures from obsolete previews cannot replace a newer selection.

For another file-view consumer, require the host capability `{ pluginId: "pi-web", id: "file-previewing", version: 1 }`. Its `listPreviewers(request)` discovers matching views and `renderPreview({ ...request, previewerId, files, fail })` mounts one selected view with the same lifecycle handling. Supply the actual machine and authoritative project/workspace IDs. Require this capability when your plugin must fail explicitly on older hosts rather than run without file-preview support.

The bundled [Audio plugin](https://github.com/jmfederico/pi-web/tree/main/pi-web-plugins/audio) is a complete consumer example. No DOCX conversion is included.

### Highlight additional languages

The bundled **Code highlighting** plugin supplies one **Highlighted** renderer, offered only for languages it supports. Browser v5 plugins can extend it with `syntaxHighlighters` for any language, including languages that PI WEB does not recognize on the server. Match chat fences with `languages` (including aliases) and files with `fileExtensions` (without a leading dot). Adding a grammar expands this renderer's coverage; it does not add a separate renderer choice. Highlighting is available in completed chat fences, Markdown files, and standalone Files previews. **Raw** stays unhighlighted.

Use any tokenizer or grammar bundled with your plugin. The `highlight({ text, signal })` callback returns tokens synchronously or asynchronously: `{ from, to, kind }`, with UTF-16 offsets into the unchanged source. Ranges must be ordered, non-overlapping, non-empty, and within the source. Unmarked text remains plain. Kinds are `keyword`, `string`, `number`, `comment`, `type`, `function`, `variable`, `operator`, `punctuation`, `property`, `literal`, or `meta`; PI WEB supplies theme-aware colours. Return tokens, not HTML or CodeMirror extensions, so independently bundled parsers do not need to share an editor-library instance with the host.

Plugins should stop asynchronous work when `signal` is aborted. Oversized input is not sent to highlighters. A failed highlighter leaves source readable and reports the failure. If several grammar contributions match, the last discovered one wins. Highlighting adds no editing, completion, language-server support, or plugin-defined styling.

A plugin can instead provide an independent highlighting system as a `contentRenderers` contribution. Both highlighting renderers remain separate choices when they support the source; the same last-automatic-renderer rule chooses the default. A v5 renderer's `supports(request)` callback can determine eligibility dynamically, and `title` names its view button—for example, **Highlighted** or **Diagram**. Without a title, the host uses the plugin and contribution IDs. V5 rendering receives the source language, file path, and machine as well as the text; v4 renderer inputs retain their original text, signal, and failure callback. The bundled highlighting plugin demonstrates this pattern.

The bundled Mermaid plugin contributes both a **Diagram** renderer and a source grammar for `mermaid` fences and `.mmd`/`.mermaid` files. Its grammar adds **Highlighted** to those sources without loading the diagram engine. Diagram rendering stays manual; **Raw**, **Highlighted**, and **Diagram** retain the same source text. The lightweight grammar colours common Mermaid syntax; it does not validate diagrams.

Older hosts ignore syntax-highlighter contributions; require the host capability `{ pluginId: "pi-web", id: "syntax-highlighting", version: 1 }` when your plugin depends on this feature. This capability exposes `supports()` and `highlight()` for renderers that consume semantic token contributions. See `SyntaxHighlighterContribution`, `SyntaxHighlightingCapability`, and `ContentRendererContributionV5` in the [public browser contract](https://github.com/jmfederico/pi-web/blob/main/src/plugin-api.ts).

### Binary resources and media delivery

Use a **resource** to deliver bytes from a plugin's server entry to its browser entry. Resources are general-purpose: generated reports, audio, converted documents, and other binary results use the same transport. Resources provide transport, not viewer registration: pair them with [file previewers](#contribute-file-previewers) when the result belongs in Files. They do not change the core file-preview allowlist.

A server v5 peer can implement `resource` alongside `request` and `openChannel`, or by itself. The callback receives the operation, JSON input, cancellation signal, and host-resolved machine/project/workspace scope. It returns `ServerPluginResourceResponse`: a `Uint8Array` or asynchronous iterable of byte chunks, a `contentType`, and optional `contentLength`. Node readable streams can be used as asynchronous iterables.

```ts
// Server entry: no separate HTTP listener or public port.
export default {
  apiVersion: 5,
  name: "Generated reports",
  activate() {
    return {
      peer: {
        resource({ operation, scope, signal }) {
          signal.throwIfAborted();
          if (operation !== "summary" || scope.kind !== "workspace") {
            throw new Error("A workspace summary was requested outside its scope");
          }
          const body = new TextEncoder().encode(`Workspace: ${scope.workspace.label}\n`);
          return { body, contentType: "text/plain; charset=utf-8", contentLength: body.byteLength };
        },
      },
    };
  },
};
```

In a browser v5 panel or action, capture the desired scope and feature-detect `resourceUrl`:

```ts
const peer = context.backend?.forScope({
  kind: "workspace",
  projectId: context.workspace.projectId,
  workspaceId: context.workspace.id,
});
if (peer?.resourceUrl === undefined) throw new Error("Update PI WEB and restart its session daemon to use resources");
const url = peer.resourceUrl("summary", null);
const response = await fetch(url, { signal });
if (!response.ok) throw new Error(`Summary failed: HTTP ${response.status}`);
const summary = await response.text();
```

`resourceUrl()` returns an absolute, browser-ready URL. Use it directly with browser APIs or media elements; do not resolve it again or construct private routes. The URL captures the package revision, machine, and scope. Every load uses normal PI WEB authentication and re-resolves authority on the owning machine, including remote machines. A URL is not a public share link or a bearer credential. Resource URLs from older revisions fail rather than silently invoking new plugin code.

Resource selectors are JSON of at most **4 KiB UTF-8** and appear in the URL. Keep them short and non-secret; URLs can appear in history and logs. Use a normal backend request for large or private inputs, then select a plugin-owned result by a short opaque identifier. Resource callbacks serve GET requests and should not start mutating jobs; browsers may repeat loads or request ranges.

For seeking or partial downloads, the callback receives the optional HTTP `range` string. A plugin may ignore it and return a full `200` response, or implement range handling with `statusCode: 206`, `contentRange`, `contentLength`, and `acceptRanges: "bytes"`. Unsatisfiable ranges use `statusCode: 416` and `contentRange: "bytes */TOTAL"`. PI WEB forwards these fields; it does not seek or slice plugin-owned data. Plugins must validate range requests against their actual resource.

The host streams bytes with backpressure rather than wrapping them in JSON/base64. It validates response metadata and any declared length, cancels work on disconnect or daemon shutdown, and limits resource lifetimes and concurrency. Plugins must honor `signal`, release their own resources, and apply format-specific size and conversion limits. File reads and conversions belong to the plugin: resolve file inputs against the host-provided scope and validate browser-supplied selectors.

Responses are private, uncached, and protected by host-owned MIME and sandbox policies; plugins cannot supply arbitrary HTTP headers, cookies, or redirects. HTML and SVG documents remain sandboxed. Native PDF responses omit the sandbox restriction but retain restrictive CSP and `nosniff`. Inserting fetched HTML into a panel bypasses document isolation: sanitize it before rendering, and never execute untrusted document content.

After upgrading PI WEB for this API, restart the affected session daemon when safe, then reload the browser. Gateways and remote machines must both support resources. This transport does not add resource methods to companion Pi extensions; those continue to use requests and channels.

### Conversations and companion extensions

A server plugin can create a normal, visible Pi conversation, with or without an initial prompt. A companion Pi extension can exchange messages with the backend and use Pi's own APIs to do agent work.

The host PI sessions capability's `run()` accepts optional `model` (an exact `provider/model-id`) and `thinkingLevel` overrides. Omit either to use normal session defaults. Returned handles include effective startup settings when available. The host does not substitute defaults for unavailable overrides: errors with `code: "PI_SESSION_MODEL_UNAVAILABLE"` or `code: "PI_SESSION_THINKING_UNAVAILABLE"` guarantee that no initial prompt was submitted. A caller may explicitly remove the rejected override and try again; other startup errors and completion failures do not provide that guarantee. Scheduled agent tasks uses this contract for its [recorded settings fallback](scheduled-tasks.md#model-and-thinking-overrides).

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

## Find community plugins

[Find community plugins on the website](https://pi-web.dev/community-plugins). Browse public npm packages tagged with `pi-web.dev-plugin` or `pi-web-plugin`, then install packages you trust using the steps below. Listings are community-contributed, not reviewed or endorsed. Plugin authors can follow the website's publishing instructions to make their packages discoverable.

## Install and manage

Use **Settings → Pi packages** to install, update, or remove a package. Enter its npm, git/URL, or local package source. Use **Settings → PI WEB plugins** to enable or disable its web integration and see whether it is active or needs a restart.

Relays and Workflows are managed bundled packages, not independently versioned installs. At session-daemon startup, PI WEB updates their configured sources in the active agent profile to the running installation while preserving resource filters. Removing them through **Settings → Pi packages** is remembered; absent packages stay removed.

| Change | What to do next |
| --- | --- |
| Install or edit a browser-only plugin or declarative theme-only package | Reload the browser page |
| Install, update, configure, enable, or disable a server-backed plugin | Restart the target session daemon, then reload the browser |
| Change ordinary Pi resources such as extensions, skills, or prompts | Run `/reload` in each idle session |
| Change an extension that registers model providers | Follow the separate [provider restart guidance](https://pi-web.dev/config#pi-extension-provider-baseline) |

**Restarting the session daemon may interrupt active sessions and terminals.** Inspect active work first and restart from outside the sessions it hosts. For the native systemd user install:

```sh
systemctl --user restart pi-web-sessiond
```

A browser reload, web/API restart, or Pi's `/reload` does not activate server-plugin changes. Until the daemon restarts, Settings can show different desired and active states. By default, a paired browser entry is withheld when it no longer matches the active server entry, rather than running incompatible code. The supported development launcher has an explicit [local-development exception](#local-development).

Most plugins are enabled by default. Packages can opt out, and Settings can override the default. Plugin settings live in the normal [PI WEB configuration](https://pi-web.dev/config), not inside the package's installed files. Enablement stays global; server plugins supporting project settings, including Git, can use `plugins.<id>.settings` overrides in the registered project's `.pi-web/config.json`. See [Project plugin settings](https://pi-web.dev/config#project-plugin-settings) for override and restart rules.

### Plugin configuration without a settings UI

Server plugins receive frozen, resolved JSON in `context.settings` during activation. Use `context.resolveProjectSettings(project, signal)` when supporting registered-project overrides. PI WEB owns reading its config files, parsing environment JSON, layering values, and enforcing deployment overrides; plugins must not reimplement those readers.

No configuration UI or registered schema is required. Plugins own defaults and semantic validation of their setting names and values. Core validates the JSON/envelope structure, not plugin-specific meanings. Settings currently edits enablement, not arbitrary plugin settings. Browser-only plugins do not yet receive an equivalent generic settings context.

Generic plugin settings are visible through the authenticated configuration API; do not use them as a secret store. Plugin-owned domain files, such as Workspace Tasks' `.pi-web/tasks.json`, remain separate from PI WEB configuration.

### Local development

The supported `npm run dev:web` launcher defaults `PI_WEB_DEV_PLUGIN_PAIRING` to `1` in its child processes. This relaxes browser/server plugin pairing so refreshed plugin UI can use the still-running old backend after a rebuild. It does not reload server plugins or apply backend changes, and requires no plugin changes. Production and other startup paths remain strict by default. The flag accepts `1`/`true` and `0`/`false` (case-insensitive); invalid values fail web/API startup.

To exercise strict pairing during development:

```sh
PI_WEB_DEV_PLUGIN_PAIRING=0 npm run dev:web
```

Package/settings mismatches remain visible through the existing restart-required diagnostics in **Settings → PI WEB plugins**, even when the refreshed UI is allowed to load. Development pairing does not prove that changed request/response formats are compatible; mismatches can cause runtime errors. If the new UI needs backend changes, restart the target session daemon, then reload the browser. **Restarting the backend interrupts active sessions and terminals**; finish important work first and restart from outside its hosted sessions. A browser refresh or web/API autoreload leaves the old backend running.

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

- **Terminal** supplies terminals and command runs in one tab. With a workspace selected, it lists that workspace's terminals alongside existing maintenance terminals on the same machine. Without a workspace, it lists only maintenance terminals. **New terminal** creates workspace shells only; maintenance terminals start through actions such as Update and can be continued interactively after completion. Closing a maintenance terminal removes it from every workspace view. Terminal is required in normal operation; disable it only through emergency safe start.
- **Files** supplies file browsing, uploads, and the common previewer chooser. Its image, SVG, PDF, HTML, and Markdown views are ordinary previewer contributions; text-renderer contributions use the same file-preview pipeline. Disabling its panel does not remove other plugins' file helpers.
- **Audio** adds an automatic Files preview for common audio extensions. Its paired backend streams workspace audio and supports single byte ranges for seeking; decoding depends on the browser's codecs. Download remains available when playback fails. This plugin exercises both file-preview contributions and generic backend resources; other previewers can use ordinary file downloads instead. Server-backed plugin changes require a session-daemon restart.
- **Git** discovers Git workspaces and provides status/diff, including [automatic discovery of new worktrees](#automatic-git-worktree-discovery) on supported Git builds. Disabling it leaves the project-folder workspace available unless another provider takes over.
- **Mermaid** uses the default manual mode: choose **Render** to preview `mermaid` fences and `.mmd`/`.mermaid` text files. Its bundled engine runs locally in an opaque-origin sandbox with network access blocked; no diagram service receives your source. Interactive links and external resources are intentionally unavailable. Disable Mermaid in plugin Settings to keep plain code rendering. Only a browser reload is needed after changing this browser-only plugin.
- **Code highlighting** colours completed chat code fences in common languages automatically, including JavaScript/TypeScript, Python, shell, HTML/CSS, JSON, Go, Rust, SQL, and diff. Choose **Raw** to view plain source or **Preview** to restore colours; Copy always copies the source. Unsupported, unlabelled, incomplete, and oversized blocks stay plain. Highlighting runs locally without executing code. Disable Code highlighting in plugin Settings to keep plain code rendering; reload the browser after changing this browser-only plugin.
- **Info** displays machine and PI WEB status without requiring a workspace, adds workspace details when selected, and provides copyable diagnostics.
- **Updates** shows update/restart guidance when relevant and offers a manual update check. Run uses the selected machine's maintenance terminal in `$PI_WEB_DATA_DIR/maintenance` (default `~/.pi-web/maintenance`), whether or not a workspace is selected. It requires an available Terminal provider on that machine; guidance and Copy remain available without one.
- **Workspace Tasks** turns project commands into runnable buttons.
- **Scheduled agent tasks (beta)** is an optional, disabled-by-default package for agent-managed schedules and a read-only **Scheduled tasks** dashboard. See [installation, timezone settings, and execution behavior](scheduled-tasks.md).
- **Spanish / Español** and **Swedish / Svenska** are optional interface language packs, included but disabled by default. See [Language packs](#language-packs) to enable them.

### Language packs

Enable `language-spanish` or `language-swedish` in **Settings → PI WEB plugins** on the gateway machine, then reload the browser. These are browser-only plugins; no session-daemon restart is needed.

In **Settings → General → Language and region**, select **Spanish** (`es`) or **Swedish** (`sv`) as the interface language and apply it to this browser. Language names follow the current interface language. You can enable both packs and switch between them. Browser or gateway language defaults can also select an enabled pack.

The packs translate PI WEB's interface and bundled plugin labels, not conversations, model responses, file contents, or third-party plugins. Missing translations fall back to English. Regional formats, time zone, and clock preferences remain independent of interface language. Disabling a pack and reloading restores English fallback when that language is requested.

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

Open the **Tasks** tab to run a command in a workspace terminal. These command buttons are separate from [scheduled agent tasks](scheduled-tasks.md), which dispatch conversations. Tasks can also have a `description`. Review commands before running them, especially in shared repositories. Disabling the plugin hides the tab without changing the project file.

### Workflows

Workflows is a shipped Pi package for PI WEB's opinionated prompts and shortcuts. **Create Worktree** opens a dialog for the base branch and purpose or description. The base defaults to the main workspace's current branch, or `HEAD` when detached; local and remote branches are suggested. Submitting starts a fresh conversation in the selected project's main workspace and submits `/worktree` with the details. The action is a shortcut for the same prompt template used by the command, not a separate agent workflow. You can invoke it from another worktree or without a selected conversation; your current conversation and draft remain untouched.

The action requires the Workflows server plugin and API v5. It uses public project/workspace discovery and session capabilities, including on remote machines. If dispatch cannot be confirmed, inspect Sessions before trying again; the dialog does not resend automatically. The agent creates the worktree, so opening its conversation is not confirmation that creation has finished.

You can also use `/worktree` directly in a conversation with the free-form hint **Purpose and/or base branch**:

```text
/worktree fix login redirects
/worktree add search based on origin/main
```

The prompt asks the agent to create a worktree named for your purpose, using the requested base or the current worktree's HEAD. If you give no purpose or description, the agent asks for one.

PI WEB installs Workflows automatically for the active agent profile at session-daemon startup. Its web plugin is enabled by default. After installing or updating its server-backed web plugin, restart the target session daemon when safe and reload the browser. Disable **Workflows** in **Settings → PI WEB plugins** and restart the target daemon when safe to hide the shortcut while keeping `/worktree`. To remove its prompts as well, remove the package in **Settings → Pi packages** and run `/reload` in each idle conversation. Removal is remembered across daemon restarts; reinstall from **Available packages** if you change your mind, then reload idle conversations and the browser.

### Relays

The shipped Relay package adds `/relay` for the current checkout and `/relay-worktree` for a fresh worktree. It clarifies a goal and boundaries with you, then starts only after explicit approval. Fresh sessions record progress and hand off until the goal is reached or human help is needed. Project instructions and skills govern the work, and completion requires a fresh-context review.

The read-only **Relays** tab lists saved packets under `.pi-web/relays/` and shows their goal, current baton, history, and any recorded decisions. It does not start or edit a relay. A session-list indicator opens the associated packet on that conversation's machine and workspace, including custom packet locations inside the workspace. Older sessions without public Relay metadata have no indicator.

PI WEB installs Relay automatically for the active agent profile if it is not configured. Removing it through **Settings → Pi packages** is remembered; it will not be silently reinstalled. Reinstall from **Available packages** if you change your mind. Disabling just the Relays plugin hides its tab and row indicators but leaves its agent resources available.

## Pi extension dialogs

Pi extensions can ask for confirmation, a selection, or text input. PI WEB shows these questions inline in the conversation, including during session startup or while a tool is waiting. They remain answerable after a browser reload, and the first answer wins across tabs.

Dialogs use the extension's timeout and the host's configured [dialog timeout](https://pi-web.dev/config#extension-dialogs). Aborting work, replacing a runtime, or reloading extensions closes the relevant outstanding questions. Answered cards are browser-local and need not survive a reload. If you reload during startup, find the live conversation in Sessions and open it to answer its pending questions.

These three dialog methods are supported; other Pi extension UI surfaces, such as custom editors and widgets, are not. An extension should not assume every UI feature works just because `hasUI` is true.

### Extension tree commands

Pi extension commands can rewind with `ctx.navigateTree()` and fork with `ctx.fork()`, including follow-up work using the fresh `withSession` context. These operations run independently of browser connections. Rewinds refresh the viewed conversation; forks appear in Sessions for you to open. Other viewers keep their own selection and unsent drafts.

Extension tree commands preserve this browser's unsent draft; prepared text from these commands is not shown in the web UI. The web UI's **Go back** action restores a selected user message directly into the editor and asks for confirmation before replacing a nonempty draft. Going back to other messages preserves the draft without a replacement warning.

Extension idle/reload actions are supported. `ctx.newSession()` and `ctx.switchSession()` report that they are unsupported; use the web UI for those actions. Other terminal editor and widget APIs remain unsupported.

### Pi Markdown transformers

PI WEB applies a session's `pi.registerMarkdownTransformer()` chain to completed and historical user text, assistant text, and assistant thinking. Transformations run in the session daemon before browser Markdown sanitization and code-fence previews; file previews are unaffected. Original session content and **Copy message** stay unchanged. Code-fence Raw/copy controls use the transformed fence source.

Live partial responses remain untransformed until completion, including after reconnect. Transformers receive `isStreaming: false` and a fixed `availableWidth: 80` (a compatibility approximation, not browser geometry). Empty transformed parts are hidden, but their message row remains. Failed transformers are logged and skipped; later transformers receive the last successful result. Keep transformers synchronous and cheap, since history reads also invoke them.

## Agent development

Start with the public contracts and a working example below. Keep API and lifecycle details here; the [human-facing guide](https://pi-web.dev/plugins#agent-development) provides the prompt for requesting a plugin.

### Where to implement

Use the smallest example that fits. Source links below track development on `main`; **use the tag or installed declarations matching your PI WEB version** when implementing against a release.

| Need | Start here |
| --- | --- |
| Browser contributions and helpers | [`plugin-api.ts`](https://github.com/jmfederico/pi-web/blob/main/src/plugin-api.ts), published as `@jmfederico/pi-web/plugin-api` |
| Server lifecycle, peers, providers, and host capabilities | [`server-plugin-api.ts`](https://github.com/jmfederico/pi-web/blob/main/src/server-plugin-api.ts), published as `@jmfederico/pi-web/server-plugin-api` |
| A small browser plugin | [Info](https://github.com/jmfederico/pi-web/tree/main/pi-web-plugins/info) |
| A standalone browser/server package | [Workspace-provider example](https://github.com/jmfederico/pi-web/tree/main/examples/workspace-provider-plugin) |
| A production workspace provider and paired UI | [Git](https://github.com/jmfederico/pi-web/tree/main/pi-web-plugins/git) |
| Package discovery rules and diagnostics | [Plugin catalog](https://github.com/jmfederico/pi-web/blob/main/src/server/piWebPluginCatalog.ts) |

The current browser and server contracts are both **API v5**. Browser v4 and server v3 remain supported with a once-per-plugin deprecation diagnostic; no removal date is set. Other versions are unsupported. Legacy entrypoint contracts stay frozen; new contribution fields and callback inputs belong to v5. Capabilities have independent versions: a compatible v4 browser or v3 server plugin can declare and resolve a new capability without changing its entrypoint version. The public source contracts and their tests are the reference for signatures, validation, limits, and lifecycle details.

### Host-provided UI styles

**Styling is mostly experimental.** The [initial theme styling contract](theme-styling-contract.md) supports specific conversation, choice, navigation-row, composer-control, and popup/menu hooks. Other shared classes, theme properties, visual design, and layout may change between releases; test custom styling when upgrading PI WEB.

Plugins can reuse the host's button, select, toolbar, tab, and file/tree-row styles without receiving CSS text or creating stylesheet elements. Request `{ pluginId: "pi-web", id: "stylesheet-integration", version: 1 }`, resolve it in `start`, and opt each participating shadow root into the single shared UI bundle. See [integrating plugin components](#integrating-plugin-components) for the complete capability setup.

For Lit, call once in the component constructor:

```ts
styles.createController(this, { sharedUi: true });
```

For plain DOM, register on connection and release on disconnection:

```ts
const release = styles.registerRoot(shadowRoot, { sharedUi: true });
// On disconnect:
release();
```

The host compiles one shared sheet on demand, adopts it before contributed theme/plugin sheets, and removes it when the last shared-UI registration for that root is released. The same sheet serves existing and later roots; theme changes do not remove these defaults. A registration without `sharedUi: true` receives contributed stylesheets only. The bundle contains shared primitives, not shell or chat layouts. No private client imports or additional plugin manifest fields are needed.

The current bundle provides these native HTML patterns:

| Pattern | Classes and states |
| --- | --- |
| Button | `button.ui-button`; optional `ui-button--compact`, `ui-button--icon`, `ui-button--primary`, or `danger`; native `disabled` |
| Select | `select.ui-select`; preserve its native label and change handling |
| Toolbar | `.ui-toolbar`, optionally `ui-toolbar--primary`; group controls with `.ui-toolbar-group` and label areas with `.ui-toolbar-title` |
| Trailing group boundary | Add `ui-toolbar-group--bounded` when a group meets empty bar space, not the bar's edge |
| Tabs | `.ui-tabs` containing `button.ui-button.ui-tab`; optionally `ui-tabs--primary` for main navigation; nested groups can use `.ui-toolbar-group` |
| Active tab | `.selected`, `aria-current="page"`, or `aria-pressed="true"` on the tab button |

Toolbars and tabs use compact 32px controls by default. Primary variants use 44px controls. Control dimensions stay consistent across input types; use available viewport or container space, not touch capability, for responsive sizing. Icon-only buttons need an accessible name. Keep grouped controls gapless and let the shared styles provide separators and hover/focus states. Use existing `--pi-*` colour tokens in plugin-specific content styles so theme changes continue to propagate through shadow roots.

The shared bundle also provides compact file/tree lists:

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

These are appearance patterns: the plugin still owns events, selection, keyboard navigation, and ARIA semantics. Styling a row as tabs does not implement an ARIA tab widget. Do not deep-import client source files. Menu, form, and dialog styles are not currently included in the shared bundle. You can target internal selectors through [contributed CSS files](#css-files-and-shadow-roots), but those selectors and markup may change between releases.

Stylesheet integration works with supported browser APIs v4 and v5. Its capability version describes the integration interface, not a stable set of CSS classes or a promise of unchanged appearance. Shared styling follows the running PI WEB frontend after reload. The earlier unreleased `ui-styles` CSS-text capability has been replaced by this root opt-in.

### CSS files and shadow roots

Contribute CSS files to customize the document and participating host or plugin shadow roots. This builds on the shared UI patterns above and inherited `--pi-*` custom properties; it does not require a separate option for each styling choice. Only the hooks listed in the [theme styling contract](theme-styling-contract.md) are supported selectors. Other internal host classes, component names, and markup are **not stable selectors**: you may target them, but test your CSS when upgrading PI WEB. CSS changes presentation, not behavior or component structure.

With browser API v5, add `stylesheets` to the object returned by `activate().contributions`:

```ts
import type { PiWebPlugin } from "@jmfederico/pi-web/plugin-api";

export default {
  apiVersion: 5,
  name: "Custom appearance",
  activate: () => ({
    contributions: {
      stylesheets: [{
        id: "controls",
        url: new URL("./controls.css", import.meta.url).href,
        order: 1100,
      }],
    },
  }),
} satisfies PiWebPlugin;
```

For example, `controls.css` can style native controls inside integrated roots:

```css
.ui-button {
  border-radius: 6px;
}

/* Relative to controls.css, not the page or JavaScript module. */
.my-plugin-logo {
  background-image: url("./images/logo.svg");
}
```

Each runtime file has an `id` unique among its plugin's contribution IDs (or within its theme's stylesheet list), an absolute HTTP(S) `url`, and optional finite numeric `order` (default `1000`). [Declarative themes](#css-first-themes) use browser-root-relative `path` values instead; the gateway supplies their URLs. Lower orders are adopted first; ties sort lexically by qualified ID, independently of network completion. Normal CSS cascade, specificity, layers, and importance still apply. Contributed sheets follow a root's own adopted sheets; this is not a promise that every selector wins.

Ship the CSS and referenced assets under the plugin's browser-public root. Use module-relative URLs rather than hard-coded PI WEB routes so nested deployments work. Configure your bundler to emit a CSS **file**, not a JavaScript CSS module or data URL; with Vite, `new URL("./controls.css?no-inline", import.meta.url).href` prevents small files from becoming data URLs. Inline CSS contributions and runtime `@import` are unsupported: bundle imports into each contributed file before shipping. Relative resource URLs resolve against the final CSS response URL, including redirects. Fragment-only references such as `url(#filter)` remain local SVG references. Cross-origin files need the usual browser CORS permissions.

Plugin-level files apply while the plugin is active and eligible on the selected machine, after successful `start`. Files inside a theme apply only to the resolved selected theme. Theme changes, automatic light/dark switching, and plugin unload remove inactive sheets from every registered root; pending obsolete loads are cancelled. Each active URL is fetched and compiled once, shared across roots, and released when no active contribution references it. Existing and later-registered roots receive the same sheets.

Loading is asynchronous. Requests require a successful HTTP response with `Content-Type: text/css`, are limited to **15 seconds and 2 MiB per file**, and reject runtime imports or invalid resource URL syntax. Failures appear in the browser console with the contribution ID and URL in the error chain; ordinary plugin and selected-theme failures are reported separately. Ordinary plugin files publish independently; a failed plugin file does not block the selected theme. A theme's files publish together only when all are ready, keeping the previous committed palette on failure. The next publication retries failed files without reloading successful active files. Standard browser CSS parsing still governs individual invalid declarations.

#### Integrating plugin components

The document, host shadow roots, and bundled plugin-owned shadow roots participate already. External plugins choose their depth: register every root for direct rules, register just a top-level root and map inherited variables into internal or third-party components, or do not participate. A rule cannot cross another shadow boundary without participation at that root. Unregistered descendants can still inherit custom properties. There is no automatic root discovery or `attachShadow` patching.

Request the `stylesheet-integration` v1 capability, then pass its value to your components. It handles both contributed files and optional shared UI injection. The public import supplies types only; no private client import is needed.

```ts
import type {
  PiWebPlugin, PluginCapability, StylesheetIntegrationCapabilityV1,
} from "@jmfederico/pi-web/plugin-api";

const stylesheetIntegration: PluginCapability<StylesheetIntegrationCapabilityV1> = {
  pluginId: "pi-web", id: "stylesheet-integration", version: 1,
  parse(value) {
    if (typeof value !== "object" || value === null
        || !("registerRoot" in value) || typeof value.registerRoot !== "function"
        || !("createController" in value) || typeof value.createController !== "function"
        || !("subscribe" in value) || typeof value.subscribe !== "function") {
      throw new Error("Stylesheet integration v1 unavailable");
    }
    return value as StylesheetIntegrationCapabilityV1;
  },
};

export default {
  apiVersion: 5,
  name: "Participating panel",
  requires: [stylesheetIntegration],
  activate({ html }) {
    return {
      start({ capabilities }) {
        definePanel(capabilities.resolve(stylesheetIntegration));
      },
      contributions: {
        workspacePanels: [{
          id: "example", title: "Example",
          render: () => html`<my-styled-panel></my-styled-panel>`,
        }],
      },
    };
  },
} satisfies PiWebPlugin;
```

For Lit, implement `definePanel` alongside that plugin and call `createController(this, { sharedUi: true })` once in the constructor. The controller registers after Lit creates the shadow root, releases it on disconnect, and registers again on reconnect:

```ts
import { LitElement, html } from "lit";

function definePanel(styles: StylesheetIntegrationCapabilityV1) {
  if (customElements.get("my-styled-panel")) return;
  customElements.define("my-styled-panel", class extends LitElement {
    constructor() {
      super();
      styles.createController(this, { sharedUi: true });
    }
    render() {
      return html`<button class="ui-button">Example action</button>`;
    }
  });
}
```

For a framework-independent alternative, use `registerRoot(root, { sharedUi: true })` and keep its cleanup function. A retained closed root works too; open roots are not required:

```ts
function definePanel(styles: StylesheetIntegrationCapabilityV1) {
  if (customElements.get("my-styled-panel")) return;
  customElements.define("my-styled-panel", class extends HTMLElement {
    private readonly root = this.attachShadow({ mode: "closed" });
    private releaseStyles: (() => void) | undefined;

    constructor() {
      super();
      const button = document.createElement("button");
      button.className = "ui-button";
      button.textContent = "Example action";
      this.root.append(button);
    }
    connectedCallback() {
      this.releaseStyles?.();
      this.releaseStyles = styles.registerRoot(this.root, { sharedUi: true });
    }
    disconnectedCallback() {
      this.releaseStyles?.();
      this.releaseStyles = undefined;
    }
  });
}
```

Use one of these `definePanel` implementations, not both. Pass the capability to nested participating components as well. If a framework injects it after connection or replaces it, release any old registration and register the current root with the new value. Do not create repeated Lit controllers on property updates. Releasing registrations on disconnect prevents the host from retaining abandoned roots; each independent registration needs its own cleanup. The bundled [Files components](https://github.com/jmfederico/pi-web/tree/main/pi-web-plugins/files) show delayed capability injection and nested Lit roots; [Relay](https://github.com/jmfederico/pi-web/tree/main/pi-packages/relays) uses plain DOM lifecycle hooks.

#### Reacting to stylesheet changes

Components that copy computed CSS values into a canvas or another rendering system can use the same capability's `subscribe` method:

```ts
const releaseRoot = styles.registerRoot(root);
refreshFromComputedStyles();
const unsubscribe = styles.subscribe(() => refreshFromComputedStyles());

// On disconnect, unsubscribe before releasing the root.
unsubscribe();
releaseRoot();
```

Listeners run synchronously after a changed active stylesheet list has been adopted in every registered root, including removal and successful files from a partly failed update. Initial subscription, root registration, unchanged publications, and obsolete loads do not notify. Read initial values after root registration. Listener failures are logged without blocking other subscribers. Release subscriptions on disconnect and subscribe again on reconnect or capability replacement. This signal covers PI WEB stylesheet publication, not arbitrary DOM/CSS mutations, media-query changes, or completion of font/image loading.

### File icon themes

Files and Git display extension-specific shapes from one selected icon theme in a single muted tone. The active colour theme supplies the grey for both light and dark appearances. Git shows change status through filename colours and status labels in both list and tree views. Material icons are bundled locally by default, using the pinned npm package at build time rather than a tracked SVG collection. Choose an icon theme or generic file icons in **Settings → General → File icons**. This choice belongs to the current browser, not the gateway configuration.

Browser API v5 plugins can contribute complete sets through `fileIconThemes`:

```ts
fileIconThemes: [{
  id: "my-icons",
  name: "My icons",
  file: { url: new URL("./file.svg", import.meta.url).href },
  files: [{
    filenames: ["Dockerfile"],
    icon: { url: new URL("./docker.svg", import.meta.url).href },
  }, {
    extensions: [".ts", ".tsx"],
    icon: {
      url: new URL("./typescript.svg", import.meta.url).href,
    },
  }],
}]
```

`file` is the fallback asset. Matching uses only the basename, without reading file contents: exact filenames win over extensions, longer extensions win over shorter ones (such as `.d.ts` before `.ts`), and declaration order breaks ties. Matching is case-insensitive. Directory disclosure arrows are unchanged. Asset URLs must be absolute HTTP(S) URLs. Use SVGs with transparent backgrounds and recognisable alpha silhouettes; other transparent browser image formats work too. Opaque fills become solid shapes, regardless of their original colours. Bundle assets under the plugin's browser-public root and use module-relative URLs; with Vite, prevent small assets becoming data URLs. Icons render as decorative CSS alpha masks, never injected SVG markup, and failed image loads fall back to the generic file icon. Remote assets require CORS and depend on network access and the deployment's content security policy; bundled assets avoid third-party requests.

Like colour themes, icon themes are app-wide and only gateway contributions are used. A missing selected theme temporarily falls back to Material without erasing the browser choice. Plugins consuming the selected icons can require `{ pluginId: "pi-web", id: "file-icons", version: 1 }` and use its `FileIconsCapability`: `resolveIcon(path)` returns the current mask asset URL or `undefined` for generic icons, and `subscribe(listener)` reports selection, colour-scheme, and contribution changes. Unsubscribe on disconnect and subscribe again on reconnect or capability replacement.

### CSS-first themes

Themes extend the built-in base theme: they can supply layout and control rules as well as palette properties. The base provides the default shell, responsive layout, shared controls, and transcript presentation in the `pi-web-base` cascade layer. Normal unlayered theme rules override those defaults. A supported contract covers conversation, choice, project/workspace/session navigation-row, composer-control, and popup/menu hooks; specialised local component/plugin styles outside that boundary are still being migrated. See [theme architecture](theme-architecture.md) for composition, examples, and current limits.

Declare new themes as static package metadata. A theme-only package ships CSS and assets without browser JavaScript or a server module. The gateway reads themes without evaluating package code and includes its default-theme details and CSS in the initial page. Details include the associated light/dark pair; both variants' CSS are included for Auto. The app can show that palette while a different browser preference loads through an ordinary request. General settings fetch the full inventory once per dialog, with explicit retry on failure and HTTP caching across requests. Built-in palettes use the same declarative mechanism and retain their `themes:*` IDs.

For example, ship this `package.json` alongside `assets/dark.css` and `assets/light.css`:

```json
{
  "name": "pi-web-ocean-themes",
  "version": "1.0.0",
  "files": ["assets"],
  "piWeb": {
    "plugins": [{
      "id": "ocean-themes",
      "browserRoot": "assets",
      "themes": [{
        "id": "ocean-dark",
        "name": "Ocean Dark",
        "colorScheme": "dark",
        "stylesheets": [{ "id": "palette", "path": "dark.css" }]
      }, {
        "id": "ocean-light",
        "name": "Ocean Light",
        "colorScheme": "light",
        "stylesheets": [{ "id": "palette", "path": "light.css" }]
      }],
      "themePairs": [{
        "id": "ocean",
        "name": "Ocean",
        "light": "ocean-light",
        "dark": "ocean-dark"
      }]
    }]
  }
}
```

Theme and pair declarations require `id` and `name`, and accept optional `description` and finite numeric `order`. Themes also require `colorScheme` (`light` or `dark`) and a nonempty `stylesheets` list. Each stylesheet requires a local `id` and a `path` relative to `browserRoot`, with optional finite numeric `order`. Local IDs begin with a lowercase letter and contain only lowercase letters, digits, dots, or hyphens. Theme and pair IDs must be distinct within an entry; stylesheet IDs must be distinct within each theme. Pair members must reference local themes with matching light/dark schemes.

Keep paths inside the browser-public root, without leading slashes, backslashes, empty segments, `.` or `..` segments. Everything in `browserRoot` is public; ship only intended assets. The gateway supplies qualified theme IDs such as `ocean-themes:ocean-dark` and default/enforced policy. Initial delivery contains only the default selection, or Classic while a legacy runtime default awaits browser activation. `GET api/theme?themeId=…&auto=…` supplies another selection on demand, and General settings use `GET api/themes` for the complete enabled picker inventory. Metadata responses support private HTTP caching with ETag revalidation. It supplies revision-path stylesheet URLs so relative CSS fonts and images use the same immutable asset revision. Keep those assets under the same root, and bundle CSS imports before shipping. Theme-only changes need a browser reload, not a session-daemon restart.

#### Migrating runtime themes

Browser `activate().contributions.themes` and `themePairs` are deprecated but remain supported, with a browser-console deprecation warning. V5 runtime themes still use CSS stylesheet URLs; v4 themes retain their required `tokens: ThemeTokens` contract and cannot declare stylesheet contributions. Existing token palettes continue to work through semantic-property fallbacks, and switching away clears their overrides. Runtime themes require browser activation and cannot benefit from early static discovery.

Move theme and pair metadata into the same entry's `piWeb.plugins[]` declaration. Replace stylesheet `url` expressions with `path` values relative to `browserRoot`, and ship the CSS and referenced assets there. Convert v4 tokens into CSS custom properties. Preserve the plugin ID and local theme/pair IDs to keep saved choices valid, and remove the old runtime registrations rather than registering the same themes twice. Remove `module` only if the browser entry has no other work; remove `serverModule` only if no backend is needed.

Put palette custom properties on `:root` so they inherit into shadow trees; use ordinary selectors in the same file for direct rules in participating roots.

`dark.css` might start with:

```css
:root {
  --pi-bg: #071923;
  --pi-surface: #102b38;
  --pi-text: #e4f5ff;
  --pi-accent: #60d7ee;
}
```

#### Semantic appearance properties

Themes can override these properties independently of the base palette:

| Properties | Purpose |
| --- | --- |
| `--pi-font`, `--pi-mono` | UI and code font-family stacks; control sizes and line heights stay component-owned |
| `--pi-thinking`, `--pi-tool` | Thinking and tool activity tones |
| `--pi-syntax-comment`, `--pi-syntax-keyword`, `--pi-syntax-string`, `--pi-syntax-number`, `--pi-syntax-title`, `--pi-syntax-deletion` | Syntax-highlighting colours, independent of success/warning/error feedback |
| `--pi-chat-conversation-bg`, `--pi-chat-conversation-border` | Ordinary conversation surface and leading edge |
| `--pi-chat-user-bg`, `--pi-chat-user-border` | User-message surface and leading edge |
| `--pi-chat-system-bg` | System-message surface |
| `--pi-chat-activity-bg`, `--pi-chat-compacting-bg` | Session activity and compaction surfaces |

Define these on `:root`, alongside the base palette. Font properties accept font-family stacks, not complete `font` shorthands; keep `--pi-mono` monospaced for code alignment. The terminal's xterm grid and copy-selection overlay retain their configured font so cell geometry stays aligned. Existing themes may omit them: components fall back to base palette colours, existing colour mixes, and system fonts. Built-in themes declare them explicitly; most colours alias or mix base palette properties. Syntax deletions default to `--pi-danger`; the legacy `--pi-error` property remains a fallback for older external themes. Theme properties control appearance; direct CSS rules can also customise migrated base layouts. Components retain interaction and scroll controllers, while the base theme supplies default responsive CSS and visual accessibility treatments. These properties, like shared UI classes, remain experimental.

The example above is a partial palette. Use the [built-in palette files](https://github.com/jmfederico/pi-web/tree/main/pi-web-plugins/themes/assets) as a reference for the shared `--pi-*` vocabulary. `colorScheme` remains required metadata for native controls and browser appearance; declaring CSS alone does not set it. Theme pair `light` and `dark` values are local theme IDs from the same plugin. Auto mode follows the device preference within the pair; unpaired themes stay selected. See [theme selection and defaults](config.md#theme-default-and-device-choices) for device choices, fallback, and the preserved built-in IDs. Machine-bound remote theme contributions remain ignored; themes are app-wide.

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

Components and event handlers can call `catalog.projects.list()` / `get(projectId)`, `catalog.workspaces.list(projectId)` / `get({ projectId, workspaceId })`, and `catalog.sessions.list({ projectId, workspaceId })` / `get({ projectId, workspaceId, sessionId })`. Reads accept an optional abort signal. Session snapshots include public metadata, durable `pinned` state, and `runtime` (`not-hosted`, `idle`, or `busy`). Every snapshot includes `created`, `modified` (last session-file modification, used by native idle-age rules), and `archivedAt` (when the session entered the archive). Each is an ISO timestamp or `null` when unknown; `archivedAt` is also `null` for non-archived sessions. `pinned` is always a boolean. Discovery does not open a saved session or expose its transcript/private file path.

These fields let plugins implement their own age filters, estimated summaries, and lifecycle policies without a cleanup-specific API. Use `modified` for idle age and `archivedAt` for time in the archive—not the archive file's modification time. `pinned` reflects protection by any retained pin scope, matching core cleanup, not just the workspace being listed. Dates may be `null` for incomplete legacy records or hosted-only conversations. A null date means **unknown**, not an old date. Skip records whose required dates are unknown. Plugins using this metadata require an updated PI WEB host; there is no separate capability gate or fallback for older catalog responses. For example:

```ts
const rows = await context.catalog.sessions.list({ projectId, workspaceId });
const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
const archiveCandidates = rows.filter((session) =>
  !session.archived && session.pinned === false && session.runtime !== "busy"
  && session.modified !== null && Date.parse(session.modified) < cutoff);
```

A plugin can show those candidates or counts using its own interface, then use the [session lifecycle service](#session-lifecycle). Re-read eligibility and pins before executing a cleanup policy: explicit lifecycle commands intentionally do not enforce pin protection. Core cleanup remains built in.

Paired plugins also receive `backend` in these browser contexts. `backend.forScope({ kind: "machine" })`, `{ kind: "project", projectId }`, or `{ kind: "workspace", projectId, workspaceId }` returns the package's paired request, channel, or resource interface on that context's machine. Portable browser-only plugins have no paired backend. Existing workspace `peer` helpers remain available.

Server v5 peer callbacks receive `scope` instead of always requiring `project` and `workspace`. Machine scope carries no project; project scope contains host-resolved `project`; workspace scope contains host-resolved `project` and `workspace`. Browser/server package revisions, cancellation, and host authority checks still apply. Server v3 retains its workspace-only callback shape and cannot accept machine/project-scoped calls.

Backend plugins declare `PI_WEB_HOST_CATALOG_CAPABILITY` in `requires`, then resolve it in `start({ capabilities })`. This provides the same read-only discovery locally to that daemon. Workspace providers must not depend on the catalog: it becomes available only after provider topology settles. The catalog remains read-only; use the separate [session lifecycle service](#session-lifecycle) for session mutations.

Machine-specific contributions are visible only on their owning machine; portable browser contributions follow selection. Switching machines does not stop backend work. Plugins must discard obsolete asynchronous UI results and clean up component-owned connections when their context changes.

A few design boundaries matter before implementation:

- Declare entries in `package.json` under `piWeb.plugins`; copy packaging from a standalone example. A package can contain multiple entries.
- Use only the public package entrypoints. Internal routes, services, and `dist/**` imports are not supported APIs.
- Keep browser assets in a narrow `browserRoot`: everything inside it is browser-public. Include the built dependencies and assets it needs, and keep secrets outside it. The installed plugin package is limited to 4,096 entries and 16 MiB, excluding `.git` and `node_modules`.
- Use host helpers for machine/workspace operations and module-relative URLs for plugin assets. Avoid hard-coded application paths.
- Rendering can happen repeatedly without a panel being mounted again. Own asynchronous state and use ordinary component lifecycle cleanup for connections, timers, and listeners.
- Keep workspace discovery separate from session-backed features, and keep agent behavior in a Pi companion rather than importing host internals.

## Session lifecycle

Plugins can manage a saved session by its full `{ projectId, workspaceId, sessionId }` identity, without selecting it in the browser or opening its runtime. The host resolves the workspace; plugins do not supply session file paths.

Browser v5 invocation contexts expose optional `context.sessions`, bound to that context's machine. Check for its presence on older hosts. Server plugins declare `PI_WEB_HOST_SESSION_LIFECYCLE_CAPABILITY` from `@jmfederico/pi-web/server-plugin-api` in `requires`, then resolve it in `start({ capabilities })`. The capability is local to that daemon and becomes available after workspace providers have settled; workspace providers must not depend on it.

| Method | Effect |
| --- | --- |
| `get(target)` | Read `{ sessionId, pinned, archived }`. |
| `pin(target)` | Persist a pin in the target workspace for an active or archived session. |
| `unpin(target)` | Remove that workspace's pin; pins in other scopes remain in effect. |
| `archive(target)` | Archive that session, without implicitly archiving descendants. |
| `restore(target)` | Restore an archived session without starting its runtime. |
| `delete(target)` | Permanently delete an already-archived session. |

```ts
// In a browser plugin's event handler, using IDs returned by context.catalog:
const sessions = context.sessions;
if (sessions === undefined) throw new Error("This host does not support session lifecycle operations");
const target = { projectId, workspaceId, sessionId };
await sessions.pin(target);
const state = await sessions.get(target);
```

**Pins protect cleanup, not explicit plugin commands.** A plugin can explicitly archive a pinned session or delete it once archived; it does not need to unpin first. Native busy-session and archived-only deletion safeguards still apply. Plugins are trusted code and must decide when to request confirmation for destructive actions. Cleanup previews remain estimates: cleanup rechecks eligibility and pins when it runs, rather than freezing a session list.

Calls accept an optional `{ signal }`. Cancellation or plugin disposal prevents new work; it does not undo a mutation already admitted by the host. Call mutations from event handlers or background work, not render or availability callbacks. Errors are reported to the caller; do not automatically retry a destructive operation after an ambiguous transport failure without checking the current state.

### Pin-storage upgrade

Session pins are daemon-owned managed state in `$PI_WEB_DATA_DIR/session-pins.json`. The updated daemon imports existing pin scopes, ordering, revisions, and cleared scopes from `navigation-preferences.json` once. Project and workspace ordering stays web/API-owned in the original file. Browser pin actions, plugin commands, and cleanup then use the same daemon-owned pins.

Upgrade/restart the web/API process **before** starting the updated session daemon, then reload the browser. Do not keep an older web/API process writing pins after the daemon takes ownership. New web/API processes do not fall back to legacy pin writes if the daemon is unavailable or outdated. **Restarting sessiond interrupts active sessions and terminals**; schedule this cutover when they can be interrupted.

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
