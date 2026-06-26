# PI WEB configuration reference

PI WEB configuration covers the machine-local and project-local settings you usually need: the web/API bind address, trusted development-host settings, UI preferences, plugin enablement, file-explorer path access, manual upload defaults, upload limits, agent runtime selection, and session-daemon tools.

This file is the markdown reference for agents and package consumers. The website page is <https://pi-web.dev/config>.

## Config files

PI WEB uses two config files:

- **Global PI WEB config:** `$PI_WEB_CONFIG`, or `$XDG_CONFIG_HOME/pi-web/config.json`, or `~/.config/pi-web/config.json`.
- **Project-local PI WEB config:** `<project>/.pi-web/config.json` for commit-able project settings.

Each PI WEB machine has its own config. When using Fleet/machine federation, edit a remote machine's config by opening that machine directly or changing files on that machine.

If you installed services with a custom config path, rerun `pi-web install --config /path/to/config.json` after changing that path or after upgrading from a version that only applied the custom path to the web service. This regenerates service files so the web/API and session daemon use the same `PI_WEB_CONFIG`.

## Precedence and reloads

Machine-global runtime values are resolved as:

```text
defaults → global config file → environment overrides
```

Supported project-local settings are then applied for that project's workspaces. For upload defaults, `<project>/.pi-web/config.json` overrides the global value.

Environment overrides include `PI_WEB_HOST`, `PI_WEB_PORT` / `PORT`, `PI_WEB_ALLOWED_HOSTS`, `PI_WEB_MAX_UPLOAD_BYTES`, `PI_WEB_AGENT_COMMAND`, `PI_WEB_AGENT_DIR`, `PI_WEB_AGENT_SESSION_DIR`, `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, `OMP_CODING_AGENT_DIR`, `OMP_CODING_AGENT_SESSION_DIR`, `PI_WEB_SPAWN_SESSIONS`, and `PI_WEB_SUBSESSIONS`.

Process restarts depend on the key:

- `host` / `port`: restart the web/API service or process.
- `maxUploadBytes`: restart both the web/API process and the session daemon.
- `agent.command` / `agent.dir` / `spawnSessions` / `subsessions`: restart the session daemon.
- `pathAccess`: applies on the next request; existing file views may need a browser refresh.
- `uploads.defaultFolder`: applies to newly opened Files upload dialogs and new direct drag/drop batches after config/workspace refresh.
- `plugins`: reload the browser tab after changing plugin enablement.
- `shortcuts`: saved settings apply in the browser after config refresh/save.

## Global config example

```json
{
  "host": "127.0.0.1",
  "port": 8504,
  "pathAccess": {
    "allowedPaths": ["~/SDKs", "/opt/reference"]
  },
  "uploads": {
    "defaultFolder": ".pi-web/uploads"
  },
  "maxUploadBytes": 67108864,
  "agent": {
    "command": "omp",
    "dir": "~/.omp/agent"
  },
  "spawnSessions": true,
  "subsessions": false,
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
  }
}
```

Project-local `pathAccess.allowedPaths` entries are merged after the global list and deduplicated. Paths must still be host-absolute or `~`-prefixed; relative roots are not supported.

Project-local `uploads.defaultFolder` overrides the global upload destination for workspaces in that project. Current PI WEB servers include this workspace-effective value on the existing workspace responses used locally and through machine federation. Older remote servers may omit the optional field; the browser falls back to the global/default upload folder.

Plugins may own separate project files, such as `.pi-web/tasks.json` for the built-in Workspace Tasks plugin.

## Configuration matrix

Rows with JSON key `—` are runtime-only environment variables, not config-file keys.

| Config | JSON key | Env var | Scope | Project-local behavior | Applies / restart |
| --- | --- | --- | --- | --- | --- |
| **Config-file keys** |  |  |  |  |  |
| Web/API bind host | `host` | `PI_WEB_HOST` | Global | Not supported locally | Restart web/API |
| Web/API port | `port` | `PI_WEB_PORT`, `PORT` | Global | Not supported locally | Restart web/API |
| Dev-server allowed hosts | `allowedHosts` | `PI_WEB_ALLOWED_HOSTS` | Global | Not supported locally | Restart dev web/UI |
| External filesystem roots | `pathAccess.allowedPaths` | — | Global + project | **Merges**: global roots first, then project roots; duplicates removed | Next file request; refresh existing views if needed |
| Manual file upload default folder | `uploads.defaultFolder` | — | Global + project | **Overrides**: project value wins for workspaces in that project; otherwise global/default applies | New Upload dialogs and direct drag/drop batches after config/workspace refresh |
| Upload/body limit | `maxUploadBytes` | `PI_WEB_MAX_UPLOAD_BYTES` | Global | Not supported locally | Restart web/API and session daemon |
| Agent CLI command | `agent.command` | `PI_WEB_AGENT_COMMAND` | Global/session daemon | Not supported locally | Restart session daemon; affects doctor/status/update checks |
| Agent state directory | `agent.dir` | `PI_WEB_AGENT_DIR`, `PI_CODING_AGENT_DIR`, `OMP_CODING_AGENT_DIR` | Global/session daemon | Not supported locally | Restart session daemon; affects auth, models, settings, and sessions |
| Agent can spawn sessions | `spawnSessions` | `PI_WEB_SPAWN_SESSIONS` | Global/session daemon | Not supported locally | Restart session daemon |
| Tracked subsessions (beta) | `subsessions` | `PI_WEB_SUBSESSIONS` | Global/session daemon | Not supported locally; also requires `spawnSessions` | Restart session daemon |
| Plugin enablement/settings | `plugins.<id>.enabled`, `plugins.<id>.settings` | — | Global | Not core local config; plugins may read their own project files | Reload browser tab |
| Keyboard shortcuts | `shortcuts.<actionId>` | — | Global | Not supported locally | Applies after settings save/config refresh |
| Project config version | `version` | — | Project | Project-local only; must be `1` when present | Next project-config read |
| **Runtime-only environment variables** |  |  |  |  |  |
| Global config file path | — | `PI_WEB_CONFIG` (`XDG_CONFIG_HOME` affects the default path) | Process/env | Selects the global config file; not a project config | Restart services/processes after changing env |
| Managed data directory | — | `PI_WEB_DATA_DIR` | Process/env | Not supported locally | Restart services before changing; moves managed state location |
| Session daemon socket | — | `PI_WEB_SESSIOND_SOCKET` | Web/API + session daemon env | Not supported locally | Restart daemon and web/API; both must match |
| Session daemon TCP port | — | `PI_WEB_SESSIOND_PORT` | Session daemon env | Not supported locally | Restart session daemon; set `PI_WEB_SESSIOND_URL` for web/API too |
| Session daemon TCP host | — | `PI_WEB_SESSIOND_HOST` | Session daemon env | Not supported locally | Restart session daemon |
| Web-to-daemon URL | — | `PI_WEB_SESSIOND_URL` | Web/API env | Not supported locally | Restart web/API |
| Projects storage file | — | `PI_WEB_PROJECTS_FILE` | Web/API + session daemon env | Not supported locally | Restart services; advanced state override |
| Remote machines storage file | — | `PI_WEB_MACHINES_FILE` | Web/API env | Not supported locally | Restart web/API; advanced state override |
| Agent session storage directory | — | `PI_WEB_AGENT_SESSION_DIR`, `PI_CODING_AGENT_SESSION_DIR`, `OMP_CODING_AGENT_SESSION_DIR` | Session daemon env | Not supported locally | Restart session daemon; env-only session storage override |
| Agent config directory | — | `PI_WEB_AGENT_DIR`, `PI_CODING_AGENT_DIR`, `OMP_CODING_AGENT_DIR` | Web/API + session daemon env | Not supported locally | Restart services |
| Skip update checks | — | `PI_WEB_SKIP_VERSION_CHECK`, `PI_WEB_OFFLINE`, `PI_SKIP_VERSION_CHECK`, `PI_OFFLINE` | Web/API env | Not supported locally | Restart web/API after env changes |

## Key details

### External path access

`pathAccess.allowedPaths` grants PI WEB's file explorer and absolute `@` path completions access to specific filesystem roots outside the current workspace.

By default, workspace-relative file reads stay inside the workspace and absolute paths are denied. Add only roots you trust PI WEB to list and read through the browser UI.

Accepted root forms:

- Unix absolute paths: `/opt/reference`
- Home-relative paths: `~/SDKs`
- Windows absolute paths on Windows hosts: `C:\Users\dev\SDKs`

When an absolute request is served, PI WEB expands `~`, canonicalizes the configured roots with `realpath`, requires roots to be existing directories, and rejects symlink escapes outside the allowed roots.

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

The value must be a non-empty workspace-relative folder. PI WEB normalizes repeated separators and backslashes to `/`, and rejects absolute paths or `..` traversal. In the upload dialog only, clearing the destination field uploads that batch to the workspace root.

Manual uploads use the workspace file-write path: paths stay workspace-relative, parent folder creation is enabled by default, and overwrite is disabled by default. Direct drag/drop always keeps `overwrite` off; the review dialog lets you explicitly enable overwrite when needed. Browser-owned XHR progress is shown per batch/file, conflicts and errors stay visible in the upload progress UI, and the final file-write response is the source of truth.

For machine federation, current remote PI WEB servers return `workspace.effectiveConfig.uploads.defaultFolder` on the existing workspace-list response. Older remote servers can omit that optional field without breaking clients; the Files panel falls back to the global/default upload folder.

The per-request size limit is still controlled by `maxUploadBytes` / `PI_WEB_MAX_UPLOAD_BYTES`.

### Agent runtime selection

`agent.command` controls which Pi-compatible CLI PI WEB checks in doctor/status/update flows. It defaults to `pi`; set it to `omp` when this machine should use Oh My Pi.

`agent.dir` controls which compatible agent state directory PI WEB reads for auth providers, model settings, settings, and session metadata. It defaults to the selected agent's conventional directory (`~/.pi/agent` for `pi`, `~/.omp/agent` for `omp`).

```json
{
  "agent": {
    "command": "omp",
    "dir": "~/.omp/agent"
  }
}
```

Environment variables take precedence over the config file. `PI_WEB_AGENT_COMMAND` selects the command, `PI_WEB_AGENT_DIR` sets the state directory for any command, and command-specific variables such as `OMP_CODING_AGENT_DIR` are honored when the selected command is `omp`.

Session directory overrides are environment-only. Set `PI_WEB_AGENT_SESSION_DIR` or the selected command's session variable (for example `OMP_CODING_AGENT_SESSION_DIR`) when you need to override session storage separately from `agent.dir`.

Restart the session daemon after changing agent settings. The web/API process can display the new config immediately, but active session runtime ownership is intentionally long-lived.

### Session daemon tools

`spawnSessions` controls whether agents receive the `spawn_session` tool. It defaults to `true`; set it to `false` if you do not want an agent to start independent PI WEB sessions.

`subsessions` is beta and controls whether agents receive the tracked-subsession tools: `spawn_subsession`, `list_subsessions`, `check_subsession`, and `read_subsession`. It defaults to `false` and also requires `spawnSessions` to be enabled.

Tracked subsessions let an agent delegate work to child sessions, get notified when children stop working, and inspect their transcripts.

### Plugin config

Plugins are enabled by default. Set `plugins.<id>.enabled` to `false` to remove a plugin from `/pi-web-plugins/manifest.json` before the browser imports it.

```json
{
  "plugins": {
    "workspace-tasks": { "enabled": true, "settings": {} },
    "updates": { "enabled": false }
  }
}
```

Reload the browser tab after changing plugin enablement. Already-loaded plugin JavaScript is not unloaded from the current page.

### Shortcut config

Shortcut values are keyed by action id. Values are shortcut strings such as `mod+k` or `mod+g p`; `null` disables that action's shortcut.

```json
{
  "shortcuts": {
    "core:view.chat": "mod+1",
    "core:session.stop": null
  }
}
```

Prefer Settings → Keyboard for editing shortcuts interactively.

## Optional completion tools

File and path `@` completions work without extra tools. If `fzf` is available on the PI WEB server's `PATH`, PI WEB uses it to improve completion filtering/ranking; otherwise it falls back to built-in ranking.
