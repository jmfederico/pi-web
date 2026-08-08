# PI WEB configuration reference

PI WEB configuration covers the machine-local and project-local settings you usually need: the web/API bind address, trusted development-host settings, UI preferences, plugin enablement, file-explorer path access, manual upload defaults, upload limits, Pi-compatible agent profiles and companion CLIs, and session-daemon tools.

This file is the markdown reference for agents and package consumers. The website page is <https://pi-web.dev/config>.

## Config files

PI WEB uses two config files:

- **Global PI WEB config:** `$PI_WEB_CONFIG`, or `$XDG_CONFIG_HOME/pi-web/config.json`, or `~/.config/pi-web/config.json`.
- **Project-local PI WEB config:** `<project>/.pi-web/config.json` for commit-able project settings.

Each PI WEB machine has its own config. When using Fleet/machine federation, Settings uses the selected machine for config that affects work running there: the Pi-compatible agent profile and companion CLI, session daemon tools, PI WEB plugin enablement, external path access, and upload defaults. Gateway/browser-only settings stay local to the gateway: keyboard shortcuts, remote machine registry/tokens, and gateway host/port/allowed-hosts.

Pi package settings are separate from PI WEB config. They live in Pi's package-manager settings on the target machine and are managed by Pi (`pi install`, `pi remove`, `pi update`) or **Settings → Pi packages**. In a federated setup, **Settings → Pi packages** targets the currently selected machine. The PI WEB `plugins` config key only enables or disables discovered PI WEB browser plugins on the machine whose config you are editing; it does not install, remove, or update Pi packages.

If you installed services with a custom config path, rerun `pi-web install --config /path/to/config.json` after changing that path or after upgrading from a version that only applied the custom path to the web service. This regenerates service files so the web/API and session daemon use the same `PI_WEB_CONFIG`.

## Reverse-proxy deployment paths

The deployment path is not a PI WEB config-file key or environment setting. The published client is portable: one build works at `/` and at canonical trailing-slash prefixes such as `/ai/` or `/test/ai/`.

For a nested deployment, redirect the slashless prefix to the trailing-slash URL, strip the prefix before forwarding to PI WEB, and proxy authenticated HTTP and WebSocket traffic through the same location. Relative browser and PWA URLs then stay within that prefix. See the [reverse proxy installation guide](https://pi-web.dev/install#reverse-proxy-prefix) for a complete Nginx example.

## Precedence and reloads

Machine-global runtime values are resolved as:

```text
defaults → global config file → environment overrides
```

Supported project-local settings are then applied for that project's workspaces. For upload defaults, `<project>/.pi-web/config.json` overrides the global value.

Environment overrides include `PI_WEB_HOST`, `PI_WEB_PORT` / `PORT`, `PI_WEB_ALLOWED_HOSTS`, `PI_WEB_MAX_UPLOAD_BYTES`, `PI_WEB_AGENT_COMMAND`, `PI_WEB_AGENT_DIR`, `PI_WEB_AGENT_SESSION_DIR`, `PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR` for Pi compatibility, `PI_WEB_SPAWN_SESSIONS`, `PI_WEB_SUBSESSIONS`, and `PI_WEB_ASK_USER`.

Process restarts depend on the key:

- `host` / `port`: restart the gateway web/API service or process.
- `maxUploadBytes`: restart both the web/API process and the session daemon on that machine.
- `agent.command` / `agent.dir` / `automations` / `spawnSessions` / `subsessions` / `askUser` / `extensionDialogsTimeoutMs`: restart the session daemon on that machine.
- `pathAccess`: applies on the next request; existing file views may need a browser refresh.
- `uploads.defaultFolder`: applies to newly opened Files upload dialogs and new direct drag/drop batches after config/workspace refresh.
- `plugins`: reload the browser tab after changing PI WEB plugin enablement.
- Pi package install/remove/update: not a PI WEB config key; after a mutation, type `/reload` in each idle PI WEB session on the target machine to refresh ordinary Pi resources such as extensions, skills, prompt templates, themes, and context/system prompt files. Reload the browser page separately for PI WEB browser plugin changes. If a global Pi extension adds or removes a provider, or changes a provider's connection settings, manually restart `pi-web-sessiond.service`; `/reload` cannot change the startup provider baseline. A known provider refreshing only its own model list is applied without a restart. See [Pi extension provider baseline](#pi-extension-provider-baseline).
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
    "command": "pi",
    "dir": "~/agent-profiles/research"
  },
  "automations": true,
  "spawnSessions": true,
  "subsessions": false,
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
  }
}
```

Project-local `pathAccess.allowedPaths` entries are merged after the global list and deduplicated. Paths must still be host-absolute or `~`-prefixed; relative roots are not supported.

Project-local `uploads.defaultFolder` overrides the global upload destination for workspaces in that project. PI WEB servers always include this workspace-effective value on the workspace responses used locally and through machine federation.

Plugins may own separate project files, such as `.pi-web/tasks.json` for the built-in Workspace Tasks plugin.

PI WEB also honors one optional project hook; see [Worktree pre-remove hook](#worktree-pre-remove-hook).

## Worktree pre-remove hook

Before PI WEB deletes a workspace (a secondary Git worktree), it gives the repository one chance to tear down project-owned infrastructure tied to that worktree. To use the hook, provide an executable script at:

```text
.pi-web/hooks/worktree-pre-remove
```

relative to the workspace where the deletion command runs. PI WEB runs the deletion command from the project's main workspace when it exists, so commit the hook there and it follows the repository.

When the hook is present and executable, PI WEB dispatches the hook and the removal as one composed terminal command:

```sh
'<hook path>' '<worktree path>' && git worktree remove '<worktree path>'
```

Contract:

- **Arguments:** exactly one — the absolute path of the worktree being deleted.
- **Working directory:** the workspace the deletion command runs in, not the worktree being deleted.
- **Exit codes:** `0` lets the removal proceed; any non-zero exit blocks it. The `&&` chain is the fail-closed guarantee — a failing hook keeps the worktree on disk.
- **Absent hook:** a missing file, or a file without the executable bit (for example after a checkout that lost it), is treated as no hook; PI WEB then runs a plain `git worktree remove`.

The composed command is dispatched like any other workspace deletion — same `Delete workspace: <branch>` terminal title — so hook output and failures are visible in the terminal run. If PI WEB cannot probe the hook path because of an unexpected filesystem error, the deletion request fails before any workspace terminals are closed.

Example: a hook that stops and removes local dev containers that bind-mount the worktree, so deletion does not leave stale containers behind. The hook is an opaque extension point — the contract does not assume any specific tooling, so use whatever the repository standardizes on:

```sh
#!/bin/sh
# .pi-web/hooks/worktree-pre-remove
set -eu

worktree_path="$1"

# Stop/remove local dev containers bind-mounting "$worktree_path",
# release other per-worktree resources, etc.
# Exit non-zero to block the worktree removal.
```

## Configuration matrix

Rows with JSON key `—` are runtime-only environment variables, not config-file keys. `Global` means machine-global. In Settings, selected-machine-safe global keys (`pathAccess`, `uploads`, `maxUploadBytes`, `agent`, `automations`, `spawnSessions`, `subsessions`, `askUser`, and `plugins`) are edited for the selected machine; gateway host/port/allowed-hosts, keyboard shortcuts, and machine registry/tokens stay local.

| Config | JSON key | Env var | Scope | Project-local behavior | Applies / restart |
| --- | --- | --- | --- | --- | --- |
| **Config-file keys** |  |  |  |  |  |
| Web/API bind host | `host` | `PI_WEB_HOST` | Global | Not supported locally | Restart web/API |
| Web/API port | `port` | `PI_WEB_PORT`, `PORT` | Global | Not supported locally | Restart web/API |
| Dev-server allowed hosts | `allowedHosts` | `PI_WEB_ALLOWED_HOSTS` | Global | Not supported locally | Restart dev web/UI |
| External filesystem roots | `pathAccess.allowedPaths` | — | Global + project | **Merges**: global roots first, then project roots; duplicates removed | Next file request; refresh existing views if needed |
| Manual file upload default folder | `uploads.defaultFolder` | — | Global + project | **Overrides**: project value wins for workspaces in that project; otherwise global/default applies | New Upload dialogs and direct drag/drop batches after config/workspace refresh |
| Upload/body limit | `maxUploadBytes` | `PI_WEB_MAX_UPLOAD_BYTES` | Global | Not supported locally | Restart web/API and session daemon on that machine |
| Companion CLI command | `agent.command` | `PI_WEB_AGENT_COMMAND` | Global/session daemon | Not supported locally | Restart session daemon on that machine; affects doctor/status/update checks |
| Agent profile state directory | `agent.dir` | `PI_WEB_AGENT_DIR` (`PI_CODING_AGENT_DIR` for Pi compatibility) | Global/session daemon | Not supported locally | Restart session daemon on that machine; affects auth, models, settings, sessions, Pi packages, and Pi-package-backed PI WEB plugins |
| Workspace automations | `automations` | — | Global/session daemon | Not supported locally | Restart session daemon on that machine |
| Agent can spawn sessions | `spawnSessions` | `PI_WEB_SPAWN_SESSIONS` | Global/session daemon | Not supported locally | Restart session daemon on that machine |
| Tracked subsessions (beta) | `subsessions` | `PI_WEB_SUBSESSIONS` | Global/session daemon | Not supported locally; also requires `spawnSessions` | Restart session daemon on that machine |
| Agent can post question forms | `askUser` | `PI_WEB_ASK_USER` | Global/session daemon | Not supported locally | Restart session daemon on that machine |
| Extension dialog auto-cancel timeout | `extensionDialogsTimeoutMs` | — | Global/session daemon | Not supported locally | Restart session daemon on that machine |
| Plugin enablement/settings | `plugins.<id>.enabled`, `plugins.<id>.settings` | — | Global | Not core local config; plugins may read their own project files | Reload browser tab |
| Keyboard shortcuts | `shortcuts.<actionId>` | — | Global | Not supported locally | Applies after settings save/config refresh |
| Project config version | `version` | — | Project | Project-local only; must be `1` when present | Next project-config read |
| **Runtime-only environment variables** |  |  |  |  |  |
| Global config file path | — | `PI_WEB_CONFIG` (`XDG_CONFIG_HOME` affects the default path) | Process/env | Selects the global config file; not a project config | Restart services/processes after changing env |
| Managed data directory | — | `PI_WEB_DATA_DIR` | Process/env | Not supported locally | Restart web/API and session daemon |
| Session daemon socket | — | `PI_WEB_SESSIOND_SOCKET` | Web/API + session daemon env | Not supported locally | Restart daemon and web/API; both must match |
| Session daemon TCP port | — | `PI_WEB_SESSIOND_PORT` | Session daemon env | Not supported locally | Restart session daemon; set `PI_WEB_SESSIOND_URL` for web/API too |
| Session daemon TCP host | — | `PI_WEB_SESSIOND_HOST` | Session daemon env | Not supported locally | Restart session daemon |
| Web-to-daemon URL | — | `PI_WEB_SESSIOND_URL` | Web/API env | Not supported locally | Restart web/API |
| Projects storage file | — | `PI_WEB_PROJECTS_FILE` | Web/API + session daemon env | Not supported locally | Restart services; advanced state override |
| Remote machines storage file | — | `PI_WEB_MACHINES_FILE` | Web/API env | Not supported locally | Restart web/API; advanced state override |
| Agent profile session storage directory | — | `PI_WEB_AGENT_SESSION_DIR` (`PI_CODING_AGENT_SESSION_DIR` for Pi compatibility) | Session daemon env | Not supported locally | Restart session daemon; env-only session storage override |
| Agent profile state directory | — | `PI_WEB_AGENT_DIR` (`PI_CODING_AGENT_DIR` for Pi compatibility) | Web/API + session daemon env | Not supported locally | Restart services |
| Skip update checks | — | `PI_WEB_SKIP_VERSION_CHECK`, `PI_WEB_OFFLINE`, `PI_SKIP_VERSION_CHECK`, `PI_OFFLINE` | Web/API env | Not supported locally | Restart web/API after env changes |
| Offline mode | — | `PI_WEB_OFFLINE`, `PI_OFFLINE` | Web/API + session daemon env | Not supported locally | Restart session daemon and web/API after env changes; also disables the [background model catalog refresh](#background-model-catalog-refresh) |

## Key details

### Managed data directory

`PI_WEB_DATA_DIR` sets the root for PI WEB-managed runtime state and defaults to `~/.pi-web`. Unless a more specific path override is configured, PI WEB stores its project and machine registries, locally discovered plugins, default session-daemon socket, and session archives beneath this root.

Each data directory is independent: after pointing PI WEB at a new root, it starts there with empty registries and no session archives. To carry session archives over, stop PI WEB, then copy `archived-sessions.json` and the `archived-sessions/` directory from the old data directory into the new one before starting it again.

This setting does not change the PI WEB config file selected by `PI_WEB_CONFIG` or Pi-owned state such as the active session files selected by `PI_CODING_AGENT_SESSION_DIR`.

### Agent process environment

Agent shells, terminals, and spawned sessions do not inherit the session daemon's own configuration. When the daemon starts, it removes its `PI_WEB_*` configuration keys, `NODE_ENV`, `PORT`, and `PI_CODING_AGENT_SESSION_DIR` from the environment agent processes see, so development commands behave normally inside sessions — for example, `npm install` is not affected by a production `NODE_ENV` meant for the daemon, and a second PI WEB instance started from a session does not pick up the live daemon's data directory or socket. `PI_CODING_AGENT_DIR` and ordinary variables (`PATH`, `HOME`, proxy settings, and the like) remain visible. The daemon itself keeps using the values it captured at startup.

### External path access

`pathAccess.allowedPaths` grants PI WEB's file explorer and absolute `@` path completions access to specific filesystem roots outside the current workspace.

By default, workspace-relative file reads stay inside the workspace and absolute paths are denied. Add only roots you trust PI WEB to list and read through the browser UI.

Accepted root forms:

- Unix absolute paths: `/opt/reference`
- Home-relative paths: `~/SDKs`
- Windows absolute paths on Windows hosts: `C:\Users\dev\SDKs`

When an absolute request is served, PI WEB expands `~`, canonicalizes the configured roots with `realpath`, requires roots to be existing directories, and rejects symlink escapes outside the allowed roots.

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

The value must be a non-empty workspace-relative folder. PI WEB normalizes repeated separators and backslashes to `/`, and rejects absolute paths or `..` traversal. In the upload dialog only, clearing the destination field uploads that batch to the workspace root.

Manual uploads use the workspace file-write path: paths stay workspace-relative, parent folder creation is enabled by default, and overwrite is disabled by default. Direct drag/drop always keeps `overwrite` off; the review dialog lets you explicitly enable overwrite when needed. Browser-owned XHR progress is shown per batch/file, conflicts and errors stay visible in the upload progress UI, and the final file-write response is the source of truth.

For machine federation, Settings saves the global upload default on the selected machine. Remote PI WEB servers always return `workspace.effectiveConfig.uploads.defaultFolder` on the workspace-list response, and the Files panel uses it as the default upload destination.

The per-request size limit is still controlled by `maxUploadBytes` / `PI_WEB_MAX_UPLOAD_BYTES` on the machine serving the upload.

### Pi-compatible agent profile and companion CLI

`agent.command` selects the Pi-compatible companion CLI used by `pi-web doctor` and, when it can be generated safely, package-managed update commands. It defaults to `pi`. This setting does **not** replace the embedded runtime: every session continues to use PI WEB's bundled Pi SDK.

`agent.dir` selects the Pi-compatible state profile used for auth providers, models, settings, sessions, Pi packages, and Pi-package-backed PI WEB plugin discovery. It defaults to `~/.pi/agent` only for a canonical Pi companion command. The directory must use the data layout supported by the bundled Pi SDK; PI WEB does not load or convert incompatible fork formats, migrate profile data, or repartition PI WEB-managed archives when the profile changes.

```json
{
  "agent": {
    "command": "pi-lab",
    "dir": "/opt/pi-profiles/lab"
  }
}
```

An alternate command always requires an explicit state directory. The command must be a safe bare executable name such as `pi-lab` or a host-absolute executable path such as `/opt/pi/bin/pi`; relative paths, shell expressions, and launcher strings are rejected. The state directory must be host-absolute or start with `~`. In a federated save, the gateway transports Unix and Windows absolute paths without reinterpreting them, and the target machine validates and returns the persisted profile.

Environment variables take precedence over the config file. `PI_WEB_AGENT_COMMAND` selects the companion CLI, `PI_WEB_AGENT_DIR` sets the profile state directory, and `PI_WEB_AGENT_SESSION_DIR` overrides session storage separately from `agent.dir`. The legacy `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR` names apply only to a canonical Pi companion command; PI WEB never derives ambient environment-variable names from an arbitrary command. Use the explicit `PI_WEB_AGENT_*` names for alternate commands. `PI_WEB_AGENT_DIR` is an unconditional override, while a legacy `PI_CODING_AGENT_DIR` override stops applying when Settings selects an alternate command so the command and directory can transition together.

The session daemon resolves the persisted desired values plus its environment once at startup. That secret-free active profile stays fixed for the daemon lifetime. **Settings → Session daemon** saves command and directory together as desired configuration and shows whether the profile is active, needs a restart, or cannot be compared. Until the daemon restarts, sessions, Pi package operations, Pi-package-backed PI WEB plugin discovery, status/install detection, and update planning continue to use the daemon-owned active profile; a web/API restart recovers that same active profile instead of applying the newly saved values.

If the session daemon cannot report a valid active profile, profile-dependent Pi package and PI WEB plugin operations report unavailable instead of falling back to independently resolved config. A package-managed update command is shown only when PI WEB can preserve the active profile with a recognized, safe Pi companion CLI; otherwise the command is omitted. Restart the session daemon on the selected machine to establish the next active profile.

### Pi extension provider baseline

This policy applies to **Pi runtime extensions**, not PI WEB browser plugins. Pi extensions are runtime modules loaded by the session daemon and can call `pi.registerProvider(...)`; PI WEB plugins are browser-side UI modules and never run in the session daemon.

PI WEB shares one model runtime across all sessions. When the session daemon starts, before any project resources load, it initializes global Pi extensions from the active agent profile (`agent.dir`), including extensions supplied by globally configured Pi packages. Provider registrations made by synchronous or awaited asynchronous extension factories during this bootstrap join the shared baseline. PI WEB captures both config-form registrations (`pi.registerProvider("id", config)`) and native-provider registrations (`pi.registerProvider(provider)`), alongside Pi built-ins, environment credentials, and providers from the active agent directory's `models.json`.

After startup capture, a provider's connection settings are fixed for the daemon lifetime. Later attempts to add a provider, replace an existing provider's configuration, register a native provider, or unregister a provider are no-ops, regardless of source or provider ID. This includes project extensions attempting to add or replace a provider, lifecycle callbacks such as `session_start`, and `/reload`. Non-provider Pi extension features continue to load and reload normally.

#### Model list refresh for a known provider

One narrow update is applied after startup: a provider captured in the baseline may refresh **its own model list**. Extensions that fetch an updated catalog typically re-send their complete provider configuration, so PI WEB compares the incoming registration against the recorded baseline and applies it only when both hold:

- the provider ID is already in the startup baseline, and
- every field except the model list is unchanged — `name`, `baseUrl`, `apiKey`, `api`, `streamSimple`, `headers`, `authHeader`, `oauth`, and `refreshModels`.

Anything else stays a no-op, including a provider that was not in the baseline and a known provider whose credentials, base URL, or API surface differ from startup. Function-valued fields cannot be compared by value, so a registration that supplies a new `streamSimple`, `refreshModels`, or `oauth` implementation is treated as a change and ignored.

An applied refresh becomes the new comparison point, so a provider can refresh repeatedly. Re-sending an unchanged model list is a replay rather than an update and is ignored. Refreshed models are visible to sessions immediately; no restart and no network request is involved, because the extension has already produced the catalog.

Model lists are shared daemon-wide state. If extensions in two workspaces register different model lists for the same provider ID, the last registration wins. A model entry may also carry its own `baseUrl` and `headers`, which take precedence over the provider-level values for that model, so an accepted refresh can change where requests for those models are sent. Both are accepted trade-offs: a catalog is treated as a property of the provider rather than of the project, and Pi extensions are trusted daemon code.

#### Provider decisions in the daemon log

Ignored mutations are written to the session-daemon log once per operation and provider ID, so a replaying extension cannot flood the log. Applied model list refreshes are logged every time, with the resulting model count, because each one changes shared runtime state. Neither entry contains provider configuration or credentials, and PI WEB does not show a session warning or notification.

This prevents accidental provider, configuration, or credential contamination between projects; it is not a security boundary because Pi extensions remain trusted daemon code.

Configure providers before the daemon starts: use the active agent directory's `models.json`, or install the Pi extension globally in that agent profile. Project Pi extensions and project-level `models.json` files cannot add providers to PI WEB's shared baseline. After updating PI WEB—or after installing, removing, or updating a global Pi extension that registers providers—manually restart `pi-web-sessiond.service` (`systemctl --user restart pi-web-sessiond`). Restarting only the web/API service and running `/reload` do not rebuild the baseline.

### Background model catalog refresh

PI WEB shares one model runtime across all sessions, and provider model catalogs are refreshed over the network only on the session daemon's own background schedule. Requests never start a catalog fetch of their own, so a slow or unreachable provider cannot stall opening the model selector, starting a session, or the auth dialogs on its own account.

A refresh that is *already* in flight can still briefly delay starting or opening a session, because the shared runtime is read while that refresh is running. PI WEB says so while you wait: the session's activity line names the startup step it is on and adds `provider model lists are refreshing` when a background refresh is running at the same time. That note reports what is happening concurrently, not a proven cause.

The session daemon runs the refresh:

- **15 seconds after the daemon starts**, then **hourly**. Pi treats stored catalogs as fresh for four hours, so most hourly ticks make no network request at all; the shorter tick only makes sure a due refresh is not delayed to the next tick.
- **Immediately after a provider login or logout**, bypassing that freshness window, because the cached catalog is known to be wrong.

Each run is bounded: it is aborted after **60 seconds**, and a run that times out or cannot reach a provider earns **one retry after five minutes**; a provider that answers with an error status is retried on the next scheduled refresh instead. Failures never clear the stored catalogs — the last successfully fetched models stay in use and the daemon log records what failed. A refresh in flight is also aborted when the daemon shuts down.

Models fetched by a background refresh appear the next time a client asks for the model list, so a model selector left open across a refresh may need to be reopened.

To turn the background refresh off entirely, set `PI_WEB_OFFLINE` or `PI_OFFLINE` in the session daemon's environment and restart it. In offline mode PI WEB performs no provider catalog network requests, including after logins, and sessions use the catalogs already stored in the agent profile. The `PI_WEB_SKIP_VERSION_CHECK` and `PI_SKIP_VERSION_CHECK` keys do **not** affect this refresh; they only suppress PI WEB release checks.

### Workspace automations

`automations` controls whether the selected machine's session daemon loads workspace automation support. It defaults to `true`. Use **Settings → Session daemon → Workspace automations** to disable it, then restart the session daemon.

When disabled, the daemon does not load the automation runtime or SQLite native binding, open `automations.sqlite`, acquire its ownership record, register automation routes, or start scheduler polling. It also stops advertising the automation capability, which hides the workspace Automations panel. Existing definitions and run history stay on disk unchanged. Re-enabling the feature resumes from that durable state and applies the normal missed-occurrence behavior described in the [Automations reference](automations.md).

### Session daemon tools

`spawnSessions` controls whether agents receive the `spawn_session` tool. It defaults to `true`; set it to `false` if you do not want an agent to start independent PI WEB sessions.

`subsessions` is beta and controls whether agents receive the tracked-subsession tools: `spawn_subsession`, `list_subsessions`, `check_subsession`, `read_subsession`, and `yield_to_subsessions`. It defaults to `false` and also requires `spawnSessions` to be enabled.

Tracked subsessions are join-oriented. Calling `spawn_subsession` returns immediately, so the parent can continue independent work while the child runs. Work whose result the parent does not need to join belongs in the fire-and-forget `spawn_session` tool instead.

At a join point, after finishing its independent work, the parent calls `yield_to_subsessions` alone as the final action in its tool batch. Pi ends a tool batch early only when every result in that batch is terminating. If any tracked child is still working, the action ends the current agent run so the parent becomes idle. If none are working, it does not end the run and clearly reports that there is nothing to wait for.

A completion notice wakes an idle parent or queues behind in-flight work. Each notice lists any other tracked children still working, so the parent can continue work or call `yield_to_subsessions` again at the next join point. Further notices arrive automatically; do not poll. The notice includes the child's final output when it fits. If that output is too long, PI WEB omits it entirely instead of adding a truncated duplicate to the parent's context and directs the parent to retrieve it with `check_subsession`.

`list_subsessions`, `check_subsession`, and `read_subsession` never yield or change control flow. They are for deliberate inspection or recovery, not completion polling. While a child works, agent-facing `check_subsession` and `read_subsession` withhold partial output and direct the parent to continue independent work or yield at the join point. Output becomes available when the child stops. Included output and transcripts follow a labeled marker and come last, after PI WEB guidance.

Both `spawn_session` and `spawn_subsession` accept an optional `model` parameter, given as an exact `provider/model-id` such as `anthropic/claude-sonnet-4-5`. When set, the new session starts on that model instead of inheriting the dispatching session's model. The match is strict: an unknown or malformed value is rejected with an error. A `#provider/model-id` reference in the prompt (see [Prompt completions](#prompt-completions)) is how users ask for a specific model; agents forward that reference as this parameter. The new session also inherits the dispatching session's thinking level, clamped to its model's capabilities.

In **Settings → Session daemon**, these keys are saved on the selected machine. Restart the session daemon on that machine after changing them.

#### `askUser` and `ask_user`

`askUser` controls whether agents receive the core `ask_user` tool. It defaults to `true`; set it to `false`, or set `PI_WEB_ASK_USER=false`, to remove the tool. The environment override accepts `0|1|true|false` and takes precedence over the config file.

Use **Settings → Session daemon → Allow agents to ask questions** to change `askUser` on the selected machine. An environment override makes the toggle read-only.

The tool accepts one set of 1–20 questions. Each question has a unique `id`, its `question` text, optional supporting `detail`, up to 12 options with stable values and user-facing labels, and an optional `multiple` flag. The browser always adds a **Custom** free-text answer, including when the model supplies no options. No question is required: the user may leave any of them unanswered.

Calling `ask_user` posts the whole set as one browser form and ends the current agent run instead of waiting for the user. The open form is owned by the session daemon, so it survives a browser disconnect, browser reload, or web/API restart while that daemon keeps running. When the user submits, the answers arrive as a follow-up that wakes the session; each question is reported with its selected option values or free text, or explicitly as unanswered.

PI WEB confirms a partial submission before sending it and names the unanswered questions. Only one ask can be open per session: a later `ask_user` call supersedes the earlier one, reports that fact and its unanswered questions to the model, and turns the earlier card into a read-only transcript record. Submitted and cancelled asks likewise remain readable in the transcript.

Sending an ordinary chat message while a form is open voids the form: the card closes as cancelled and the model is told its questions went unanswered as part of the turn the message itself starts.

Restart the session daemon after changing `askUser` or after upgrading PI WEB to a version that introduces this tool. For the systemd user service, run `systemctl --user restart pi-web-sessiond`.

### Extension dialogs

Pi extensions can ask the user questions from `ctx.ui.confirm()`, `ctx.ui.select()`, and `ctx.ui.input()` — including from `session_start` hooks and in-flight `tool_call` hooks. PI WEB renders these dialogs inline in the session transcript and answers them through a dedicated session-daemon channel, never the prompt queue, so a dialog parked inside a `tool_call` hook cannot deadlock the run. Dialog support is always on; there is no enable flag. See [Pi extension dialogs in PI WEB](https://pi-web.dev/plugins#pi-extension-dialogs) for behavior details and author guidance.

`extensionDialogsTimeoutMs` is the unattended-dialog safety valve: how long the session daemon waits for an answer before settling the dialog with its kind's cancel value (`false` for confirm, `undefined` for select and input). It defaults to `300000` (5 minutes); set it to `0` to wait forever. An extension's own `timeout` option still applies, and the effective deadline is the sooner of the two.

The key is edited directly in the global config file. Restart the session daemon after changing it — for the systemd user service, run `systemctl --user restart pi-web-sessiond`.

### Plugin config

The `plugins` key is only for PI WEB browser plugin enablement/settings on the machine whose config you are editing. It does not install, remove, or update Pi packages; use **Settings → Pi packages** or Pi's package manager for package operations. In a federated setup, **Settings → PI WEB plugins** and **Settings → Pi packages** both target the currently selected machine, and each panel labels where changes will be saved or run.

Plugins are enabled by default. Set `plugins.<id>.enabled` to `false` to remove a plugin from that machine's `/pi-web-plugins/manifest.json` before the browser imports it. Settings lists discovered plugins from the selected machine, including disabled entries exposed by that machine.

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

## Prompt completions

The chat composer opens completion menus on three trigger characters:

- `/` at the very start of the draft completes session commands.
- `@` completes file paths: `@` for tracked files, `@ ` (at, then space) or `!@` for all files. Picking one inserts an `@path` reference into the draft, quoted automatically when the path contains spaces.
- `#` completes the models available to the session, filtered case-insensitively as you type (at most 12 entries). Picking one inserts a `#provider/model-id` reference into the draft, which tells agents the request should run on that model — for example as the `model` parameter of `spawn_session`.

## Optional completion tools

File and path `@` completions work without extra tools. If `fzf` is available on the PI WEB server's `PATH`, PI WEB uses it to improve completion filtering/ranking; otherwise it falls back to built-in ranking.
