# PI WEB plugin API

PI WEB plugins are trusted browser-side ES modules that extend the PI WEB UI. They are intended for personal, team, and project-local customization, and simple enough for an LLM to create or modify directly.

Plugins can currently:

- add action-palette commands;
- add workspace tools/panels next to Files, Git, and Terminal;
- add compact workspace-label items in the workspace list, panel header, and status bar;
- call browser APIs and documented PI WEB plugin context helpers;
- read workspace files and start workspace terminal commands through documented helpers;
- serve their own static assets from the plugin directory.

They do **not** run in the session daemon, do not get a server-side hook API, and are not sandboxed.

## Trust model

Plugins run as JavaScript in the browser app. Treat them as trusted code:

- they can call browser APIs;
- they can read workspace files and start terminal commands through documented plugin helpers;
- they can render arbitrary Lit templates/custom elements in plugin contribution areas;
- they should not be installed from untrusted sources.

PI WEB's `/api/...` HTTP and WebSocket endpoints are internal implementation details. Plugin code should use the documented context helpers instead. Daring plugins can still reach private routes or runtime objects because they run in the browser, but those private surfaces are experimental: they may graduate into stable helpers, change shape, or disappear.

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
Keep the plugin compatible with the documented v1 API.
After editing, check the manifest endpoint and browser-console failure cases.
```

## Canonical example: bundled Info plugin

PI WEB ships a real bundled `info` plugin. Use it as the reference example because it is intentionally small while still exercising all core contribution types: an action, a workspace label, and a workspace panel.

Bundled PI WEB plugins are developed as TypeScript in the repository, but their `package.json` metadata still points at built JavaScript because plugins are loaded by the browser as JS ES modules. `npm run dev:web` watches and rebuilds bundled plugin TS into `dist/pi-web-plugins/` during development, and `npm run build` emits the JS before packaging a release.

Source files:

```text
pi-web-plugins/info/package.json
pi-web-plugins/info/pi-web-plugin.ts
```

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
      { "id": "info", "module": "pi-web-plugin.js" }
    ]
  }
}
```

Module shape excerpt:

```js
export default {
  apiVersion: 1,
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

PI WEB also ships an `updates` plugin that demonstrates dynamic `visible` and `badge` callbacks for tabs that only appear when the host has status messages or needs extra install visibility.

## Local plugin usage

This works with the production native-service install. PI WEB discovers plugins from `~/.pi-web/plugins/<plugin-package>/` on the web/API side; no PI WEB rebuild or session-daemon restart is required. If `PI_WEB_DATA_DIR` is set, use `$PI_WEB_DATA_DIR/plugins` instead.

Symlink a plugin folder into PI WEB's local plugin directory:

```bash
mkdir -p ~/.pi-web/plugins
ln -s /path/to/plugin-folder ~/.pi-web/plugins/plugin-id
```

Reload the PI WEB browser tab. PI WEB serves plugin modules with an mtime-based `?v=` cache buster. After editing a plugin, hard reload the browser if you do not see changes.

## Remote machine plugins

When [machine federation](https://pi-web.dev/machines) is enabled, PI WEB also loads discovered plugins from the selected remote machine. Remote plugins are trusted browser-side code like local plugins, but their contributions are machine-scoped:

- actions, workspace panels, and workspace labels only appear while that machine is selected;
- plugin file and terminal helpers run against that machine;
- plugin code is loaded best-effort through the current gateway and cached for the browser page lifetime;
- if the gateway and remote machine both have an enabled plugin with the same original id, `machineSpecific` metadata decides whether the gateway copy is reused or only the selected machine's copy can appear;
- remote theme contributions are ignored for now because themes are app-wide;
- mixed PI WEB versions across federated machines are best-effort and not guaranteed compatible.

Remote plugin enablement is controlled by the remote machine's PI WEB plugin config. To edit or disable a remote machine plugin, open that machine directly or update its config file.

Plugin package metadata may set `machineSpecific: true` when the plugin's meaning is tied to the selected PI WEB machine:

- Omitted or `false`: use the gateway copy when the same plugin id is also present on a remote machine. This is best for portable UI plugins whose helpers already route through the selected machine.
- `true`: the gateway copy only appears for the local machine. When a remote machine is selected, only that remote machine's copy can appear; if the remote machine does not expose the plugin, the plugin is hidden. This is best for plugins that report machine-local PI WEB status or depend on machine-local plugin code.

For portable plugin assets, prefer URLs relative to the plugin module, for example:

```js
const url = new URL("./asset.json", import.meta.url);
```

If a remote plugin constructs absolute asset URLs, it should use the `pluginId` from `activate()` because PI WEB gives remote plugins a gateway-scoped runtime id. Hard-coded `/pi-web-plugins/<original-id>/...` URLs may point at the gateway instead of the remote machine.

## Manage plugins

Open **Settings → Plugins** to review discovered bundled, local, dev, and Pi package plugins for the PI WEB gateway you opened. PI WEB can disable any discovered gateway plugin before the browser imports it. Core app contributions such as the built-in command palette, base workspace tools, and themes are not managed through this plugin list.

Plugin preferences are stored under the top-level `plugins` config key in the PI WEB config file:

```json
{
  "plugins": {
    "workspace-tasks": {
      "enabled": true,
      "settings": {}
    },
    "info": {
      "enabled": false
    }
  }
}
```

Plugins are enabled by default. Set `enabled` to `false` to remove a plugin from `/pi-web-plugins/manifest.json` so the browser will not import or activate it on the next page load. The optional `settings` object is reserved for plugin-specific settings.

After changing plugin enablement, reload the PI WEB browser tab. Already-loaded plugin JavaScript is not unloaded from the current page.

## Built-in plugins

PI WEB ships core, discoverable plugins in the main `@jmfederico/pi-web` npm package. No separate `pi install` step is required: update PI WEB, reload the browser tab, and the bundled plugins appear in `/pi-web-plugins/manifest.json`.

Built-in plugins can be managed from **Settings → Plugins** or with the top-level `plugins` config key.

### Updates

**Plugin id:** `updates`
**What it does:** adds a conditional **Updates** workspace tab with PI WEB update, restart, and installed-service guidance.

Updates is enabled by default. It declares `machineSpecific: true` so the gateway Updates tab only appears for the local machine; while a remote machine is selected, that remote machine's Updates plugin is used if available. To hide it, disable `updates` in **Settings → Plugins** or set:

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

Workspace Tasks is enabled by default. To hide it, disable `workspace-tasks` in **Settings → Plugins** or set:

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
      "id": "docker.start",
      "title": "Start Docker",
      "group": "Docker",
      "description": "Start the local Docker Compose environment.",
      "command": "./docker/scripts/docker-compose-dev up -d"
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

## Discovery and packaging

PI WEB builds the gateway `/pi-web-plugins/manifest.json` from these sources:

1. Bundled plugins in the PI WEB package:

   ```text
   pi-web-plugins/<plugin-package>/
   ```

2. User-local plugins:

   ```text
   ~/.pi-web/plugins/<plugin-package>/
   ```

   Entries may be real directories or symlinks. This is the recommended development workflow.

3. Installed Pi packages that expose PI WEB plugin metadata. Pi packages may be user or project scoped.

Remote machines expose their own manifests through the gateway at `/api/machines/<machine-id>/pi-web-plugins/manifest.json`. Those plugin modules are rewritten to gateway-scoped asset URLs and registered under machine-scoped runtime ids so duplicate plugin ids on different machines do not collide.

Plugin package directory names and plugin ids must be valid identifiers:

```text
^[a-z][a-z0-9.-]*$
```

A package can expose one or more PI WEB plugin modules. There is exactly one supported `package.json` metadata shape:

```json
{
  "private": true,
  "piWeb": {
    "plugins": [
      { "id": "review", "module": "dist/review.js" },
      { "id": "dashboard", "module": "dist/dashboard.js", "machineSpecific": true }
    ]
  }
}
```

Rules:

- `piWeb.plugins` must be an array of objects.
- Each entry must have an explicit `id` and `module`.
- `id` must match `^[a-z][a-z0-9.-]*$`.
- `module` must be a safe relative path inside the plugin package root.
- `machineSpecific` is optional and must be a boolean; omit it for the default portable gateway behavior.
- Duplicate plugin ids are not auto-renamed; later duplicates are skipped.
- Legacy shortcuts such as `piWeb.plugin`, string entries in `piWeb.plugins`, `piWeb.id` fallback ids, and no-`package.json` fallbacks are not supported.

### Manifest and assets

The manifest contains each discovered plugin module:

```json
{
  "plugins": [
    {
      "id": "my-plugin",
      "module": "/pi-web-plugins/my-plugin/pi-web-plugin.js?v=1234567890",
      "source": "local",
      "scope": "local",
      "machineSpecific": false
    }
  ]
}
```

`source` describes where the plugin came from (`bundled`, `local`, or the Pi package source). `scope` is `bundled`, `local`, `user`, or `project`. `machineSpecific` controls whether the gateway copy is valid for remote machines or only each selected machine's own copy can appear.

A plugin can fetch its own static assets with URLs under:

```text
/pi-web-plugins/<plugin-id>/<path-inside-plugin-root>
```

PI WEB prevents asset path traversal outside the plugin root. JavaScript, JSON, CSS, and HTML get appropriate content types; other files are served as octet-stream.

## Plugin module shape

The entry module must default-export a plugin object:

```ts
interface PiWebPlugin {
  apiVersion: 1;
  name: string;
  activate: (context: PluginActivationContext) => PluginActivationResult;
}

interface PluginActivationContext {
  apiVersion: 1;
  pluginId: string;
  html: typeof import("lit").html;
  svg: typeof import("lit").svg;
}

interface PluginActivationResult {
  contributions: PluginContributions;
}
```

Example:

```js
export default {
  apiVersion: 1,
  name: "My Plugin",
  activate: ({ pluginId, html }) => ({
    contributions: {
      actions: [],
      workspacePanels: [],
      workspaceLabels: [],
    },
  }),
};
```

`activate()` is called once when the UI loads the plugin. Keep it cheap: define contributions there, but move expensive or async work into actions, custom elements, or explicit user interactions.

The plugin id comes from `package.json`, not from the JavaScript module. Contribution ids are local to the plugin and PI WEB qualifies them internally as:

```text
<plugin-id>:<local-contribution-id>
```

For example, plugin `info` with action `workspace.show-path` becomes `info:workspace.show-path`.

## Contributions

`activate()` returns a `contributions` object with any combination of these arrays:

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
    id: "workspace.show-path",
    title: "Show Current Workspace Path",
    description: "Display the selected workspace path",
    shortcut: "mod+shift+p",
    group: "Info",
    enabled: (context) => context.state.selectedWorkspace !== undefined,
    run: (context) => {
      window.alert(context.state.selectedWorkspace?.path ?? "No workspace selected");
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
  group?: string;
  enabled?: (context: PluginRuntimeContext) => boolean;
  run: (context: PluginRuntimeContext) => void | Promise<void>;
}
```

Stable runtime context fields:

```ts
interface PluginRuntimeContext {
  state: {
    selectedWorkspace?: Workspace;
    selectedSession?: unknown;
    piWebStatus?: PiWebStatusResponse;
  };
  prompt: PluginPromptEditor;
  openActionPalette: () => void;
  focusPrompt: () => void;
  addProject: () => void | Promise<void>;
  configureAuth: () => void | Promise<void>;
  logoutAuth: () => void | Promise<void>;
  selectWorkspaceTool: (tool: QualifiedContributionId) => void;
  openTerminal: (options?: { terminalId?: string }) => void;
  refreshFiles: () => void | Promise<void>;
  refreshGit: () => void | Promise<void>;
  startSession: () => void | Promise<void>;
  archiveSession: () => void | Promise<void>;
  stopActiveWork: () => void | Promise<void>;
}
```

Notes:

- `state` is a snapshot of current UI state when actions are built.
- The stable state fields are `state.selectedWorkspace`, `state.selectedSession`, and `state.piWebStatus`. `state.piWebStatus` describes the currently selected machine's PI WEB runtime, or the gateway/local runtime when the local machine is selected.
- Other `state` fields may exist at runtime, but they are private PI WEB internals that may graduate into stable helpers, change shape, or disappear.
- `enabled` is evaluated when the action palette asks for actions.
- `selectWorkspaceTool()` expects a qualified panel id such as `my-plugin:workspace.info`.
- `openTerminal()` switches to the built-in terminal panel. Pass `{ terminalId }` to deep-link to a specific terminal.
- Only fields documented here and declared in `plugin-api.d.ts` are stable public plugin API. Anything else is experimental: it may become public API later, change shape, or disappear.

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
    visible: ({ workspace }) => workspace.isGitRepo,
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
  visible?: (context: WorkspacePanelContext) => boolean;
  badge?: (context: WorkspacePanelContext) => string | number | TemplateResult | undefined;
  render: (context: WorkspacePanelContext) => TemplateResult;
}

interface WorkspacePanelContext {
  machine: PluginMachine;
  workspace: Workspace;
  state?: PluginRuntimeState;
  files: {
    readFile(path: string): Promise<FileContentResponse>;
    writeFile(path: string, content: string | Uint8Array, options?: WriteWorkspaceFileOptions): Promise<WriteWorkspaceFileResponse>;
    deleteFile(path: string): Promise<DeleteWorkspaceFileResponse>;
    moveFile(fromPath: string, toPath: string, options?: MoveWorkspaceFileOptions): Promise<MoveWorkspaceFileResponse>;
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

`machine`, `workspace`, `files`, `prompt`, `terminal`, and `host` are documented as stable for panel callbacks. The `files` helper supports `readFile`, `writeFile`, `deleteFile`, and `moveFile` — see [Reading workspace files](#reading-workspace-files) and [Writing workspace files](#writing-workspace-files). The `prompt` helper supports panel interactions that insert workspace context into the current prompt — see [Prompt editor API](#prompt-editor-api). Use `terminal.open()` to switch to the built-in terminal panel; pass `{ terminalId }` to deep-link to a specific terminal. Call `host.requestRender()` when async plugin-owned state changes should make PI WEB re-evaluate panel callbacks such as `badge`, `visible`, or `render`.

For compatibility, PI WEB still provides the old `context.openTerminal()` workspace-panel helper at runtime. It is deprecated, intentionally omitted from the public TypeScript declarations, and planned for removal in v2. Existing JavaScript plugins keep working, while typed plugins should migrate to `context.terminal.open()`.

Useful workspace and machine shapes:

```ts
interface PluginMachine {
  id: string;
  name: string;
  kind: "local" | "remote";
}

interface Workspace {
  id: string;
  projectId: string;
  path: string;
  label: string;
  branch?: string;
  isMain: boolean;
  isGitRepo: boolean;
  isGitWorktree: boolean;
}
```

`machine.id` is included in panel contexts so plugins can keep caches machine-scoped. Do not infer the selected machine from global browser state.

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
    writeFile(path: string, content: string | Uint8Array, options?: WriteWorkspaceFileOptions): Promise<WriteWorkspaceFileResponse>;
    deleteFile(path: string): Promise<DeleteWorkspaceFileResponse>;
    moveFile(fromPath: string, toPath: string, options?: MoveWorkspaceFileOptions): Promise<MoveWorkspaceFileResponse>;
  };
  host: {
    requestRender(): void;
  };
}
```

`machine`, `workspace`, `files`, and `host` are documented as stable for label callbacks. The `files` helper supports `readFile`, `writeFile`, `deleteFile`, and `moveFile` — see [Reading workspace files](#reading-workspace-files) and [Writing workspace files](#writing-workspace-files). Include `machine.id` in any label caches that depend on workspace data. Call `host.requestRender()` when async plugin-owned state changes should make PI WEB re-evaluate label `visible` or `items` callbacks.

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
    this.textContent = value?.branch === "main" ? "main" : "branch";
  }
}

if (!customElements.get("my-workspace-badge")) {
  customElements.define("my-workspace-badge", MyWorkspaceBadge);
}

export default {
  apiVersion: 1,
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
  return `${machine.id}:${workspace.id}:docker/development.be-go.local.env`;
}

function loadEnvLabel(context) {
  const key = envKey(context.machine, context.workspace);
  const cached = envCache.get(key);
  if (cached !== undefined) return cached;

  const pending = { status: "loading", label: undefined };
  envCache.set(key, pending);
  context.files.readFile("docker/development.be-go.local.env")
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

The file response includes fields such as `path`, `content`, `truncated`, and `binary`. Be careful with sensitive files such as `.env`: plugins are trusted browser code, and file contents are exposed to the plugin.

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

Plugins are trusted browser code. File writes go through the same path safety validation as reads — paths are resolved and checked to stay inside the workspace root.

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

PI WEB's `/api/...` HTTP and WebSocket routes and runtime-only fields are private implementation details. They exist because plugins are trusted browser code, and because some capabilities may be evaluated there before they are designed as stable helpers.

That is allowed, but outside the v1 compatibility promise: URLs, response shapes, runtime fields, and machine-federation routing may graduate into stable APIs, change shape, or disappear. The stable public plugin API is only the documented helpers and declarations in `plugin-api.d.ts`. Prefer those whenever they exist; if you rely on private surfaces, keep the dependency local to the plugin and expect to revisit it after PI WEB upgrades.

## Async data and caching

PI WEB does not provide a plugin cache/invalidation framework. Keep host callbacks cheap:

- simple contributions should be synchronous and cheap;
- expensive or async work should live inside the plugin;
- custom elements in `type: "render"` label items or panels are a good place to own async loading;
- dedupe async reads/commands and avoid unbounded polling;
- clean up intervals/event listeners in custom elements' `disconnectedCallback()`.

## Agent implementation checklist

If you are an AI agent building or editing a PI WEB plugin, follow this checklist:

1. Create or update a plugin folder with `package.json` and a JavaScript module such as `pi-web-plugin.js`.
2. Use the single supported package metadata shape: `piWeb.plugins` array with `{ id, module, machineSpecific? }` entries.
3. Default-export `{ apiVersion: 1, name, activate }` from the module.
4. Return `{ contributions: { actions, workspacePanels, workspaceLabels } }` from `activate()`.
5. Use ids matching `^[a-z][a-z0-9.-]*$`.
6. Use the activation context's `html` function for Lit templates.
7. Keep `activate()` synchronous and cheap; return contribution definitions only.
8. Add actions for command-palette operations.
9. Add workspace panels for larger workspace UI.
10. Add workspace labels for compact inline metadata.
11. Return arrays from workspace label `items()`; return an empty array to render nothing.
12. Use documented context helpers first: `files`, `terminal`, `host.requestRender`, `workspace`, `machine`, `state.selectedWorkspace`, `state.selectedSession`, `state.piWebStatus`, and `prompt`.
13. Do not fetch PI WEB `/api/...` endpoints directly unless you intentionally accept private API churn; prefer documented helpers.
14. Treat plugins as trusted code and avoid reading or displaying secrets unless intentional.
15. After local edits, tell the user to hard reload the browser and check the console for plugin errors.

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

- invalid plugin id or contribution id;
- missing default export;
- missing `apiVersion: 1`, `name`, or `activate` function;
- missing `package.json` or incorrect `piWeb.plugins` metadata;
- legacy shortcuts such as `piWeb.plugin`, string plugin entries, or no-`package.json` fallback;
- duplicate plugin ids; later duplicates are skipped rather than renamed;
- entry module path points outside the plugin root or file does not exist;
- browser cache not refreshed after editing;
- plugin directory is not under `~/.pi-web/plugins` or symlinked there;
- plugin throws during module import, `activate()`, `visible()`, `enabled()`, `items()`, or `render()`; check the browser console.
