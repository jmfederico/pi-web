# PI WEB configuration reference

PI WEB configuration covers the machine-local and project-local settings you usually need: the web/API bind address, trusted development-host settings, UI preferences, desired plugin enablement/settings, server-plugin recovery, file-explorer path access, manual upload defaults, upload limits, the Pi agent state directory, and session-daemon tools.

Settings below describe available choices, scope, limitations, and restart requirements. An HTML version is available at <https://pi-web.dev/config>.

## Config files

PI WEB uses two config files:

- **Global PI WEB config:** `$PI_WEB_CONFIG`, or `$XDG_CONFIG_HOME/pi-web/config.json`, or `~/.config/pi-web/config.json`.
- **Project-local PI WEB config:** `<project>/.pi-web/config.json` for commit-able project settings.

Each PI WEB machine has its own config. When using Fleet/machine federation, Settings uses the selected machine for config that affects work running there: session daemon tools, desired PI WEB plugin enablement/settings, external path access, and upload defaults. Gateway/browser-only settings stay local to the gateway: the default theme, keyboard shortcuts, remote machine registry/tokens, and gateway host/port/allowed-hosts.

Pi package settings are separate from PI WEB config. They live in Pi's package-manager settings on the target machine and are managed by Pi (`pi install`, `pi remove`, `pi update`) or **Settings → Pi packages**. In a federated setup, **Settings → Pi packages** targets the currently selected machine. The PI WEB `plugins` config key controls desired enablement/settings for discovered browser-only, server-only, and dual-entry PI WEB plugins on that machine; it does not install, remove, or update Pi packages.

### Custom config paths in installed services

`start`, `restart`, and `doctor` use the config path saved in the installed services for readiness checks unless the caller supplies a nonempty `PI_WEB_CONFIG` override. `doctor` checks the managed setup, not every custom runtime environment.

| Situation | Behavior / action |
| --- | --- |
| Use the installed config | Run `pi-web start`, `pi-web restart`, or `pi-web doctor` normally. |
| Override the path for one command | Supply a nonempty `PI_WEB_CONFIG` when invoking that command. This does not rewrite service definitions. |
| Change the managed service config path | Run `pi-web install --config /path/to/config.json` to regenerate both web/API and sessiond service definitions. |
| Upgrade from an installation that set the path only for the web service | Rerun that same install command so both services use the same config. |
| systemd cannot verify the loaded service config | The command stops. Reinstall services with the intended config path and reload the service manager before retrying. |
| systemd uses `EnvironmentFile=` | Accepted with a warning; config-path overrides in that file cannot be verified. |
| launchd has an old config path or a label loaded from another plist | `start` and `doctor` fail. `restart` reloads installed plists and can repair stale loaded state. |

## Startup model and thinking defaults

Open the model or thinking-level selector and click a row’s star under **New session default** to save it for new sessions. A filled star marks the saved default. Clicking the option itself changes only the current session; setting the default leaves the current session unchanged.

Defaults are saved in Pi’s global `settings.json` on the selected session’s machine (`~/.pi/agent/settings.json` by default), using `defaultProvider`, `defaultModel`, and `defaultThinkingLevel`. They apply to new sessions without restarting. Project `.pi/settings.json` overrides, explicit startup choices, and per-model thinking settings still take precedence. A default model must be enabled; otherwise startup falls back to the first enabled model. Resumed sessions keep their saved model and thinking level.

## Reverse-proxy deployment paths

The deployment path is not a PI WEB config-file key or environment setting. The published client is portable: one build works at `/` and at canonical trailing-slash prefixes such as `/ai/` or `/test/ai/`.

For a nested deployment, redirect the slashless prefix to the trailing-slash URL, strip the prefix before forwarding to PI WEB, and proxy authenticated HTTP and WebSocket traffic through the same location. Relative browser and PWA URLs then stay within that prefix. See the [reverse proxy installation guide](https://pi-web.dev/install#reverse-proxy-prefix) for a complete Nginx example.

## Precedence and reloads

Machine-global runtime values are resolved as:

```text
defaults → global config file → environment overrides
```

Supported project-local settings are then applied for that project's workspaces. For upload and prompt-attachment defaults, `<project>/.pi-web/config.json` overrides the global value.

Environment overrides include `PI_WEB_HOST`, `PI_WEB_PORT` / `PORT`, `PI_WEB_ALLOWED_HOSTS`, `PI_WEB_MAX_UPLOAD_BYTES`, `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, `PI_WEB_SPAWN_SESSIONS`, `PI_WEB_SUBSESSIONS`, `PI_WEB_ASK_USER`, and `PI_WEB_ENVIRONMENT_FACTS`.

Process restarts depend on the key:

- `host` / `port`: restart the gateway web/API service or process.
- `maxUploadBytes`: restart both the web/API process and the session daemon on that machine.
- `spawnSessions` / `subsessions` / `askUser` / `extensionDialogsTimeoutMs` / `environmentFacts`: restart the session daemon on that machine.
- `sessionNaming`: saved model, token budget, thinking level, and timeout apply to the next naming request without a restart. Existing names and in-progress naming requests are unchanged.
- `pathAccess`: applies on the next request; existing file views may need a browser refresh.
- `uploads.defaultFolder`: applies to newly opened Files upload dialogs and new direct drag/drop batches after config/workspace refresh.
- `attachments.defaultFolder`: applies to new prompt-attachment saves after config/workspace refresh.
- `plugins`: browser-only changes need a tab reload. Server-backed enablement, settings, or package changes require a manual session-daemon restart, then a tab reload. See [Project plugin settings](#project-plugin-settings).
- `serverPlugins.safeStart`: persistent offline recovery state applied before server-plugin discovery/import on the next sessiond start; use the `pi-web plugins safe-start ...` CLI rather than hand-editing it.
- Pi package changes: use `/reload` in each idle session for ordinary extensions, skills, templates, and themes. Packages containing server plugins require a manual session-daemon restart and browser reload. Global provider registration or connection changes also require a daemon restart; model-list-only updates do not. See [Pi extension provider baseline](#pi-extension-provider-baseline).
- `shortcuts` / `defaultStreamingBehavior`: saved settings apply in the browser after config refresh/save; no service restart.
- `defaultTheme`: applies after settings save or browser config refresh when the browser has no local theme override; no service restart.

### Streaming send default

In **Settings → Keyboard shortcuts → Send while agent is running**, choose **Steer** (the default) to deliver input before the next model call, or **Follow-up** to queue it until the current response finishes. This changes only the keyboard shortcut, not the chat buttons. During compaction, messages queue as follow-ups.

The global gateway key is `defaultStreamingBehavior`: `steer` or `followUp`. It is not project-local and needs no service restart.

## Global config example

```json
{
  "host": "127.0.0.1",
  "port": 8504,
  "defaultTheme": { "themeId": "themes:pi-web-dark", "auto": true },
  "defaultStreamingBehavior": "steer",
  "pathAccess": {
    "allowedPaths": ["~/SDKs", "/opt/reference"]
  },
  "uploads": {
    "defaultFolder": ".pi-web/uploads"
  },
  "attachments": {
    "defaultFolder": ".pi-web/attachments"
  },
  "maxUploadBytes": 67108864,
  "spawnSessions": true,
  "subsessions": true,
  "askUser": true,
  "extensionDialogsTimeoutMs": 300000,
  "plugins": {
    "workspace-tasks": { "enabled": true },
    "updates": { "enabled": true },
    "info": { "enabled": false }
  },
  "shortcuts": {
    "core:view.chat": "mod+1",
    "core:session.stop": null
  }
}
```

## Project-local config

Project-local config lives at `<project>/.pi-web/config.json`. Use it for settings that should follow a repository.

```json
{
  "version": 1,
  "pathAccess": {
    "allowedPaths": ["~/SDKs", "/opt/reference"]
  },
  "uploads": {
    "defaultFolder": "manual/uploads"
  },
  "attachments": {
    "defaultFolder": "prompt-attachments"
  }
}
```

Project-local `pathAccess.allowedPaths` entries are merged after the global list and deduplicated. Paths must still be host-absolute or `~`-prefixed; relative roots are not supported.

Project-local `uploads.defaultFolder` overrides the global upload destination for workspaces in that project, and project-local `attachments.defaultFolder` overrides the global prompt-attachment destination the same way. These defaults also apply when accessing the project through Fleet.

Project-local `plugins.<id>.settings` supplies overrides for server plugins that support project settings, including Git. Only settings are allowed here: `plugins.<id>.enabled` is not supported; plugin enablement stays global. See [Project plugin settings](#project-plugin-settings) for merge and restart rules.

Plugins may also own separate project files, such as `.pi-web/tasks.json` for the built-in Workspace Tasks plugin.

PI WEB also honors one optional project hook; see [Worktree pre-remove hook](#worktree-pre-remove-hook).

## Worktree pre-remove hook

Use an executable `.pi-web/hooks/worktree-pre-remove` script to stop containers or release workspace resources before removal. Place it relative to the workspace where the removal command runs—normally the project's main workspace.

| Item | Behavior |
| --- | --- |
| Argument | One absolute path: the workspace being removed. |
| Success (`0`) | Continue with workspace removal. |
| Failure (nonzero) | Block removal; keep the workspace on disk. |
| Missing / not executable | Skip the hook and run removal normally. |
| Output | Visible in the workspace deletion terminal run. |

## Configuration matrix

Rows with JSON key `—` are runtime-only environment variables, not config-file keys. `Global` means machine-global. In Settings, selected-machine-safe global keys (`pathAccess`, `uploads`, `attachments`, `maxUploadBytes`, `spawnSessions`, `subsessions`, `askUser`, and `plugins`) are edited for the selected machine; gateway host/port/allowed-hosts, keyboard shortcuts, and machine registry/tokens stay local.

| Config | JSON key | Env var | Scope | Project-local behavior | Applies / restart |
| --- | --- | --- | --- | --- | --- |
| **Config-file keys** |  |  |  |  |  |
| Web/API bind host | `host` | `PI_WEB_HOST` | Global | Not supported locally | Restart web/API |
| Web/API port | `port` | `PI_WEB_PORT`, `PORT` | Global | Not supported locally | Restart web/API |
| Dev-server allowed hosts | `allowedHosts` | `PI_WEB_ALLOWED_HOSTS` | Global | Not supported locally | Restart dev web/UI |
| External filesystem roots | `pathAccess.allowedPaths` | — | Global + project | **Merges**: global roots first, then project roots; duplicates removed | Next file request; refresh existing views if needed |
| Manual file upload default folder | `uploads.defaultFolder` | — | Global + project | **Overrides**: project value wins for workspaces in that project; otherwise global/default applies | New Upload dialogs and direct drag/drop batches after config/workspace refresh |
| Prompt attachment default folder | `attachments.defaultFolder` | — | Global + project | **Overrides**: project value wins for workspaces in that project; otherwise global/default applies | New prompt-attachment saves after config/workspace refresh |
| Upload/body limit | `maxUploadBytes` | `PI_WEB_MAX_UPLOAD_BYTES` | Global | Not supported locally | Restart web/API and session daemon on that machine |
| Agent can spawn sessions | `spawnSessions` | `PI_WEB_SPAWN_SESSIONS` | Global/session daemon | Not supported locally | Restart session daemon on that machine |
| Tracked subsessions | `subsessions` | `PI_WEB_SUBSESSIONS` | Global/session daemon | Not supported locally; also requires `spawnSessions` | Restart session daemon on that machine |
| Agent can post question forms | `askUser` | `PI_WEB_ASK_USER` | Global/session daemon | Not supported locally | Restart session daemon on that machine |
| Session naming | `sessionNaming.model`, `sessionNaming.maxTokens`, `sessionNaming.thinkingLevel`, `sessionNaming.timeoutMs` | — | Global/session daemon | Not supported locally | Next naming request; no restart |
| Extension dialog auto-cancel timeout | `extensionDialogsTimeoutMs` | — | Global/session daemon | Not supported locally | Restart session daemon on that machine |
| Session environment facts | `environmentFacts` | `PI_WEB_ENVIRONMENT_FACTS` | Global/session daemon | Not supported locally | Restart session daemon on that machine |
| PI WEB plugin desired enablement | `plugins.<id>.enabled` | — | Global | Not supported locally | Browser-only: reload tab. Server-backed: manually restart sessiond, then reload tab |
| PI WEB plugin settings | `plugins.<id>.settings` | — | Global + project for server plugins supporting project settings | **Merges top-level setting keys** over global settings; no project enablement | Browser-only global settings: reload tab. Server-backed global/project settings: manually restart sessiond, then reload tab |
| Git worktree discovery hooks | `plugins.git.settings.workspaceDiscoveryHooks` | — | Global + project | Project boolean overrides global; default `true` | Manually restart session daemon; browser reload alone does not apply changes |
| Server-plugin safe start | `serverPlugins.safeStart` | — | Global/offline recovery | Not supported locally; manage with `pi-web plugins safe-start ...` | Applied before discovery/import on next sessiond start |
| Default browser theme | `defaultTheme.themeId`, `defaultTheme.auto` | — | Gateway global | Not supported locally; device choices take precedence | Settings save / browser config refresh; no restart |
| Streaming send default | `defaultStreamingBehavior` | — | Global gateway | Not supported locally | Applies after settings save/config refresh; defaults to `steer` |
| Keyboard shortcuts | `shortcuts.<actionId>` | — | Global | Not supported locally | Applies after settings save/config refresh |
| Project config version | `version` | — | Project | Project-local only; must be `1` when present | Next project-config read |
| **Runtime-only environment variables** |  |  |  |  |  |
| Global config file path | — | `PI_WEB_CONFIG` (`XDG_CONFIG_HOME` affects the default path) | Process/env | Selects the global config file; not a project config | Restart services/processes after changing env |
| JavaScript runtime | — | `PI_WEB_RUNTIME` | Process/env, inherited by PI WEB commands and services | Not supported locally | Restart the services or processes whose runtime should change |
| Managed data directory | — | `PI_WEB_DATA_DIR` | Process/env | Not supported locally | Restart web/API and session daemon |
| Git hook instance namespace | — | `PI_WEB_INSTANCE_NAMESPACE` | Session daemon env | Not supported locally | Restart session daemon; see [running multiple instances](#git-instance-namespace) |
| Session daemon socket | — | `PI_WEB_SESSIOND_SOCKET` | Web/API + session daemon env | Not supported locally | Restart daemon and web/API; both must match |
| Session daemon TCP port | — | `PI_WEB_SESSIOND_PORT` | Session daemon env | Not supported locally | Restart session daemon; set `PI_WEB_SESSIOND_URL` for web/API too |
| Session daemon TCP host | — | `PI_WEB_SESSIOND_HOST` | Session daemon env | Not supported locally | Restart session daemon |
| Web-to-daemon URL | — | `PI_WEB_SESSIOND_URL` | Web/API env | Not supported locally | Restart web/API |
| Projects storage file | — | `PI_WEB_PROJECTS_FILE` | Web/API + session daemon env | Not supported locally | Restart services; advanced state override |
| Remote machines storage file | — | `PI_WEB_MACHINES_FILE` | Web/API env | Not supported locally | Restart web/API; advanced state override |
| Agent state directory | — | `PI_CODING_AGENT_DIR` | Session daemon env | Not supported locally | Restart session daemon on that machine; affects auth, models, settings, sessions, Pi packages, and Pi-package-backed PI WEB plugins |
| Agent session storage directory | — | `PI_CODING_AGENT_SESSION_DIR` | Session daemon env | Not supported locally | Restart session daemon on that machine; env-only session storage override |
| Skip update checks | — | `PI_WEB_SKIP_VERSION_CHECK`, `PI_WEB_OFFLINE`, `PI_SKIP_VERSION_CHECK`, `PI_OFFLINE` | Web/API env | Not supported locally | Restart web/API after env changes |
| Offline mode | — | `PI_WEB_OFFLINE`, `PI_OFFLINE` | Web/API + session daemon env | Not supported locally | Restart session daemon and web/API after env changes; also disables the [background model catalog refresh](#background-model-catalog-refresh) |

## Key details

### JavaScript runtime

PI WEB runs on Node.js (default) or Bun (opt-in, experimental, community best-effort support). Every PI WEB command (`pi-web`, `pi-web-server`, `pi-web-sessiond`) starts through a launcher that chooses the interpreter when the command runs, so `PI_WEB_RUNTIME` is read from the environment of the process being started — there is no config key and nothing to rebuild.

| Value | Behavior |
| --- | --- |
| unset or `auto` | Node.js is the default runtime. Bun is selected only when Node.js is not usable (e.g. no usable `node` in PATH or install locations). Capability wins over availability: the launcher never starts PI WEB on a Bun without the native terminal API — the command fails with instructions (`bun upgrade`, or reinstall with npm). |
| `bun` | Hard requirement. Fails loudly when Bun is missing or cannot boot PI WEB, instead of silently running on Node.js. |
| `node` | Never select Bun, even when it is installed. |
| anything else | The command exits with an error naming the variable and the accepted values. |

When a runtime is not on the service `PATH` — user services start with the service manager's environment, not your interactive shell — the launcher also looks in the usual install locations, in this order after `PATH`: Node.js at `/usr/bin/node`, `/usr/local/bin/node`, `/opt/homebrew/bin/node`, and Bun at `~/.bun/bin/bun`, `/usr/local/bin/bun`, `/opt/homebrew/bin/bun`, `/usr/bin/bun`. Version-manager directories (nvm, fnm, asdf, mise) are deliberately not among those locations, so a runtime that only exists inside a version manager has to reach the service through its `PATH`. `PI_WEB_RUNTIME` always overrides the auto-detection.

Auto-detection needs no configuration, so this variable is only for pinning a runtime. Set it wherever the process gets its environment: export it before starting PI WEB manually, or add an `Environment=` drop-in (`systemctl --user edit --full pi-web pi-web-sessiond`) or a `Environment=`/`EnvironmentFile=` key in the launchd plist for user services, then restart. `pi-web doctor` and `pi-web version` report the runtime each process actually selected, and `pi-web doctor` says which terminal backend that implies.

### Managed data directory

`PI_WEB_DATA_DIR` sets the root for PI WEB-managed runtime state and defaults to `~/.pi-web`. Unless a more specific path override is configured, PI WEB stores its project and machine registries, locally discovered plugins, default session-daemon socket, and session archives beneath this root.

Each data directory is independent: after pointing PI WEB at a new root, it starts there with empty registries and no session archives. To carry session archives over, stop PI WEB, then copy `archived-sessions.json` and the `archived-sessions/` directory from the old data directory into the new one before starting it again.

Only one live session daemon may use a data directory. For a second instance, set a distinct `PI_WEB_DATA_DIR`, `PI_WEB_SESSIOND_SOCKET` (or `PI_WEB_SESSIOND_PORT` / `PI_WEB_SESSIOND_HOST`), and `PI_WEB_PORT`. Stale ownership markers are normally recovered automatically. If startup still refuses, verify the named owner is no longer running before deleting `sessiond-owner.json` as the error suggests.

This setting does not change the PI WEB config file selected by `PI_WEB_CONFIG` or Pi-owned state such as the active session files selected by `PI_CODING_AGENT_SESSION_DIR`.

### Agent process environment

Agent shells, terminals, and child sessions inherit the daemon environment, including its Pi state paths. `NODE_ENV` and `PORT` are removed so they do not interfere with development commands.

`PI_WEB_SESSION=1` marks nested processes. Inherited `PI_WEB_*` values still point to the hosting instance. Use a separate data directory, daemon endpoint, and web port for a second instance. Do not restart the hosting session daemon from inside an active session you need to preserve.

`environmentFacts` includes nesting and deployment guidance in session system prompts by default. Set it to `false`, or use `PI_WEB_ENVIRONMENT_FACTS=false`, to omit that guidance. Restart sessiond after changing it.

### External path access

`pathAccess.allowedPaths` grants PI WEB's file explorer and absolute `@` path completions access to specific filesystem roots outside the current workspace.

By default, workspace-relative file reads stay inside the workspace and absolute paths are denied. Add only roots you trust PI WEB to list and read through the browser UI.

Accepted root forms:

- Unix absolute paths: `/opt/reference`
- Home-relative paths: `~/SDKs`
- Windows absolute paths on Windows hosts: `C:\Users\dev\SDKs`

Roots must be existing directories. Symlink escapes outside allowed roots are rejected.

In **Settings → General**, external filesystem roots are saved on the selected machine. Gateway host, port, and allowed-hosts fields stay on the gateway config.

This is not a sandbox for the underlying Pi Coding Agent or your OS user. It only controls PI WEB UI/API file exposure outside a workspace.

### Manual upload defaults

The Files panel can upload one or more files in two ways:

- Drop files onto the Files panel to upload immediately to the workspace-effective default folder.
- Use the toolbar **Upload** button to open the review dialog, edit the destination, and opt into upload options.

`uploads.defaultFolder` sets the workspace-effective default destination. The built-in default is `.pi-web/uploads`; a global config value applies to every project unless `<project>/.pi-web/config.json` sets a project-local override.

```json
{
  "uploads": {
    "defaultFolder": "manual/uploads"
  }
}
```

The value must be a non-empty workspace-relative folder, without absolute paths or `..` traversal. In the upload dialog only, clearing the destination uploads that batch to the workspace root.

Uploads stay inside the workspace, create parent folders by default, and do not overwrite existing files unless you enable overwrite in the review dialog. Direct drag/drop never overwrites. Check the upload progress UI for completion, conflicts, and errors.

In Fleet, Settings saves the global upload default on the selected machine; the Files panel uses that project's effective destination.

The per-request size limit is still controlled by `maxUploadBytes` / `PI_WEB_MAX_UPLOAD_BYTES` on the machine serving the upload.

### Prompt attachment defaults

When the chat composer has pending attachments, its delivery selector offers **Save to …**: the attachments are written into a workspace folder and the prompt references the saved paths, instead of attaching the content inline.

`attachments.defaultFolder` sets the workspace-effective save destination shown in that selector. The built-in default is `.pi-web/attachments`; a global config value applies to every project unless `<project>/.pi-web/config.json` sets a project-local override.

```json
{
  "attachments": {
    "defaultFolder": "prompt-attachments"
  }
}
```

The value must be a non-empty workspace-relative folder, without absolute paths or `..` traversal. Saved attachments stay inside the workspace. An explicit per-request folder overrides the configured default.

In Fleet, Settings saves the global attachment default on the selected machine; the composer uses that project's effective destination.

### Agent state directory

PI WEB runs every session on its bundled Pi SDK. `pi-web doctor` and the status/update flow probe the `pi` command on the machine's `PATH`.

`PI_CODING_AGENT_DIR` selects the Pi agent state directory used for auth providers, models, settings, sessions, Pi packages, and Pi-package-backed PI WEB plugin discovery. It defaults to Pi's own default, `~/.pi/agent`. `PI_CODING_AGENT_SESSION_DIR` overrides session storage separately from the state directory. Both are environment-only; there is no config-file key.

```sh
# Session daemon environment
PI_CODING_AGENT_DIR=/opt/pi-profiles/lab
PI_CODING_AGENT_SESSION_DIR=/opt/pi-profiles/lab-sessions
```

The directory must use the data layout supported by the bundled Pi SDK; PI WEB does not load or convert incompatible formats, migrate profile data, or repartition PI WEB-managed archives when the directory changes.

Changing either path requires a session-daemon restart on the target machine; restarting only web/API does not apply it. Sessions, terminals, and package operations use the daemon's active paths. If those paths are unavailable, profile-dependent operations are unavailable too.

### Pi extension provider baseline

Model providers are shared across all sessions on a machine. PI WEB loads them when the session daemon starts, using Pi's built-in providers, environment credentials, the active agent directory's `models.json`, and globally installed Pi extensions/packages. PI WEB workspace plugins are separate; see the [plugin guide](https://pi-web.dev/plugins).

Provider connection settings stay fixed until the daemon restarts. Project extensions and `/reload` cannot add, replace, or remove providers. Other Pi extension features continue to load and reload normally.

Pi virtual models are unsupported, including from global extensions. Disable the extension's virtual-model feature and select a physical model instead; restarting the daemon does not enable virtual models.

#### Model list refresh for a known provider

An extension may refresh an existing provider's **model list** without a restart, provided all other provider settings remain unchanged. Changes to credentials, connection settings, or provider implementation require a daemon restart. Accepted model-list updates are available to sessions immediately.

Model lists are shared across the machine, not isolated per project. If two workspaces update the same provider's list, the last update wins. Pi extensions remain trusted code, and model entries can override provider connection details.

#### Provider decisions in the daemon log

Provider decisions are recorded in daemon logs, not browser notifications. Entries omit provider configuration and credentials. See [provider extension troubleshooting](https://pi-web.dev/faq#provider-extension-no-effect) for ignored changes.

This prevents accidental provider, configuration, or credential contamination between projects; it is not a security boundary because Pi extensions remain trusted daemon code.

Configure providers before the daemon starts: use the active agent directory's `models.json`, or install the Pi extension globally in that agent directory. Project Pi extensions and project-level `models.json` files cannot add providers to PI WEB's shared baseline. After updating PI WEB—or after installing, removing, or updating a global Pi extension that registers providers—manually restart `pi-web-sessiond.service` (`systemctl --user restart pi-web-sessiond`). Restarting only the web/API service and running `/reload` do not rebuild the baseline.

### Background model catalog refresh

PI WEB refreshes provider model catalogs automatically in the background and after login or logout. Reopen the model selector to see new models. Failed refreshes keep the last successful catalog and report problems in daemon logs. A refresh can briefly delay session startup; the activity line reports when model lists are refreshing.

Set `PI_WEB_OFFLINE` or `PI_OFFLINE` in the web/API and session-daemon environment and restart both to disable release checks and catalog network refresh. Sessions then use stored catalogs. `PI_WEB_SKIP_VERSION_CHECK` and `PI_SKIP_VERSION_CHECK` disable only release checks.

Unset or clear these flags to turn them off: any nonempty value, including `false` or `0`, enables them.

### Project trust for project-local resources

PI WEB always honors Pi's project-trust settings before loading a workspace's project-local `.pi/` resources — `.pi/extensions/*`, the `packages` declared in `.pi/settings.json`, and the other `.pi/` settings and resources. There is no opt-out config key: trust applies at every session start, the way `pi` itself applies it.

A project-local `.pi/extension` is arbitrary code that runs inside the agent process on every session for that workspace, so an untrusted workspace must not load one.

Trust is resolved the way `pi` resolves it with no trust prompt to show:

- A workspace with no trust-requiring `.pi/` resources is always loaded (there is nothing to gate).
- User/global extensions (loaded before the decision, exactly as `pi` does) may decide trust through the `project_trust` extension event, and may request `remember` to persist their decision to the agent directory's `trust.json`. When the event decides, it wins — the same order `pi` uses.
- Otherwise a saved decision in the agent directory's `trust.json` (from the Pi CLI's trust prompt, the workspace trust toggle, or a `remember`-ing extension) wins.
- Otherwise the agent's `defaultProjectTrust` setting decides: `always` loads the project resources, and `never` skips them. `ask` skips them too, because PI WEB has no browser trust prompt yet and a non-interactive `pi` also treats `ask` as untrusted.

This mirrors the Pi CLI: with `defaultProjectTrust: "never"`, an opened workspace's `.pi/` extensions and packages are ignored rather than loaded silently.

### Session daemon tools

`spawnSessions` controls whether agents receive the `spawn_session` tool. It defaults to `true`; set it to `false` if you do not want an agent to start independent PI WEB sessions.

`subsessions` controls whether agents receive the tracked-subsession tools: `spawn_subsession`, `list_subsessions`, `check_subsession`, `read_subsession`, and `yield_to_subsessions`. It defaults to `true` and also requires `spawnSessions` to be enabled.

Independent sessions run in a workspace of the same project without returning output to their parent. Tracked subsessions run in the parent's working directory and return results automatically; the parent can keep working or wait for them. Delivered results are not automatically repeated, but remain available for review.

Agent-created tracked subsessions are collapsed under their parent. Use **Agent subsessions** to expand them. User-created forks and clones, unknown-origin sessions, children without an available parent, and independent sessions remain visible.

New sessions inherit the parent's model and thinking level unless another model is requested, for example with a `#provider/model-id` prompt reference. Thinking levels are limited to what the chosen model supports.

In **Settings → Session daemon**, these keys are saved on the selected machine. Restart the session daemon on that machine after changing them.

#### `askUser` and `ask_user`

`askUser` controls whether agents receive the core `ask_user` tool. It defaults to `true`; set it to `false`, or set `PI_WEB_ASK_USER=false`, to remove the tool. The environment override accepts `0|1|true|false` and takes precedence over the config file.

Use **Settings → Session daemon → Allow agents to ask questions** to change `askUser` on the selected machine. An environment override makes the toggle read-only.

Agents can ask questions with choices or free-text answers. You may leave questions unanswered; partial submissions are confirmed before sending. Answering or skipping resumes the agent.

Forms are saved in the conversation and survive restarts. Only a form at the end of the active conversation is open; answering, skipping, or sending another message closes it. Earlier forms remain expandable for read-only review. Returning the conversation to a question reopens it; archived conversations remain read-only.

Restart the session daemon after changing `askUser` or after upgrading PI WEB to a version that introduces this tool. For the systemd user service, run `systemctl --user restart pi-web-sessiond`.

### Session naming

Use **Settings → Session daemon → Session naming** on the selected machine to choose a naming model, generation budget, thinking level, and timeout. The naming model button opens a searchable list of that machine's available models; choose **Use session model** to remove the model override. No active session is required. Refresh settings to reload the list after configuring a provider. By default, naming uses the session's model and **24 tokens**, including for reasoning models. Naming does not change the conversation's model.

These settings are optional machine-global overrides:

```json
{
  "sessionNaming": {
    "model": "provider/model-id",
    "maxTokens": 2048,
    "thinkingLevel": "off",
    "timeoutMs": 90000
  }
}
```

`model` must identify a model in that machine's model catalog, using its configured provider and credentials. Omit it to use the session model. `maxTokens` must be a positive integer; omit it to restore 24. This is a generation budget, not title length; providers may count reasoning against it. Project-local overrides are not supported.

`thinkingLevel` defaults to `minimal`. Supported values are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. Choose `off` to disable optional reasoning where supported, while keeping a positive token budget for the title. Models and providers may limit or map thinking levels; `off` cannot disable mandatory reasoning. Naming settings do not change the conversation's thinking level.

`timeoutMs` sets the total naming-request timeout, including gateway queueing, model loading, and generation. It defaults to `10000` (10 seconds). Use a positive integer in milliseconds, up to `2147483647`; Settings displays seconds. Increase it for local models that need time to load. Clearing the UI field restores 10 seconds. This is a total wall-time limit, not an idle timeout, and has no environment-variable override.

Saved model, budget, thinking-level, and timeout changes apply to the next naming request without a restart or reload. Existing names and in-progress naming requests are unchanged. Agent permission changes in the same panel still require a session-daemon restart. Naming failures use the existing first-message fallback and are recorded in daemon logs.

### Extension dialogs

Pi extensions can show confirmation, selection, and text-input dialogs inline in the session transcript, including while a session starts or a tool runs. Dialog support is always on; there is no enable flag. See [Pi extension dialogs in PI WEB](https://pi-web.dev/plugins#pi-extension-dialogs) for details.

`extensionDialogsTimeoutMs` cancels unanswered extension dialogs after the configured interval. It defaults to `300000` (5 minutes); set it to `0` to wait forever. If the extension sets its own timeout, the sooner deadline applies.

The key is edited directly in the global config file. Restart the session daemon after changing it — for the systemd user service, run `systemctl --user restart pi-web-sessiond`.

### PI WEB plugin config and recovery

The `plugins` key controls desired enablement and JSON settings for PI WEB browser-only, server-only, and dual-entry plugins on the machine whose config you are editing. It does not install, remove, or update Pi packages; use **Settings → Pi packages** or Pi's package manager for package operations.

```json
{
  "plugins": {
    "git": { "enabled": true, "settings": {} },
    "workspace-tasks": { "enabled": true },
    "updates": { "enabled": false }
  }
}
```

Plugins are enabled by default unless their package metadata declares `defaultEnabled: false`, as Captain's Log does. Explicit `plugins.<id>.enabled` config overrides the package default. `plugins.<id>.enabled: false` hides a browser-only entry on the next page load. For a server-backed entry, desired disablement takes effect on the next sessiond start; its paired browser entry continues to follow the still-active server entry until that restart. The bundled `pi-web.terminal` plugin is required during normal startup: ordinary config cannot disable it, and Settings renders it non-editable. Global server settings are captured at daemon startup; diagnostics do not expose their values.

#### Project plugin settings

Supporting server plugins, including Git, accept `plugins.<id>.settings` in `<project>/.pi-web/config.json` at the registered project's path, not in individual worktrees. Project top-level keys override global settings; nested objects are replaced rather than deep-merged. Plugin enablement stays global.

After changing global or project server-plugin settings, manually restart the target session daemon, then reload the browser. A browser reload, web/API restart, or Pi's `/reload` is insufficient. The daemon restart can interrupt sessions and terminals; finish important work and restart from outside its hosted sessions.

#### Git worktree discovery hooks

`plugins.git.settings.workspaceDiscoveryHooks` enables automatic worktree discovery on supported Git builds (Git 2.54+). It defaults to `true` and preserves existing hooks. See [Automatic Git worktree discovery](https://pi-web.dev/plugins#automatic-git-worktree-discovery).

To opt out, merge this into machine config or the registered project's `.pi-web/config.json`:

```json
{
  "plugins": {
    "git": {
      "settings": {
        "workspaceDiscoveryHooks": false
      }
    }
  }
}
```

Project values override the machine default. Changes require a manual session-daemon restart. Disabling hooks leaves the Git plugin and ordinary workspace discovery available.

<a id="git-instance-namespace"></a>
#### Git worktree discovery when running multiple instances

Most installations need no changes. Docker dev automatically uses `dev` to keep its worktree notifications separate from production; production keeps its existing behavior.

For a custom setup where instances share a PI WEB data directory, set `PI_WEB_INSTANCE_NAMESPACE=dev` in the dev session daemon's environment and leave it unset in production. Use a different name for each additional instance: 1–32 letters, digits, underscores or hyphens, starting with a letter or digit.

Restart the affected daemon to apply the change; for Docker, recreate the affected containers. This interrupts active sessions and terminals, so finish important work first. This setting separates Git notifications only; separate data directories are still recommended for independent instances.

Keep the name stable. If you need to retire a name, disable [discovery hooks](#git-worktree-discovery-hooks) while still using that name before switching, so the old notifications are removed.

#### Desired versus active plugin state

Saving `plugins` config or replacing package files changes **desired** state, not the running server code. A disabled server plugin and its paired UI may remain active until the session daemon restarts. PI WEB withholds a paired UI when its package/settings no longer match the running server code or the server plugin is unhealthy or incompatible.

**Settings → PI WEB plugins** distinguishes desired from active state and shows failures, compatibility problems, safe mode, and required restarts. If the daemon is unavailable, desired config may still be editable, but active state is unavailable.

In Fleet, this panel targets the selected machine. Unsupported or incompatible remote plugin features report errors rather than using gateway config or code.

Mixed-version plugin operation is unsupported in either upgrade order. Remote plugins, including Git, may be unavailable or return `404`. Upgrade gateway and target together, restart their updated web/API processes and the target session daemon, then reload the browser. Other selected-machine features may report their own compatibility errors.

Apply changes in this order:

1. Install or update the package on the target machine.
2. Save desired enablement/settings.
3. For a browser-only plugin, reload the browser tab.
4. For a server-backed plugin, manually restart the target session daemon, wait for it, then reload the browser tab.

> **Manual restart warning:** for the native user service, run `systemctl --user restart pi-web-sessiond` (unit `pi-web-sessiond.service`). Restarting sessiond may interrupt active sessions and runtime ownership. A browser reload, web/UI autoreload, restarting only web/API, and Pi's `/reload` do not activate server-plugin state.

#### Offline disable and safe start

The recovery CLI edits global config offline. It does not contact sessiond, discover packages, import plugin modules, or include machine credentials. Run it directly on the affected machine; for a custom service config, add `--config /path/to/config.json`.

```bash
pi-web plugins disable <plugin-id> --restart
pi-web plugins safe-start show
pi-web plugins safe-start set bundled-only --restart
pi-web plugins safe-start set none --restart
pi-web plugins safe-start clear --restart
```

`disable` persists `plugins.<id>.enabled: false`, but rejects required `pi-web.terminal` with no-plugin safe-start recovery guidance. Safe-start state is stored under `serverPlugins.safeStart`: `bundled-only` filters external server packages before discovery/import while still requiring bundled Terminal, whereas `none` imports no server plugins and retains the kernel project-folder and diagnosis/settings surfaces without Terminal or Terminal-backed commands. `clear` restores ordinary configured discovery on the next start. An unsupported `serverPlugins.safeStart` shape or value in otherwise valid JSON fails closed as effective `none`; use `safe-start show`, then `set` or `clear`, to repair it offline.

`--restart` performs a restart only for a recognized safe installed-service plan; otherwise it prints manual instructions. The config mutation is durable before PI WEB attempts the restart. If the service-manager command itself fails, restart sessiond manually.

Ordinary import/activation/start/health failures are quarantined when possible, but server plugins are trusted in-process code, share sessiond's event loop, and are not crash-isolated. `bundled-only` bypasses external plugin failures; `none` is the emergency level that also bypasses bundled server plugins. Setting, clearing, or disabling takes effect for server code only after sessiond restarts, and that restart may interrupt active sessions/runtime ownership.

### Theme default and device choices

In **Settings → General → Theme**, choose a theme and **Auto** mode, then:

- **Use on this device** saves a choice for this browser only.
- **Set as default** shares a default without replacing existing device choices.
- **Use the default** clears this browser's override.

Device choices take precedence over the configured default, then the built-in default (PI WEB Dark with Auto on). Auto follows the device's light/dark preference for paired themes; unpaired themes stay selected. Unavailable themes temporarily fall back to Classic without erasing the choice.

The default belongs to the gateway, not a project or remote machine. Changes apply after settings save or browser config refresh, with no service restart.

```json
{ "defaultTheme": { "themeId": "themes:pi-web-dark", "auto": true } }
```

Use a theme contribution ID rather than a display name. Built-in IDs are `themes:pi-web-dark`, `themes:pi-web-light`, and `themes:classic`.

### Shortcut config

Shortcut values are keyed by action id. Values are shortcut strings such as `mod+k`, `g p`, or `shift+enter`; `null` disables that action's shortcut.

```json
{
  "shortcuts": {
    "core:view.chat": "mod+1",
    "core:session.stop": null,
    "app.navigation.focus-projects": "g p",
    "composer.send.desktop": "mod+enter",
    "composer.send.mobile": "shift+enter"
  }
}
```

Prefer Settings → Keyboard for editing, recording, disabling, or resetting shortcuts. `mod` accepts Ctrl or ⌘. Browsers and operating systems may reserve some combinations.

App shortcuts support single keys or sequences. Avoid conflicting bindings and browser-reserved combinations. Unmodified and Shift-only shortcuts do not start while editing text.

Composer send bindings accept one key combination, not sequences. Desktop defaults to Enter; touch or narrow screens default to Shift+Enter. The touch binding (`composer.send.mobile`) applies with a coarse primary pointer or a viewport at most 760px wide. Unassigned Enter/Shift+Enter insert newlines; Enter accepts a selected completion first. `null` disables keyboard submission, not the send button.

Existing browser-local Enter preferences remain the fallback until a composer binding is configured. Reset restores that fallback. New bindings are saved in gateway config.

## Prompt completions

The chat composer opens completion menus on three trigger characters:

- `/` at the very start of the draft completes session commands.
- `@` completes file paths: `@` for tracked files, `@ ` (at, then space) or `!@` for all files. Picking one inserts an `@path` reference into the draft, quoted automatically when the path contains spaces.
- `#` completes the models available to the session, filtered case-insensitively as you type (at most 12 entries). Picking one inserts a `#provider/model-id` reference into the draft, which tells agents the request should run on that model — for example as the `model` parameter of `spawn_session`.

## Optional completion tools

File and path `@` completions work without extra tools. If `fzf` is available on the PI WEB server's `PATH`, PI WEB uses it to improve completion filtering/ranking; otherwise it falls back to built-in ranking.
