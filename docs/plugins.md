# Pi Web plugin API

Pi Web plugins are trusted browser-side ES modules that extend the Pi Web UI. They are intended for personal, team, and project-local customization, and simple enough for an LLM to create or modify directly.

Plugins can currently:

- add action-palette commands;
- add workspace tools/panels next to Files, Git, and Terminal;
- add compact workspace-label items in the workspace list, panel header, and status bar;
- call browser APIs and Pi Web HTTP/WebSocket APIs available to the current browser session;
- serve their own static assets from the plugin directory.

They do **not** run in the session daemon, do not get a server-side hook API, and are not sandboxed.

## Trust model

Plugins run as JavaScript in the browser app. Treat them as trusted code:

- they can call browser APIs;
- they can `fetch()` Pi Web API endpoints using the current browser access;
- they can read workspace files through Pi Web's file endpoints if the UI can read them;
- they can render arbitrary Lit templates/custom elements in plugin contribution areas;
- they should not be installed from untrusted sources.

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
Build a Pi Web plugin for this project.
Goal: <describe the UI behavior>.
Before coding, read the Pi Web plugin docs:
https://pi-web.dev/plugins.html
Full API reference:
https://pi-web.dev/plugins.md
Create it as a local plugin under ~/.pi-web/plugins/<plugin-id>.
Use the appropriate extension points from the docs.
Validate by checking /pi-web-plugins/manifest.json and explain how to reload/debug it.
Do not modify Pi Web itself.
```

Copy-paste prompt for modifying a plugin:

```text
Improve the Pi Web plugin at <path>.
Before coding, read the Pi Web plugin docs:
https://pi-web.dev/plugins.html
Full API reference:
https://pi-web.dev/plugins.md
Keep the plugin compatible with the documented v1 API.
After editing, check the manifest endpoint and browser-console failure cases.
```

## Canonical example: bundled Info plugin

Pi Web ships a real bundled `info` plugin. Use it as the reference example because it is intentionally small while still exercising all core contribution types: an action, a workspace label, and a workspace panel.

Files:

```text
pi-web-plugins/info/package.json
pi-web-plugins/info/pi-web-plugin.js
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
  activate: ({ html }) => ({
    contributions: {
      actions: [/* action definitions */],
      workspaceLabels: [/* compact label definitions */],
      workspacePanels: [/* panel definitions using html */],
    },
  }),
};
```

When copying the Info plugin, choose a new plugin id so it does not conflict with the bundled `info` plugin.

Pi Web also ships a `pi-web` status plugin that demonstrates dynamic `visible` and `badge` callbacks for tabs that only appear when the host has status messages or needs extra install visibility.

## Local plugin usage

This works with the production npm/systemd install. Pi Web discovers plugins from `~/.pi-web/plugins/<plugin-package>/` on the web/API side; no Pi Web rebuild or session-daemon restart is required. If `PI_WEB_DATA_DIR` is set, use `$PI_WEB_DATA_DIR/plugins` instead.

Symlink a plugin folder into Pi Web's local plugin directory:

```bash
mkdir -p ~/.pi-web/plugins
ln -s /path/to/plugin-folder ~/.pi-web/plugins/plugin-id
```

Reload the Pi Web browser tab. Pi Web serves plugin modules with an mtime-based `?v=` cache buster. After editing a plugin, hard reload the browser if you do not see changes.

## Discovery and packaging

Pi Web builds `/pi-web-plugins/manifest.json` from these sources:

1. Bundled plugins in the Pi Web package:

   ```text
   pi-web-plugins/<plugin-package>/
   ```

2. User-local plugins:

   ```text
   ~/.pi-web/plugins/<plugin-package>/
   ```

   Entries may be real directories or symlinks. This is the recommended development workflow.

3. Installed Pi packages that expose Pi Web plugin metadata. Pi packages may be user or project scoped.

Plugin package directory names and plugin ids must be valid identifiers:

```text
^[a-z][a-z0-9.-]*$
```

A package can expose one or more Pi Web plugin modules. There is exactly one supported `package.json` metadata shape:

```json
{
  "private": true,
  "piWeb": {
    "plugins": [
      { "id": "review", "module": "dist/review.js" },
      { "id": "dashboard", "module": "dist/dashboard.js" }
    ]
  }
}
```

Rules:

- `piWeb.plugins` must be an array of objects.
- Each entry must have an explicit `id` and `module`.
- `id` must match `^[a-z][a-z0-9.-]*$`.
- `module` must be a safe relative path inside the plugin package root.
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
      "scope": "local"
    }
  ]
}
```

`source` describes where the plugin came from (`bundled`, `local`, or the Pi package source). `scope` is `bundled`, `local`, `user`, or `project`.

A plugin can fetch its own static assets with URLs under:

```text
/pi-web-plugins/<plugin-id>/<path-inside-plugin-root>
```

Pi Web prevents asset path traversal outside the plugin root. JavaScript, JSON, CSS, and HTML get appropriate content types; other files are served as octet-stream.

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

The plugin id comes from `package.json`, not from the JavaScript module. Contribution ids are local to the plugin and Pi Web qualifies them internally as:

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
  };
  openActionPalette: () => void;
  focusPrompt: () => void;
  addProject: () => void | Promise<void>;
  configureAuth: () => void | Promise<void>;
  logoutAuth: () => void | Promise<void>;
  selectWorkspaceTool: (tool: QualifiedContributionId) => void;
  refreshFiles: () => void | Promise<void>;
  refreshGit: () => void | Promise<void>;
  startSession: () => void | Promise<void>;
  archiveSession: () => void | Promise<void>;
  stopActiveWork: () => void | Promise<void>;
}
```

Notes:

- `state` is a snapshot of current UI state when actions are built.
- Only `state.selectedWorkspace` and `state.selectedSession` are documented as stable for plugin authors.
- Other `state` fields may exist at runtime, but they are Pi Web internals and can change quickly.
- `enabled` is evaluated when the action palette asks for actions.
- `selectWorkspaceTool()` expects a qualified panel id such as `my-plugin:workspace.info`.
- `shortcut` is displayed/handled the same way app actions are; choose shortcuts carefully to avoid conflicts.

### Workspace panels

Workspace panels add tools next to built-in workspace tools. They render inside the workspace side panel on desktop and as mobile tabs on smaller screens.

```js
workspacePanels: [
  {
    id: "workspace.info",
    title: "Info",
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
  order?: number;
  visible?: (context: { workspace: Workspace }) => boolean;
  badge?: (context: { workspace: Workspace }) => string | number | TemplateResult | undefined;
  render: (context: { workspace: Workspace }) => TemplateResult;
}
```

Only `workspace` is documented as stable for panel callbacks. Other fields may exist at runtime, but they are Pi Web internals and can change quickly. If a panel needs file, git, or session data, prefer explicit `fetch()` calls and keep them isolated.

Useful workspace shape:

```ts
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

Use existing classes such as `toolbar`, `viewer`, `empty`, and `muted` for panel content when possible. Do not assume a panel owns the whole page; keep layout contained.

### Workspace labels

Workspace labels add compact inline metadata wherever Pi Web displays a workspace label: workspace list, workspace panel header, and status bar.

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
  workspace: Workspace;
}
```

Only `workspace` is documented as stable for label callbacks. Other fields may exist at runtime, but they are Pi Web internals and can change quickly.

Items are sorted by `order` and then id. Return an empty array to render nothing.

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

Pi Web renders the anchor and adds safe defaults such as `rel="noopener noreferrer"` for `_blank` links. `javascript:` and `data:` links are rendered as plain text instead of links.

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

Plugins can use existing Pi Web endpoints. For example, to read a file in a workspace:

```js
async function readWorkspaceFile(workspace, path) {
  const url =
    `/api/projects/${encodeURIComponent(workspace.projectId)}` +
    `/workspaces/${encodeURIComponent(workspace.id)}` +
    `/file?path=${encodeURIComponent(path)}`;

  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Failed to read ${path}: ${response.status}`);
  return await response.json();
}
```

The file response includes fields such as `path`, `content`, `truncated`, and `binary`, but endpoint response shapes are private Pi Web implementation details for now and can change between releases.

Be careful with sensitive files such as `.env`: plugins are trusted browser code, and file contents are exposed to the plugin.

## Other useful Pi Web APIs

Plugins may call any endpoint available to the browser, but these HTTP endpoints are considered private Pi Web implementation APIs for now. They can change quickly between releases. Prefer plugin runtime context helpers when they cover the interaction, and keep any direct HTTP usage small and isolated.

Common read endpoints:

```text
GET /api/projects
GET /api/projects/:projectId/workspaces
GET /api/projects/:projectId/workspaces/:workspaceId/tree?path=<dir>
GET /api/projects/:projectId/workspaces/:workspaceId/file?path=<file>
GET /api/projects/:projectId/workspaces/:workspaceId/git/status
GET /api/projects/:projectId/workspaces/:workspaceId/git/diff?path=<file>&staged=true|false
GET /api/sessions?cwd=<workspace-path>
GET /api/sessions/:sessionId/status
GET /api/sessions/:sessionId/messages?before=<cursor>&limit=<n>
```

Common write/action endpoints:

```text
POST /api/sessions                 { "cwd": "/path/to/workspace" }
POST /api/sessions/:id/prompt      { "text": "...", "streamingBehavior": "steer" | "followUp" }
POST /api/sessions/:id/shell       { "text": "..." }
POST /api/sessions/:id/stop
POST /api/sessions/:id/archive
POST /api/sessions/:id/restore
```

Prefer runtime context helpers (`startSession`, `stopActiveWork`, `refreshFiles`, `refreshGit`, etc.) when they cover the interaction. Use direct HTTP calls only for plugin-specific data or behavior, and expect to update them as Pi Web evolves.

## Async data and caching

Pi Web does not provide a plugin cache/invalidation framework. Keep host callbacks cheap:

- simple contributions should be synchronous and cheap;
- expensive or async work should live inside the plugin;
- custom elements in `type: "render"` label items or panels are a good place to own async loading;
- dedupe fetches and avoid unbounded polling;
- clean up intervals/event listeners in custom elements' `disconnectedCallback()`.

## Agent implementation checklist

If you are an AI agent building or editing a Pi Web plugin, follow this checklist:

1. Create or update a plugin folder with `package.json` and `pi-web-plugin.js`.
2. Use the single supported package metadata shape: `piWeb.plugins` array with `{ id, module }` entries.
3. Default-export `{ apiVersion: 1, name, activate }` from the module.
4. Return `{ contributions: { actions, workspacePanels, workspaceLabels } }` from `activate()`.
5. Use ids matching `^[a-z][a-z0-9.-]*$`.
6. Use the activation context's `html` function for Lit templates.
7. Keep `activate()` synchronous and cheap; return contribution definitions only.
8. Add actions for command-palette operations.
9. Add workspace panels for larger workspace UI.
10. Add workspace labels for compact inline metadata.
11. Return arrays from workspace label `items()`; return an empty array to render nothing.
12. Use stable context fields first; only `workspace`, `state.selectedWorkspace`, and `state.selectedSession` are documented as stable.
13. Use `fetch()` against Pi Web APIs only for plugin-specific behavior not provided by runtime context helpers, and isolate those calls because HTTP endpoints are private for now.
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
