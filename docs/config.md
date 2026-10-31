# PI WEB configuration reference

PI WEB configuration covers the machine-local and project-local settings you usually need: the web/API bind address, trusted development-host settings, UI preferences, desired plugin enablement/settings, server-plugin recovery, file-explorer path access, manual upload defaults, upload limits, the Pi agent state directory, and session-daemon tools.

Settings below describe available choices, scope, limitations, and restart requirements. An HTML version is available at <https://pi-web.dev/config>.

## Config files

PI WEB separates deployment defaults from writable overrides:

- **Optional deployment defaults:** `PI_WEB_DEFAULTS_CONFIG` selects a read-only JSON file with the same schema as global config. There is no default path. An explicitly selected missing, malformed, or invalid file fails loading/startup rather than falling back. PI WEB never saves to this file.
- **Writable global PI WEB config:** `$PI_WEB_CONFIG`, or `$XDG_CONFIG_HOME/pi-web/config.json`, or `~/.config/pi-web/config.json`. Its path and save behavior are unchanged; a missing file means no saved overrides. It must not select the deployment-defaults file.
- **Project-local PI WEB config:** `<project>/.pi-web/config.json` for commit-able, supported project settings.

For managed deployments, mount the defaults file read-only and set `PI_WEB_DEFAULTS_CONFIG` in both the web/API and session-daemon environments. Keep `PI_WEB_CONFIG` writable and separate. Deployment defaults supply starting values, not locks; use environment overrides for enforced policy.

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

## Machine name

Set `installationName` in the machine's config, enforce it with `PI_WEB_INSTALLATION_NAME`, or edit **Settings → General → Machine name** for the selected machine:

```json
{ "installationName": "Build lab" }
```

The name replaces the local machine's label and remains visible when there is only one machine, in browsers and installed PWAs. Empty or unset names use **PI-WEB**. Names are trimmed and limited to 120 characters without control characters. This setting is machine-global, not project-local, and needs no restart; reload other open windows to refresh their labels.

Federated gateways use the remote machine's reported name unless you set a **Local display name**. Clear that field to use the remote machine's name again. Existing registry names remain overrides. An unavailable or older remote without a reported name uses **PI-WEB**; a previously discovered name is retained while the gateway process stays running.

The PWA manifest uses the gateway's installation name, with **(dev)** appended for development deployments. Changing the selected remote machine does not rename the installed gateway app. Browsers control when existing launcher names update; reinstall the PWA if its old name remains.

## Startup model and thinking defaults

Open the model or thinking-level selector and click a row’s star under **New session default** to save it for new sessions. A filled star marks the saved default. Clicking the option itself changes only the current session; setting the default leaves the current session unchanged.

Defaults are saved in Pi’s global `settings.json` on the selected session’s machine (`~/.pi/agent/settings.json` by default), using `defaultProvider`, `defaultModel`, and `defaultThinkingLevel`. They apply to new sessions without restarting. Project `.pi/settings.json` overrides, explicit startup choices, and per-model thinking settings still take precedence. A default model must be enabled; otherwise startup falls back to the first enabled model. Resumed sessions keep their saved model and thinking level.

## Reverse-proxy deployment paths

The deployment path is not a PI WEB config-file key or environment setting. The published client is portable: one build works at `/` and at canonical trailing-slash prefixes such as `/ai/` or `/test/ai/`.

For a nested deployment, redirect the slashless prefix to the trailing-slash URL, strip the prefix before forwarding to PI WEB, and proxy authenticated HTTP and WebSocket traffic through the same location. Relative browser and PWA URLs then stay within that prefix. See the [reverse proxy installation guide](https://pi-web.dev/install#reverse-proxy-prefix) for a complete Nginx example.

## Precedence and reloads

Highest priority first, for layers applicable to that setting:

```text
enforced environment > browser-local choice > supported project override
  > writable global config > deployment defaults > built-in defaults
```

Browser-local choices apply to colour theme, file icon theme, and localization. Project config participates only for supported keys. Environment policy wins over both; it is not a default that projects or browsers can override.

Each declared setting replaces its lower-priority value, including arrays and dictionaries; there is no general recursive merge. The schema declares these namespace leaves: `uploads.defaultFolder`, `attachments.defaultFolder`, `sessionArchive.directory`, `pathAccess.allowedPaths`, and `defaultLocalization.language`, `.formatLocale`, `.timeZone`, `.hourCycle`. Each inherits independently across deployment defaults, writable config, applicable project config, and environment policy. An empty namespace `{}` contributes no overrides; missing leaves inherit.

Each plugin's `enabled` and each top-level `plugins.<id>.settings.<key>` also resolve independently. An individual array/dictionary-valued setting still replaces entirely, including an explicit empty value. `defaultTheme` remains one atomic, coherent preference; `shortcuts` and deprecated `agent` are also atomic. JSON depth alone does not define a setting. Path additions have the separate composition rules below.

### Environment policy

Every nondeprecated runtime core config key has an environment override named `PI_WEB_<SNAKE_CASE_KEY>`. Strings and numbers use scalar values; object/array settings use JSON. See the matrix below for names. Offline plugin recovery state is managed separately by the recovery CLI. For example:

```sh
PI_WEB_INSTALLATION_NAME='Build lab'
PI_WEB_BASE_PATHS='["/opt/reference"]'
PI_WEB_UPLOADS='{"defaultFolder":"manual/uploads"}'
PI_WEB_DEFAULT_LOCALIZATION='{"timeZone":"UTC"}'
PI_WEB_PLUGINS='{"git":{"settings":{"workspaceDiscoveryHooks":false}}}'
```

Container JSON variables keep their existing names: `PI_WEB_UPLOADS`, `PI_WEB_ATTACHMENTS`, `PI_WEB_SESSION_NAMING`, `PI_WEB_SESSION_ARCHIVE`, `PI_WEB_PATH_ACCESS`, and `PI_WEB_DEFAULT_LOCALIZATION`. Only supplied namespace leaves are enforced, including `pathAccess.allowedPaths` and plugin leaves; `{}` enforces none. Atomic settings lock the whole value. `PI_WEB_PORT` retains the `PORT` fallback; a nonempty `PI_WEB_SESSION_ARCHIVE_DIR` alias wins over `PI_WEB_SESSION_ARCHIVE` JSON. `PI_WEB_ALLOWED_HOSTS` accepts JSON `true` or a string array, plus legacy `true`/comma-separated hosts. Allowing all hosts is unsafe for an exposed development server; prefer an explicit list.

Boolean environment inputs accept only `true`/`false` (case-insensitive) or `1`/`0`. Invalid supplied policy values fail startup instead of being ignored. Unknown fields in declared core containers are errors, including misspellings in `pathAccess`, `uploads`, and `attachments`. Plugin environment envelopes accept only `enabled` and `settings`; keys inside `settings` remain plugin-owned. Unset a variable to remove enforcement; empty strings are not a general reset syntax. Legacy empty host, port, allowed-hosts, upload-limit, and archive-directory overrides remain ignored. Runtime-only variables have their own contracts; see offline flags below. Markers such as `PI_WEB_SESSION` are not config policy.

### Sources, saves, and resets

Settings identifies inherited sources and environment-enforced values. Enforced controls are read-only. Where a saved override has a **Reset saved override** control, resetting deletes that override and exposes the next applicable layer; it does not copy today's effective default into the writable file. Loading deployment defaults keeps them separate from writable overrides. Theme and localization enforcement temporarily masks saved browser choices without erasing them; removing policy restores those choices.

The config API returns `config` (writable overrides), `effectiveConfig`, optional `defaultsPath` / `defaultsConfig`, `configSources` (JSON-pointer identifiers mapped to `defaults`, `config`, or the controlling environment variable), and `enforcedSettings` (identifiers mapped to environment variables). Source and enforcement pointers address declared leaves, such as `/defaultLocalization/language` and `/pathAccess/allowedPaths`; the archive alias reports `/sessionArchive/directory`. Missing source entries inherit built-in/feature defaults; this is machine metadata, not browser/project provenance.

Use `PATCH /api/config` for explicit updates, or `PATCH /api/machines/<machineId>/config` for selected-machine-supported keys (`local` selects the gateway machine). The body has optional `set` (config-shaped values) and `unset` (JSON-pointer strings):

```json
{
  "set": { "quietMode": true },
  "unset": ["/defaultTheme", "/defaultLocalization/timeZone", "/plugins/git/settings/workspaceDiscoveryHooks"]
}
```

`unset` accepts known leaf pointers such as `/defaultLocalization/language`, `/uploads/defaultFolder`, and `/pathAccess/allowedPaths`, as well as container resets such as `/defaultLocalization`. Atomic settings reset at their top-level pointer, such as `/defaultTheme`. UI container-group resets remove only unlocked saved leaves in one request. An API container reset overlapping any enforced leaf is rejected, preserving saved choices hidden by enforcement. Escape `~` as `~0` and `/` as `~1` within pointer segments: a plugin setting named `a/b~c` uses `/plugins/git/settings/a~1b~0c`. Conflicting set/unset targets and changes to enforced settings are rejected. There is no null reset sentinel: `null` retains its schema-defined meaning, such as disabling a shortcut. Existing `PUT` endpoints remain available. They retain replacement semantics for unenforced settings, but omitted enforced settings preserve their hidden saved values. Supplying a different saved value for an enforced setting is rejected; unchanged saved values may round-trip. This protection also applies when no saved override exists: a legacy save cannot create one for an enforced setting. Federated protection requires the target to report enforcement metadata; upgrade older peers before relying on it.

### When changes apply

Process restarts depend on the key:

- `host` / `port`: restart the gateway web/API service or process.
- `maxUploadBytes`: restart both the web/API process and the session daemon on that machine.
- `spawnSessions` / `subsessions` / `sessionMessages` / `askUser` / `extensionDialogsTimeoutMs` / `environmentFacts`: restart the session daemon on that machine.
- `sessionArchive.directory`: restart the session daemon on that machine; changes only the destination for new archives.
- Session naming is owned by a removable Pi package. Its config file is read for each new title. Old core file values are migrated and removed when configuration is loaded; they are no longer core settings. See [Session naming](#session-naming).
- `pathAccess`: applies on the next request; existing file views may need a browser refresh.
- `uploads.defaultFolder`: applies to newly opened Files upload dialogs and new direct drag/drop batches after config/workspace refresh.
- `attachments.defaultFolder`: applies to new prompt-attachment saves after config/workspace refresh.
- `plugins`: browser-only changes need a tab reload. Server-backed enablement, settings, or package changes require a manual session-daemon restart, then a tab reload. See [Project plugin settings](#project-plugin-settings).
- `serverPlugins.safeStart`: persistent offline recovery state applied before server-plugin discovery/import on the next sessiond start; use the `pi-web plugins safe-start ...` CLI rather than hand-editing it.
- Pi package changes: use `/reload` in each idle session for ordinary extensions, skills, templates, and themes. Packages containing server plugins require a manual session-daemon restart and browser reload. Global provider registration or connection changes also require a daemon restart; model-list-only updates do not. See [Pi extension provider baseline](#pi-extension-provider-baseline).
- `shortcuts` / `defaultStreamingBehavior` / `quietMode`: saved settings apply in the browser after config refresh/save; no service restart.
- `defaultTheme`: applies after settings save or browser config refresh when the browser inherits it or environment policy enforces it; no service restart.

### Localization defaults

Set `defaultLocalization` in the gateway's global config to supply browser defaults:

```json
{ "defaultLocalization": { "language": "en", "formatLocale": "de-DE", "timeZone": "Europe/Berlin", "hourCycle": "h23" } }
```

All fields are optional and independent. `language` requests installed translations, with English fallback. `formatLocale` is a standard locale tag. `timeZone` is validated by native `Intl`; omitted zones use the device zone. `hourCycle` accepts `h11`, `h12`, `h23`, or `h24`; omission uses regional conventions. Omitted language/format locale use the browser language. No currency or zone is inferred from language. Development pseudo locales cannot be configured here.

Saved browser preferences override defaults independently per field unless that field is enforced by `PI_WEB_DEFAULT_LOCALIZATION`. Settings → General → Language and region saves only explicit browser-local choices, not this server setting. Empty Regional format and Time zone fields inherit the configured gateway value, if any, otherwise the browser’s value; the source and value are shown below each field. Clear a field and apply to resume inheritance for that field, or choose **Use defaults** to clear all local overrides. Existing saved snapshots remain explicit overrides until cleared. Reload the tab after changing config defaults; no service restart is needed. This key is gateway-only, not selected-machine or project-local. Omitted fields inherit lower layers; `{}` adds no overrides, so use reset/unset to remove saved fields.

### Streaming send default

In **Settings → Keyboard shortcuts → Send while agent is running**, choose **Steer** (the default) to deliver input before the next model call, or **Follow-up** to queue it until the current response finishes. This changes only the keyboard shortcut, not the chat buttons. During compaction, messages queue as follow-ups.

The global gateway key is `defaultStreamingBehavior`: `steer` or `followUp`. It is not project-local and needs no service restart.

### Quiet mode

Quiet mode collapses agent activity in the transcript. Tool calls, thinking, results, and skill loads stay in the conversation but start inside one expandable **live events** / **events** summary line instead of being expanded while the agent works. Conversation text, question forms, and tool output images are unchanged.

Turn it on in **Settings → General → Chat display → Quiet mode**. It is off by default. The global gateway key is `quietMode`; it is not project-local and needs no service restart. Devices share the gateway setting, so it is not a per-browser preference.

```json
{ "quietMode": true }
```

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
  "sessionArchive": {
    "directory": "/srv/pi-web/archives"
  },
  "spawnSessions": true,
  "subsessions": true,
  "sessionMessages": true,
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

Project-local `pathAccess.allowedPaths` entries are added after global `basePaths` and global additions, then deduplicated. `basePaths` is global-only. A supplied `allowedPaths` leaf in `PI_WEB_PATH_ACCESS` replaces the additions from both writable global and project config; an empty JSON container `{}` enforces nothing; enforced `PI_WEB_BASE_PATHS` alone leaves those additions available. Paths must still be host-absolute or `~`-prefixed; relative roots are not supported.

Unless environment-enforced, project-local `uploads.defaultFolder` overrides the global upload destination for workspaces in that project, and project-local `attachments.defaultFolder` overrides the global prompt-attachment destination the same way. Empty project `uploads: {}` or `attachments: {}` contributes no override: the folder inherits from writable machine config, deployment defaults, or built-ins. These defaults also apply when accessing the project through Fleet.

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

Rows with JSON key `—` are runtime-only environment variables, not config-file keys. `Global` means machine-global. Machine name, file access/defaults, session-daemon settings, and plugins target the selected machine where exposed in Settings; UI preferences and gateway networking stay on the gateway. Environment overrides remain highest priority even where the table lists project or browser participation.

| Config | JSON key | Env var | Scope | Project-local behavior | Applies / restart |
| --- | --- | --- | --- | --- | --- |
| **Config-file keys** |  |  |  |  |  |
| Machine name | `installationName` | `PI_WEB_INSTALLATION_NAME` | Global | Not supported locally | Config refresh; reload other windows |
| Web/API bind host | `host` | `PI_WEB_HOST` | Global | Not supported locally | Restart web/API |
| Web/API port | `port` | `PI_WEB_PORT`, `PORT` | Global | Not supported locally | Restart web/API |
| Dev-server allowed hosts | `allowedHosts` | `PI_WEB_ALLOWED_HOSTS` | Global | Not supported locally | Restart dev web/UI |
| Base filesystem roots | `basePaths` | `PI_WEB_BASE_PATHS` (JSON array) | Global | Not supported locally; default `[]` | Next file request |
| Additional filesystem roots | `pathAccess.allowedPaths` | `PI_WEB_PATH_ACCESS` (JSON object) | Global + project | **Adds** after base roots; global then project, deduplicated; env replaces effective additions | Next file request; refresh existing views if needed |
| Manual file upload default folder | `uploads.defaultFolder` | `PI_WEB_UPLOADS` (JSON object) | Global + project | **Overrides**: project value wins for workspaces in that project; otherwise global/default applies | New Upload dialogs and direct drag/drop batches after config/workspace refresh |
| Prompt attachment default folder | `attachments.defaultFolder` | `PI_WEB_ATTACHMENTS` (JSON object) | Global + project | **Overrides**: project value wins for workspaces in that project; otherwise global/default applies | New prompt-attachment saves after config/workspace refresh |
| Upload/body limit | `maxUploadBytes` | `PI_WEB_MAX_UPLOAD_BYTES` | Global | Not supported locally | Restart web/API and session daemon on that machine |
| Agent can spawn sessions | `spawnSessions` | `PI_WEB_SPAWN_SESSIONS` | Global/session daemon | Not supported locally | Restart session daemon on that machine |
| Tracked subsessions | `subsessions` | `PI_WEB_SUBSESSIONS` | Global/session daemon | Not supported locally; also requires `spawnSessions` | Restart session daemon on that machine |
| Session messaging | `sessionMessages` | `PI_WEB_SESSION_MESSAGES` | Global/session daemon | Not supported locally; independent of spawning flags | Restart session daemon on that machine |
| Agent can post question forms | `askUser` | `PI_WEB_ASK_USER` | Global/session daemon | Not supported locally | Restart session daemon on that machine |
| Session archive directory | `sessionArchive.directory` | `PI_WEB_SESSION_ARCHIVE` (JSON object), `PI_WEB_SESSION_ARCHIVE_DIR` alias | Global/session daemon | Not supported locally | Restart session daemon on that machine; new archives only |
| Extension dialog auto-cancel timeout | `extensionDialogsTimeoutMs` | `PI_WEB_EXTENSION_DIALOGS_TIMEOUT_MS` | Global/session daemon | Not supported locally | Restart session daemon on that machine |
| Session environment facts | `environmentFacts` | `PI_WEB_ENVIRONMENT_FACTS` | Global/session daemon | Not supported locally | Restart session daemon on that machine |
| PI WEB plugin desired enablement | `plugins.<id>.enabled` | `PI_WEB_PLUGINS` (JSON object) | Global | Not supported locally | Browser-only: reload tab. Server-backed: manually restart sessiond, then reload tab |
| PI WEB plugin settings | `plugins.<id>.settings` | `PI_WEB_PLUGINS` (JSON object) | Global + project for server plugins supporting project settings | **Merges top-level setting keys** over global settings; no project enablement | Browser-only global settings: reload tab. Server-backed global/project settings: manually restart sessiond, then reload tab |
| Git worktree discovery hooks | `plugins.git.settings.workspaceDiscoveryHooks` | `PI_WEB_PLUGINS` (JSON object) | Global + project | Project boolean overrides global; default `true` | Manually restart session daemon; browser reload alone does not apply changes |
| Server-plugin safe start | `serverPlugins.safeStart` | — | Global/offline recovery | Not supported locally; manage with `pi-web plugins safe-start ...` | Applied before discovery/import on next sessiond start |
| Default browser theme | `defaultTheme.themeId`, `defaultTheme.auto` | `PI_WEB_DEFAULT_THEME` (JSON object) | Gateway global | Not project-local; device choices win unless env-enforced | Settings save / browser config refresh; no restart |
| Browser localization defaults | `defaultLocalization.language`, `.formatLocale`, `.timeZone`, `.hourCycle` | `PI_WEB_DEFAULT_LOCALIZATION` (JSON object) | Gateway global | Not project-local; device choices win per field unless env-enforced | Reload tab; no service restart |
| Streaming send default | `defaultStreamingBehavior` | `PI_WEB_DEFAULT_STREAMING_BEHAVIOR` | Global gateway | Not supported locally | Applies after settings save/config refresh; defaults to `steer` |
| Quiet mode | `quietMode` | `PI_WEB_QUIET_MODE` | Global gateway | Not supported locally | Applies after settings save/config refresh; defaults to off |
| Keyboard shortcuts | `shortcuts.<actionId>` | `PI_WEB_SHORTCUTS` (JSON object) | Global | Not supported locally | Applies after settings save/config refresh |
| Project config version | `version` | — | Project | Project-local only; must be `1` when present | Next project-config read |
| **Runtime-only environment variables** |  |  |  |  |  |
| Deployment defaults file path | — | `PI_WEB_DEFAULTS_CONFIG` | Process/env | Optional read-only file; same global schema | Set in both services; restart after env changes |
| Global config file path | — | `PI_WEB_CONFIG` (`XDG_CONFIG_HOME` affects the default path) | Process/env | Selects the global config file; not a project config | Restart services/processes after changing env |
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

### Managed data directory

`PI_WEB_DATA_DIR` sets the root for PI WEB-managed runtime state and defaults to `~/.pi-web`. Unless a more specific path override is configured, PI WEB stores its project and machine registries, locally discovered plugins, default session-daemon socket, and session archives beneath this root.

PI WEB creates `$PI_WEB_DATA_DIR/maintenance` when a maintenance terminal first needs it. Commands from Updates run there on the selected machine, not in a user workspace. This directory is not registered as a project.

Each data directory is independent: after pointing PI WEB at a new root, it starts there with empty registries and no archive index. Changing paths does not migrate data. Archive records retain their stored paths; see [Session archive directory](#session-archive-directory).

Only one live session daemon may use a data directory. For a second instance, set a distinct `PI_WEB_DATA_DIR`, `PI_WEB_SESSIOND_SOCKET` (or `PI_WEB_SESSIOND_PORT` / `PI_WEB_SESSIOND_HOST`), and `PI_WEB_PORT`. Stale ownership markers are normally recovered automatically. If startup still refuses, verify the named owner is no longer running before deleting `sessiond-owner.json` as the error suggests.

This setting does not change the PI WEB config file selected by `PI_WEB_CONFIG` or Pi-owned state such as the active session files selected by `PI_CODING_AGENT_SESSION_DIR`.

### Session archive directory

Set `sessionArchive.directory` in the global config file to choose where new session archives are written. It defaults to `$PI_WEB_DATA_DIR/archived-sessions`. Project-local overrides are not supported.

```json
{ "sessionArchive": { "directory": "/srv/pi-web/archives" } }
```

`PI_WEB_SESSION_ARCHIVE` accepts a JSON object such as `{"directory":"/srv/pi-web/archives"}`. The nonempty `PI_WEB_SESSION_ARCHIVE_DIR` path alias takes precedence over both JSON environment policy and config files; an empty alias is ignored. Relative paths resolve against the process working directory. Use an absolute path for a predictable destination; do not rely on tilde expansion.

Restart the session daemon on the affected machine after changing either value. Only the destination for new archives changes: the index stays at `$PI_WEB_DATA_DIR/archived-sessions.json`, existing records keep their stored paths, and no migration occurs.

Edit the global config file or daemon environment directly. Neither this destination nor the managed data directory is exposed in Settings.

### Agent process environment

Agent shells, terminals, and child sessions inherit the daemon environment, including its Pi state paths. `NODE_ENV` and `PORT` are removed so they do not interfere with development commands.

`PI_WEB_SESSION=1` marks nested processes. Inherited `PI_WEB_*` values still point to the hosting instance. Use a separate data directory, daemon endpoint, and web port for a second instance. Do not restart the hosting session daemon from inside an active session you need to preserve.

`environmentFacts` includes nesting and deployment guidance in session system prompts by default. Set it to `false`, or use `PI_WEB_ENVIRONMENT_FACTS=false`, to omit that guidance. Restart sessiond after changing it.

### External path access

`basePaths` and `pathAccess.allowedPaths` grant PI WEB's file explorer and absolute `@` path completions access to specific filesystem roots outside the current workspace. Both default to empty lists. The effective roots are base paths plus global additions plus project additions, with duplicates removed. Higher layers replace each list rather than appending to its lower-layer list; project additions remain a separate contribution unless `PI_WEB_PATH_ACCESS` enforces the additions. `PI_WEB_BASE_PATHS` enforces only the bases, not the additions.

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

`uploads.defaultFolder` sets the workspace-effective default destination. The built-in default is `.pi-web/uploads`; a global config value applies to every project unless `<project>/.pi-web/config.json` sets a project-local override. `PI_WEB_UPLOADS` enforces the destination over both.

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

`attachments.defaultFolder` sets the workspace-effective save destination shown in that selector. The built-in default is `.pi-web/attachments`; a global config value applies to every project unless `<project>/.pi-web/config.json` sets a project-local override. `PI_WEB_ATTACHMENTS` enforces the destination over both.

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

### MCP server sign-in and sign-out

Select a nonarchived session, then choose **MCP login** or **MCP logout** from **Actions**. Each action asks you to select an eligible server, even when only one is available. MCP actions are separate from model-provider authentication; the provider dialogs have no MCP footer.

Alternatively, open **Settings → MCP** to see enabled OAuth-eligible servers for the selected session on the settings machine. Each server has **Login** and **Logout** controls that target it directly, without another server picker. Disabled servers, servers using header-based authentication, and stdio servers are not listed as OAuth authentication candidates.

Both entry points use the same MCP dialog flow, showing the chosen server and Pi’s progress and outcome without switching to Chat. They require an idle session in a trusted workspace with Pi’s built-in MCP command enabled. Finish the current MCP authentication operation before starting another on the same machine.

Pi can reuse valid or refreshable credentials without asking you to authorize again. No browser prompt may mean credentials were reused; it is not proof of success. Read Pi’s messages for the outcome: **Operation finished** means the command ended, not that login succeeded. There is no force-reauthorization or switch-account control.

If Pi provides an authorization link, open it and complete authentication in your browser. If the callback cannot reach the runtime—for example, with a remote or container deployment—paste the full redirected URL into the dialog when prompted.

**Logout** removes the server’s local Pi credentials and disconnects its authenticated connection. Other sessions using the same saved credentials are also affected. It does not disable the server configuration or revoke access at the provider. To revoke access, use the provider’s account settings.

**Cancel** requests that pending UI or future prompts stop. It may not immediately stop browser approval, token exchange, or reconnection already in progress; credentials may already have been saved if you cancel after approval.

Pi owns OAuth tokens and server reconnection, storing MCP credentials in the active profile’s `mcp-auth.json`, separate from model-provider authentication. Ordinary `/mcp` commands entered in Chat still use Pi’s inline extension UI.

After updating PI WEB, manually restart the session daemon to activate this flow. A browser reload or web/API restart is insufficient. For the systemd user service, run `systemctl --user restart pi-web-sessiond` from outside its hosted sessions; restarting interrupts active sessions and terminals.

### Background model catalog refresh

PI WEB refreshes provider model catalogs automatically in the background and after login or logout. Reopen the model selector to see new models. Failed refreshes keep the last successful catalog and report problems in daemon logs. A refresh can briefly delay session startup; the activity line reports when model lists are refreshing.

Set `PI_WEB_OFFLINE=true` or `PI_OFFLINE=true` in the web/API and session-daemon environment and restart both to disable release checks and catalog network refresh. Sessions then use stored catalogs. Offline and skip-check flags accept only `true`/`false` (case-insensitive) or `1`/`0`; invalid values, including empty strings, fail startup. If either offline flag is true, catalog refresh is disabled.

`PI_WEB_SKIP_VERSION_CHECK` and `PI_SKIP_VERSION_CHECK` disable release checks only. Set all applicable flags to `false`/`0`, or unset them, to re-enable release checks and catalog refresh. Migration: nonempty values no longer automatically enable these switches; replace arbitrary strings with explicit booleans.

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

`subsessions` controls whether agents receive the tracked-subsession tools: `spawn_subsession`, `list_subsessions`, `check_subsession`, `read_subsession`, `yield_to_subsessions`, and `manage_subsession`. It defaults to `true` and also requires `spawnSessions` to be enabled.

Independent sessions run in a workspace of the same project without granting management rights or sending automatic lifecycle notices to the initiating session. Tracked subsessions run in the parent's working directory and give the parent inspection and lifecycle controls. When a tracked child's run ends, the parent receives an idle or error notice—not the child's final answer or a claim that its task is complete. A working parent receives notices at the next safe turn boundary, without waiting for its run to finish. The parent can keep working or use `yield_to_subsessions` to suspend until a new notice arrives. Received notices are not automatically repeated; explicit inspection remains available through `check_subsession` and `read_subsession`.

Both kinds of session use the same `send_session_message` tool for communication when messaging is enabled. What to communicate, when to reply, and whether a task is finished are decisions for the agents and their instructions, skills, or workflows.

Parents use `manage_subsession` with a direct child's `sessionId` and an `action`: `stop` interrupts its current run, `resume` continues its conversation, and `archive` archives it. The optional `prompt` supplies new instructions for `resume` only; other actions reject it. Stop interrupts work rather than freezing a process or undoing changes; a later resume or message can start another run. Resume rejects a child that is already working. Archive requires the child to be idle; stop it first if needed. These controls do not extend to unrelated sessions or grandchildren.

`sessionMessages` controls whether sessions, including tracked children, receive `send_session_message`. It defaults to `true`, independently of the spawning flags. Set it to `false` or set `PI_WEB_SESSION_MESSAGES=0` to remove the tool and block session-message delivery after restarting the session daemon. It sends a message to a known session ID in any workspace of the same registered project on the same machine. An idle recipient starts a turn; a busy recipient receives steering at the next safe agent boundary rather than after its run finishes. Messages do not interrupt an executing tool; delivery during compaction or standalone shell execution waits until that activity ends. Sending creates no parent/child relationship, grants no inspection or control rights, and subscribes to no results. Messages include the runtime-provided sender session ID so recipients can reply. Children also receive their parent's session ID in runtime context; neither identity implies additional permissions or a required collaboration workflow. The tool returns acceptance, not an answer or confirmation that the message was read. Queued messages use the runtime's normal queue and are not a durable mailbox; stopping or closing the recipient can discard pending work. Archived sessions cannot receive messages.

Agent-created tracked subsessions are collapsed under their parent. Use **Agent subsessions** to expand them. User-created forks and clones, unknown-origin sessions, children without an available parent, and independent sessions remain visible.

New sessions inherit the parent's model and thinking level unless another model is requested, for example with a `#provider/model-id` prompt reference. Thinking levels are limited to what the chosen model supports.

In **Settings → Session daemon**, these keys are saved on the selected machine. Restart the session daemon on that machine after changing them.

#### Human intervention

An agent can write a question in the conversation and call `request_human_intervention` with a short `reason` to mark the session **Needs input** and end its run. This tool is always available, independently of the spawning, messaging, and question-form settings. It also covers approvals and actions outside PI WEB; questions in text alone do not set the indicator.

The static hollow ring appears on the session and rolls up to its workspace, project, and machine, including collapsed agent-subsession groups. Unread activity remains separate. Any new agent run clears the agent-requested state, whether started by you, another agent, or a system message. Merely queueing a message, reading the session, or navigating its transcript does not clear it. If the agent still needs help after resuming, it requests intervention again.

Agent-requested intervention is saved with the session and survives daemon restarts. It is session execution state, not an outstanding question or a branch-specific form. Newly posted `ask_user` forms set the same state automatically. Pending extension dialogs also show **Needs input**, but retain their own answer, cancellation, and timeout lifecycle; runtime-only dialogs are not restored after a daemon restart.

Restart the session daemon after upgrading to activate the tool and state tracking.

#### `askUser` and `ask_user`

`askUser` controls whether agents receive the core `ask_user` tool. It defaults to `true`; set it to `false`, or set `PI_WEB_ASK_USER=false`, to remove the tool. The environment override accepts `0|1|true|false` and takes precedence over the config file.

Use **Settings → Session daemon → Allow agents to ask questions** to change `askUser` on the selected machine. An environment override makes the toggle read-only.

Agents can ask questions with choices or free-text answers. You may leave questions unanswered; partial submissions are confirmed before sending. Answering or skipping resumes the agent.

Forms are saved in the conversation and survive restarts. Only a form at the end of the active conversation is open; answering, skipping, or sending another message closes it. Earlier forms remain expandable for read-only review. Returning the conversation to a question reopens it; archived conversations remain read-only.

Restart the session daemon after changing `askUser` or after upgrading PI WEB to a version that introduces this tool. For the systemd user service, run `systemctl --user restart pi-web-sessiond`.

### Session naming

The bundled **Session naming** Pi extension (`@jmfederico/pi-session-naming`) names new conversations from their first prompt. PI WEB installs it in the active Pi profile. The TUI also loads it when using that profile.

To use another naming extension, remove **Session naming** through **Settings → Pi packages**. Reinstall it from **Available packages** to restore automatic naming. Package changes apply to new conversations.

Configure naming in `<active-agent-profile>/session-naming/config.json` (normally `~/.pi/agent/session-naming/config.json`):

```json
{
  "model": "provider/model-id",
  "maxTokens": 2048,
  "thinkingLevel": "off",
  "timeoutMs": 90000
}
```

All fields are optional:

- **`model`** defaults to the conversation's model. Use an exact provider/model ID from your profile's model catalog, with its configured credentials.
- **`maxTokens`** defaults to `24`. Use a positive safe integer. Providers may count reasoning tokens against this budget.
- **`thinkingLevel`** defaults to `minimal`. Options are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. Provider limits apply; some models require reasoning even with `off`.
- **`timeoutMs`** defaults to `10000` (10 seconds). It covers model loading and generation. Use an integer from `1` through `2147483647` milliseconds.

File edits apply to the next naming request. Remove a field to restore its default, or save `{}` to reset all file overrides. To enforce individual values, set `PI_WEB_SESSION_NAMING` to a JSON object and restart the affected process.

If naming fails, the extension reports the error and uses the first few words of the prompt as the title.

#### Existing settings

PI WEB imports old `sessionNaming` values into the package file when it loads configuration. An existing package config takes precedence. After migration, PI WEB removes the old key from writable core config. For deployment-default entries, check the package file and remove the obsolete entries at the locations reported in the log.

Use the package file for future changes. The core config API rejects the retired `sessionNaming` setting.

If migration fails, check the logged source and destination paths and fix the reported problem. PI WEB retains the old key and continues startup. Migration retries on the next config load or startup. Until repaired, naming may use the package's existing config or defaults.

### Extension dialogs

Pi extensions can show confirmation, selection, and text-input dialogs inline in the session transcript, including while a session starts or a tool runs. Dialog support is always on; there is no enable flag. See [Pi extension dialogs in PI WEB](https://pi-web.dev/plugins#pi-extension-dialogs) for details.

`extensionDialogsTimeoutMs` cancels unanswered extension dialogs after the configured interval. It defaults to `300000` (5 minutes); set it to `0` to wait forever. Values must be integers from `0` through `2147483647` milliseconds; larger values are rejected rather than overflowing the runtime timer. If the extension sets its own timeout, the sooner deadline applies.

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

Plugins are enabled by default unless their package metadata declares `defaultEnabled: false`. Explicit `plugins.<id>.enabled` config overrides the package default. `plugins.<id>.enabled: false` hides a browser-only entry on the next page load. For a server-backed entry, desired disablement takes effect on the next sessiond start; its paired browser entry continues to follow the still-active server entry until that restart. The bundled `pi-web.terminal` plugin is required during normal startup: ordinary config cannot disable it, and Settings renders it non-editable. Global server settings are captured at daemon startup; diagnostics do not expose their values.

#### Project plugin settings

Supporting server plugins, including Git, accept `plugins.<id>.settings` in `<project>/.pi-web/config.json` at the registered project's path, not in individual worktrees. Project top-level keys override global settings unless that key is enforced through `PI_WEB_PLUGINS`; nested objects are replaced rather than deep-merged. Plugin enablement stays global.

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

Project values override the machine default unless environment-enforced. Changes require a manual session-daemon restart. Disabling hooks leaves the Git plugin and ordinary workspace discovery available.

<a id="git-instance-namespace"></a>
#### Git worktree discovery when running multiple instances

Most installations need no changes. Docker dev automatically uses `dev` to keep its worktree notifications separate from production; production keeps its existing behavior.

For a custom setup where instances share a PI WEB data directory, set `PI_WEB_INSTANCE_NAMESPACE=dev` in the dev session daemon's environment and leave it unset in production. Use a different name for each additional instance: 1–32 letters, digits, underscores or hyphens, starting with a letter or digit.

Restart the affected daemon to apply the change; for Docker, recreate the affected containers. This interrupts active sessions and terminals, so finish important work first. This setting separates Git notifications only; separate data directories are still recommended for independent instances.

Keep the name stable. If you need to retire a name, disable [discovery hooks](#git-worktree-discovery-hooks) while still using that name before switching, so the old notifications are removed.

#### Desired versus active plugin state

Saving `plugins` config or replacing package files changes **desired** state, not the running server code. A disabled server plugin and its paired UI may remain active until the session daemon restarts. By default, PI WEB withholds a paired UI when its package/settings no longer match the running server code or the server plugin is unhealthy or incompatible.

The supported `npm run dev:web` launcher defaults the process-only `PI_WEB_DEV_PLUGIN_PAIRING` flag to `1`, allowing refreshed plugin UI to use the still-running old backend. Set `PI_WEB_DEV_PLUGIN_PAIRING=0` before launching to retain strict pairing. Production and other startup paths stay strict by default. The flag accepts `1`/`true` and `0`/`false` (case-insensitive); invalid values fail web/API startup. This is startup wiring, not a saved `plugins` setting. Mismatch notices remain in the existing restart diagnostics, and backend changes still require a session-daemon restart that interrupts active sessions and terminals. See [Local plugin development](plugins.md#local-development).

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

Unless `PI_WEB_DEFAULT_THEME` enforces the theme, device choices take precedence over the configured default, then the built-in default (PI WEB Dark with Auto on). Enforcement locks theme controls and preserves the saved device choice for when the policy is removed. Auto follows the device's light/dark preference for paired themes; unpaired themes stay selected.

The initial page includes the gateway default's details and CSS, including associated pair details and both variants' CSS for Auto. Accepting that theme needs no additional theme request. If the default requires legacy browser activation, the backend supplies Classic while preserving the intended preference. The app appears with the delivered palette; the browser then requests another theme if its saved choice needs one, or applies a legacy theme when its plugin activates. A failed or unavailable choice leaves the current palette usable without erasing the saved choice. General settings load the complete inventory once per dialog, with explicit retry on failure and normal HTTP caching. The browser-native loading screen covers initial application startup, not later browser overrides.

Device choices keep the existing localStorage key `pi-web-app-theme` and `{ themeId, auto }` format. Theme packages use declarative metadata and revision-qualified assets, not cached arbitrary CSS in localStorage or new config files. See [theme packages](plugins.md#css-first-themes) for authoring and migration.

The default belongs to the gateway, not a project or remote machine. Changes apply after settings save or browser config refresh, with no service restart.

```json
{ "defaultTheme": { "themeId": "themes:pi-web-dark", "auto": true } }
```

Use a theme contribution ID rather than a display name. Built-in IDs remain `themes:pi-web-dark`, `themes:pi-web-light`, `themes:classic`, `themes:paper`, and `themes:graphite` after migration to declarative packages.

### File icon theme

**Settings → General → File icons** selects a complete icon set for Files and Git in this browser, independently of the colour theme. Git uses filename colours and status labels to distinguish changes without tinting the file-type artwork. Material is included locally and selected by default. Its file-type shapes render in one muted grey supplied by the active colour theme, without separate light/dark assets. Choose generic file icons to disable themed icons, or reset the browser choice to return to Material. Unavailable saved themes temporarily fall back to Material without erasing the choice. If Material is unavailable too, Files uses generic icons. Directory expand/collapse indicators remain unchanged.

This is a browser-only preference, with no gateway default, project setting, or environment override. See [file icon contributions](plugins.md#file-icon-themes) for additional icon sets.

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

Composer send bindings accept one key combination, not sequences. Desktop defaults to Enter; touch or narrow screens default to Shift+Enter. The touch or narrow-screen binding (`composer.send.mobile`) applies when the primary pointer is coarse or the viewport is at most 760px wide; desktop applies otherwise. This keyboard-specific exception does not affect control sizing. Touch keyboards can report autocapitalization as Shift, so this context requires an explicit Shift keydown for Shift+Enter; plain Enter inserts a newline by default. Unassigned Enter/Shift+Enter insert newlines; Enter accepts a selected completion first. `null` disables keyboard submission, not the send button.

Existing browser-local Enter preferences remain the fallback until a composer binding is configured. Reset restores that fallback. New bindings are saved in gateway config.

## Prompt completions

The chat composer opens completion menus on three trigger characters:

- `/` at the very start of the draft completes session commands.
- `@` completes file paths: `@` for tracked files, `@ ` (at, then space) or `!@` for all files. Picking one inserts an `@path` reference into the draft, quoted automatically when the path contains spaces.
- `#` completes the models available to the session, filtered case-insensitively as you type (at most 12 entries). Picking one inserts a `#provider/model-id` reference into the draft, which tells agents the request should run on that model — for example as the `model` parameter of `spawn_session`.

## Optional completion tools

File and path `@` completions work without extra tools. If `fzf` is available on the PI WEB server's `PATH`, PI WEB uses it to improve completion filtering/ranking; otherwise it falls back to built-in ranking.
