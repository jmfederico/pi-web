# @jmfederico/pi-web

## 1.202608.2

### Upgrade warnings

- **Breaking project-trust default — existing projects may need to be trusted again:** PI WEB now always enforces Pi's project-trust model and removes the `respectProjectTrust` opt-in environment variable and config key. After upgrading, a workspace without a saved trust decision becomes untrusted, so its project-local `.pi/` resources do not load until you trust the workspace from the workspace menu or while adding the project, or set `defaultProjectTrust` to `always`.
- **Restart the session daemon after upgrading** on every machine so the project-trust enforcement, enabled-model synchronization, Pi version reporting, and Relay package auto-installation take effect.

### Patch Changes

- 62f704a: Add a search box to the provider selection list in the authentication dialog, so long subscription/credential provider lists can be narrowed by name or id. The search also applies to the stored-credential removal step.
- 2d60542: Make `pi-web doctor` exit nonzero when an installed Web/UI or session daemon component is unavailable or stale (restart needed), instead of only reporting it in the version section. Machines with no PI WEB services installed keep the previous informational behavior.
- 0b6497b: Trim surrounding whitespace from the path when adding a project, so the stored project matches the path the trust preview showed and no whitespace-padded folder is created.
- e31d283: Fix the Add Project dialog showing "Loading folders…" forever without folder suggestions once a path was typed.
- 70cb7ee: Fix pending file/image attachments in the chat composer leaking into other sessions when switching sessions, or vanishing while a new session was still being provisioned.
- 7344b31: Fix the prompt editor caret height before any text is entered, and keep the caret and selection highlight colors readable in every theme.
- 321de5d: Honor pi's global and project `enabledModels` settings in session model selection and cycling.
- 3369cc9: **Breaking change — existing projects may need to be trusted again.** PI WEB now always honors Pi's project-trust model and removes the `respectProjectTrust` opt-in environment variable and config key. After upgrading, an existing workspace without a saved trust decision becomes untrusted by default, so its project-local `.pi/` resources — settings, extensions, skills, prompts, themes, `SYSTEM.md`, and `APPEND_SYSTEM.md` — do not load until you trust the workspace or set `defaultProjectTrust` to `always`.

  At session start, project-local `.pi/` resources load only when the workspace is trusted. Trust is resolved the way `pi` resolves it with no browser prompt: a saved decision in the agent directory's `trust.json` wins, a user/global extension may decide through the `project_trust` event (and request that the choice be remembered), and otherwise `defaultProjectTrust` applies. With `ask` or no decision, a workspace is untrusted, matching headless `pi`.

  You can trust a workspace from the new workspace-menu toggle or when adding a project; both link to the project-trust documentation. The trust routes are federated, so the toggle reads and stores the decision on the machine where the workspace runs.

- 6db7a72: Report the Pi coding agent version in use: the Info panel and its diagnostics action now show the Pi version loaded by each PI WEB component (flagging when the session daemon runs a different one), the status/version API exposes it per component, and the `pi-web` CLI version report prints it.
- 5ceeeac: Keep the session bulk-selection toolbar visible while scrolling and use consistent scroll-edge shadows as project, workspace, and session rows pass beneath fixed navigation controls.
- 679a956: Add an Enabled / All models toggle to the session model picker. All-models mode lists the machine's full model catalog — enabled models first — with a per-model checkbox that adds or removes the model from Pi's enabled-models list (the same setting the Pi TUI edits), and search keeps filtering in both modes. Picking a model keeps its current behavior.
- e71cc3c: Improve the model picker's All models view with stable natural row positions and an atomic Select all / Deselect all action. Membership edits now preserve the user's scroll position instead of moving the edited model, and rows change availability without switching models or closing the dialog.
- db0202c: Make the shipped Relay prompts preserve a minimal agreed scope, apply a proportionate quality bar that favors observable and recoverable failure over speculative edge-case automation, plan adaptive context-contained legs instead of a fixed session sequence, carry review dispositions across reviewers, permit explicitly bounded transitional checkpoints, discover each repository's delivery workflow, keep whole-work review report-only, and track structured handoff identifiers durably.
- 1e52e0b: Recognize Relay handoff session names whose leg identifiers contain letters or dashes.
- fb0b28e: Ship Relay as the standalone `@jmfederico/pi-relay` Pi package, sourced from `pi-packages/relays/` and included at `dist/pi-packages/relays/`. Installing the package provides `/relay`, `/relay-worktree`, the `relay` skill, and the Relays PI WEB browser panel/action; Pi package removal removes those package contributions, while `plugins.relays.enabled` only shows or hides the browser panel/action. At session-daemon startup, PI WEB auto-installs Relay for the active agent profile unless that profile previously removed it from **Settings → Pi packages**, and **Available packages** offers one-click reinstall. The shipped path also supports explicit `pi install <path>` outside PI WEB; publishing `@jmfederico/pi-relay` to npm remains deferred.
- b4f68fb: Fix `pi-web restart` on macOS reporting success while LaunchAgents could disappear: the CLI now waits for each `launchctl bootout` to finish unloading before re-bootstrapping the service instead of racing launchd's asynchronous teardown, and the install path settles the same way. `pi-web start` and `pi-web restart` now also verify on macOS and Linux that each service is actually running and responsive (web/API endpoint, session daemon health), exiting nonzero and naming the unready service instead of succeeding silently. These readiness checks and `pi-web doctor` automatically use the custom config path persisted by `pi-web install --config` unless the command is invoked with a nonempty `PI_WEB_CONFIG` override, and fail safely when the service manager has a conflicting loaded definition; malformed systemd environment entries are rejected without stalling lifecycle commands.
- 5d40701: Synchronize global enabled-model selections across active sessions without requiring sessions to be reopened, while keeping workspace `.pi/settings.json` overrides isolated and read-only in the picker.

## 1.202608.1

### Upgrade warnings

- **Browser plugin API v1 → v2:** browser plugin entries must now declare `apiVersion: 2`; v1 entries are rejected without a compatibility shim. The deprecated browser-v1 aliases were removed: use `refreshWorkspacePanels()` with `onInvalidate()`, the provider-authored `workspace.label`, and `workspace.provider.metadata` instead of `isGitRepo`, `isGitWorktree`, or top-level `workspace.branch`. The `plugin-api/unstable` package export is gone, and browser packages must declare a safe `browserRoot` with canonical relative module paths. The server plugin API stays on v1. Update any installed browser plugins when you update PI WEB.
- **Federated deployments must upgrade together:** machine federation breaks across versions in both upgrade orders. The workspace listing route now answers with a provider resolution object, so an older gateway cannot open any project on an updated machine and an updated gateway cannot open any project on an older machine (the machine still reports online and its settings, files, terminals, and sessions still load). Older gateways also lose Git status/diff on updated machines, and workspace deletion requires a host-issued confirmation from the same release. Upgrade gateways and remote machines together, then manually restart `pi-web-sessiond.service` on each target and reload the browser — a web/API restart alone is insufficient.
- **Requires Pi Coding Agent `>=0.84.0`:** update Pi before updating PI WEB.
- **Breaking configuration change:** the `agent.command` config key and `PI_WEB_AGENT_COMMAND` no longer do anything, and `PI_WEB_AGENT_DIR`, `PI_WEB_AGENT_SESSION_DIR`, and `agent.dir` are deprecated aliases of `PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR`. Deprecated inputs still work in this release but show a non-dismissable UI warning and will be removed in a future release — rename the environment variables and delete `agent.*` from your PI WEB config now.
- **Restart the session daemon after upgrading** on every machine: the machine status indicators, the new subsessions default, and the Pi runtime changes only take effect with a session-daemon restart.
- **Tracked subsessions are now enabled by default:** agents receive the `spawn_subsession` / `list_subsessions` / `check_subsession` / `read_subsession` / `yield_to_subsessions` tools out of the box. Set `subsessions: false` or `PI_WEB_SUBSESSIONS=0` to opt out.

### Patch Changes

- 676815f: Keep `PI_CODING_AGENT_SESSION_DIR` visible to agent processes: when a deployment overrides the session storage directory, `pi` CLIs started from sessions, terminals, and subsessions now use the same session store as the session daemon instead of silently falling back to the default store.
- 180d71a: Send a provider login prompt or selection only once: pressing Enter again, or choosing another option, while the previous response is still being sent no longer submits a duplicate response that could lose the race and report an expired login request. Cancelling the login stays available while a response is in flight.
- 4471e80: Add semantic colors to session-tree kind badges so conversation entry types are easier to distinguish.
- d388375: Keep the session selection toolbar compact by showing the selected count in the clear action and right-aligning bulk session actions.
- 71f0eab: Allow subscription (OAuth) login and logout for federated remote machines from the gateway web UI. Provider discovery, login flows, and credential removal stay bound to the machine where the operation began, even if the selected machine changes while a request is pending. Older pending provider lookups cannot replace or close a newer login/logout dialog or flow. The dialog explains that the provider's redirect page will not load in your browser so you can paste the full redirect URL back to complete the login.
- 42ee6ed: Fix workspace (worktree) removal failing immediately with "Failed to start workspace removal: HTTP request cancelled". A request carrying a body is no longer mistaken for a disconnected client after its body has been read.
- 2dc27b7: Keep error messages readable. The error banner now stays until you dismiss it with its new dismiss button, another message replaces it, or the action that raised it clears it, instead of being wiped by an unrelated background refresh.
- 109ea72: Make the working, terminal, and unread indicators in the machine, project, and workspace lists reliable. Each machine's session daemon now decides which projects and workspaces a running session or terminal belongs to and publishes one status snapshot for the whole machine, so the browser shows the same state everywhere instead of matching directories on its own. Indicators for a machine appear once that machine runs a PI WEB version with this change and its session daemon has been restarted.
- 327df80: Give the web UI's custom overlay dialogs (authentication, settings, session cleanup, command picker, action palette, project/machine dialogs, and the session tree navigator) a shared modal surface: dialogs now take focus when opened, Escape and backdrop presses close them consistently, Tab focus stays trapped inside the dialog, and focus returns to the element that was focused before the dialog opened—even when stacked dialogs close out of order. Global application shortcuts pause while a dialog is open. The authentication dialog also supports ArrowUp/ArrowDown/Enter navigation through its option lists, matching the action palette. In the session tree navigator's second step (continuing or forking from a selected entry), a backdrop press now steps back to the tree — matching Escape — instead of closing the dialog outright.
- d8253a0: Upgrade the bundled Pi coding agent to 0.84.1 and require Pi Coding Agent `>=0.84.0`, so update Pi before updating PI WEB. Pi 0.84 makes provider logins, logouts, and catalog refreshes local-only and cancellable by default, so PI WEB no longer forces offline mode while creating its shared model runtime; bounded network catalog refreshes remain confined to the background refresher.
- 0085967: Always run sessions on the bundled Pi runtime and resolve Pi's agent state directory from Pi's own environment variables. **Breaking configuration change:** the `agent.command` config key and the `PI_WEB_AGENT_COMMAND` environment variable no longer do anything (they never replaced the embedded runtime), and `PI_WEB_AGENT_DIR`, `PI_WEB_AGENT_SESSION_DIR`, and the `agent.dir` config key are now deprecated aliases for `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR`. Deprecated inputs are still honored for this release and surface a non-dismissable warning in the UI that names each input and its replacement and clears once you remove them; support will be removed in a future release. Migrate by renaming the environment variables to their `PI_CODING_AGENT_*` equivalents and deleting `agent.*` from your PI WEB config. `pi-web doctor` and the status/update flow now probe the `pi` command on `PATH` directly, and the session daemon exports the resolved state directory to everything it starts, so terminals, the bash tool, and agent-started `pi` processes all use the same directory as your sessions.

  Starting a second PI WEB instance against state owned by a live instance now fails loudly at startup with an actionable error naming the owner and the distinct `PI_WEB_DATA_DIR` / `PI_WEB_SESSIOND_SOCKET` / ports to set, instead of silently sharing state. Sessions carry `PI_WEB_SESSION=1` and receive environment facts explaining they run nested inside PI WEB, including the precautions for running another instance and for restarting services (web before sessiond); agent-spawned processes now inherit the daemon's `PI_WEB_*` environment, and the startup environment scrub removes only `NODE_ENV` and `PORT`.

  Restart the session daemon after upgrading.

- a625a43: Add safe inline workspace file previews for images, HTML, PDF, and rendered Markdown, plus attachment downloads for other files. Text-based formats (HTML, Markdown, and SVG) open as raw source and offer a Raw/Preview control; the chosen mode is remembered on this device, carries across files, and travels in the URL so shared links and browser Back/Forward restore the recorded view.
- fbe6cf9: Add a two-step session tree flow that first selects a history entry, then either continues from it in the same session or forks it into a separate session while leaving the original unchanged. Forking works for local and connected machines; user messages fork from before the entry and restore their text, when present, as the new session draft.
- 568c205: Keep cached session-list rows consistent with the transcript files they describe. When a session file has changed, its row is now rebuilt from a complete pass over that file instead of folding only the newly appended lines onto state kept from an earlier pass, so a row can no longer keep showing details that were overwritten earlier in the file. Unchanged files are still not re-read at all, and message bodies that cannot affect a row are still skipped without being decoded or parsed. This has a cost worth stating plainly: since 1.202608.0 a changed file was re-read only from its previous end, so refreshing a workspace while one of its sessions is actively being written now re-reads that whole transcript rather than just its new tail.
- c9aee67: Tracked subsessions now always run in the working directory of the session that spawned them, so a tracked child always appears in its parent's session tree instead of possibly landing in a workspace where you would not see it. `spawn_subsession` no longer takes a `cwd` parameter, and a request to start a tracked child in a different directory is refused with an explanatory error rather than quietly started somewhere else. To get work done in another workspace, either tell the child to work there, or use `spawn_session`, which can still start an independent session in any project workspace.
- bc4cad9: Enable tracked subsessions by default. Agents now receive the `spawn_subsession`, `list_subsessions`, `check_subsession`, `read_subsession`, and `yield_to_subsessions` tools out of the box; set the `subsessions` config key or the `PI_WEB_SUBSESSIONS` environment variable to `false` to opt out. Tracked subsessions still require `spawnSessions` (also on by default). Restart the session daemon after upgrading for the new default to apply.
- 989439a: Add trusted server-backed workspace provider plugins. Bundled Git now uses the same public lifecycle, claim, JSON backend, removal, federation, and diagnostics contracts available to installed third-party providers; PI WEB ships no replacement integration. Manage desired state per selected machine, and recover offline with `pi-web plugins disable` or `pi-web plugins safe-start ...` (`serverPlugins.safeStart`, including `bundled-only` and `none`).

  Machine federation breaks across versions in both upgrade orders, so upgrade gateways and remote machines together. The workspace listing route now answers with a provider resolution object instead of a workspace array, so workspaces do not load at all across a version mismatch: an older gateway cannot open any project on an updated machine, and an updated gateway cannot open any project on an older machine. The machine still reports online and its settings, files, terminals, and sessions still load, so the failure appears only once a project is selected. Workspace deletion also requires a host-issued confirmation from the same release, older gateways can no longer read Git status/diff from updated machines because the legacy core Git routes are gone, and newer gateways withhold all remote plugin contributions from older targets that lack the versioned lifecycle contract. After upgrading each target, manually restart `pi-web-sessiond.service`, then reload the browser; a web/API restart alone is insufficient. Restarting sessiond may interrupt active sessions/runtime ownership.

  Adopt browser plugin API v2 while keeping the server plugin API on v1. Browser entries must set `apiVersion: 2`; v1 entries are rejected without a compatibility shim. Activation now exposes stable source `pluginId` separately from host-unique `runtimePluginId`. Remove the deprecated browser-v1 aliases: use `refreshWorkspacePanels()` with `onInvalidate()`, use the provider-authored `workspace.label` for generic presentation, and read provider details from `workspace.provider.metadata` instead of `isGitRepo`, `isGitWorktree`, or top-level `workspace.branch`.

  Make the two supported type-only package exports self-contained for strict external TypeScript consumers and remove the former `plugin-api/unstable` path. Browser packages must declare a safe `browserRoot` and canonical relative module paths; only files inside the root are served, with both `.js` and `.mjs` receiving executable JavaScript MIME types. Ship a standalone dual-entry workspace-provider example and updated migration, identity, metadata, signal, removal, asset-boundary, and packaging guidance.

- f24b9a8: Session trees now cover only the workspace you are viewing. Opening a workspace's session list no longer reads session files from your other worktrees, so listing stays fast no matter how many sibling worktrees exist or how busy they are. Three things go away with it: a session's row no longer counts child sessions started in other workspaces, a session whose parent lives in another workspace no longer names that workspace, and it no longer offers "Go to parent session". Such a session now appears as an ordinary top-level row with a dimmed `↳` marker (hover text: "Parent session is not available in this workspace"). Parents and children in the same workspace are untouched — they still nest, indent, and detach exactly as before.

## 1.202608.0

> [!WARNING] > **Breaking change:** Compatibility with older PI WEB runtimes has been removed. Upgrade every remote machine first, then the gateway, so every machine and the gateway run `1.202608.0` together. This release also requires Pi Coding Agent 0.83.0 or newer.

### Patch Changes

- f716f65: Keep the session daemon's own runtime environment out of agent processes: agent shells, terminals, and spawned sessions no longer inherit keys such as `NODE_ENV=production` or `PI_WEB_DATA_DIR`, so commands like `npm install` behave normally inside sessions and a second PI WEB instance started from a session no longer picks up the live daemon's data directory or socket.
- c09b67d: Show the thinking level in assistant chat bubble metadata next to the model and timestamp, for both history and live messages. Bubbles from turns with thinking off stay unchanged.
- 8163d08: Drop all backwards-compatibility gates for older PI WEB runtimes. This release is incompatible with older components: upgrade every remote machine first, then the gateway, so all machines and the gateway run the new version together.

  Also fixes the session daemon staleness check: a session daemon running an older version than the installed package is now correctly reported as stale, so the restart reminder fires as intended.

- b9d3634: Speed up session listings and opening persisted sessions in projects with large session histories. The session daemon no longer parses every session transcript on each request: listings use a lightweight summary scan with an incremental cache that only re-reads newly appended transcript data, and opening a session no longer triggers redundant full-workspace scans.
- 233fd90: Navigation panel sections now share the panel height equally: collapsing a section (such as Projects) distributes its space to all remaining expanded sections instead of only the session list growing.
- ff7a06e: Show nested relay documents in the Relays workspace panel. Folders in a relay packet now appear as chips in the document strip and expand inline (expanding one collapses its siblings); collapsing the folder that holds the open document keeps the selection and highlights the folder. Very deep or large relay trees are listed partially, with a notice.
- Update HTTP server dependencies to patched releases that prevent static-route authorization and path-traversal guard bypasses, request-validation host confusion, and denial-of-service vectors.
- 4bf2be9: Respect the Pi agent profile's `httpIdleTimeoutMs` in the session daemon so long model responses (e.g. slow local vLLM backends) no longer fail with "Model response failed: terminated" at the built-in 5-minute HTTP idle timeout; `0` disables the timeout. Restart pi-web-sessiond after changing the setting.
- c2b7cce: Sessions started via `spawn_session` and `spawn_subsession` now inherit the spawning session's thinking level instead of falling back to the pi default, clamped to the child model's capabilities.
- 5f4d813: Let agents pick a model when delegating work: `spawn_session` and `spawn_subsession` accept an optional `model` parameter as an exact `provider/model-id` (an unknown value is rejected; omitting it keeps the inherited model). In the chat composer, typing `#` opens a model completion menu that inserts a `#provider/model-id` reference into the draft, which agents forward as that parameter.
- 7103bfc: Streamline the session list bulk-selection toolbar: the Select visible / Clear visible / Clear buttons are now a single toggle that offers "Select visible" when nothing is selected and "Clear selected" otherwise, and the redundant Done button is gone — selection mode closes from the same ☑ heading button that opened it. "Archive selected" and "Delete selected" are shortened to "Archive" and "Delete". The slimmer toolbar no longer wraps to two lines on narrow sidebars.
- 9ef2649: Upgrade the bundled Pi coding agent to 0.83.0, bringing credential export commands, headless OpenRouter sign-in, Claude Opus 5 on GitHub Copilot, and upstream session and provider fixes. The supported Pi version range is now open-ended (`>=0.83.0`, no upper bound), so you can run newer Pi releases as they come out without waiting for a PI WEB update.
- f927f5d: Run a repo-provided `.pi-web/hooks/worktree-pre-remove` hook before deleting a workspace worktree. When the hook exists and is executable, it runs with the target worktree path before `git worktree remove`; a non-zero exit blocks the removal. See the config reference for the hook contract.

## 1.202607.3

### Patch Changes

- 9191f59: Add an `ask_user` session tool that lets agents post structured question sets as one chat-native browser form. The form uses the transcript's single scroll area, keeps its header visible, and always gives every question a Custom free-text answer with mobile-safe text sizing. Agents end their run while the form waits; users can submit full or partial answers, unanswered questions are reported explicitly, sending an ordinary chat message voids the open form, pending forms survive browser and web/API reconnects, and closed forms remain readable in the transcript. Disable the tool from **Settings → Session daemon**, with `askUser: false`, or with `PI_WEB_ASK_USER=false`.
- 111db63: Let chat markdown tables keep their natural width and scroll horizontally instead of being squeezed into the chat column, making them readable on mobile.
- 5759201: Support Pi extension dialogs in the browser: `ctx.ui.confirm()`, `ctx.ui.select()`, and `ctx.ui.input()` now render as cards inline in the session transcript and resolve with the user's actual answer — including dialogs opened from `session_start` hooks while the session is still starting and from in-flight `tool_call` hooks, which previously resolved `false` immediately despite `hasUI === true`. Answers travel over a dedicated session-daemon channel rather than the prompt queue, so a dialog parked inside a `tool_call` hook cannot deadlock the run. Open dialogs survive browser reloads, the first answer wins across browser tabs, and unanswered dialogs settle safely on run abort, runtime replacement, or timeout. Adds the `extensionDialogsTimeoutMs` config key (default 5 minutes, `0` waits forever) as the unattended-dialog safety valve; dialog support is always on. Other `ExtensionUIContext` surfaces (widgets, status, editor, `custom`) remain unimplemented.
- 8517800: Turn the bundled Info plugin panel into an always-available PI WEB status view: it now shows the running and installed versions, installation kind and path, release state, per-service health, and machine and workspace details from host-provided status, plus a "Copy PI WEB Diagnostics" action that copies a plain-text summary for bug reports.
- 531ccf7: Let an already-known provider extension refresh its own model list after daemon startup. Previously every provider registration made after the global bootstrap was ignored, so a provider that fetched an updated model catalog on session start never had those models appear. A registration is now applied when it matches the provider's recorded startup configuration in every respect except the model list; anything else — a new provider, a changed provider base URL, API key, API type, headers, or auth surface, a native provider registration, or an unregistration — is still ignored to keep project-level provider configuration from leaking between workspaces. Documented the refreshed policy under Pi extension provider baseline in the configuration reference.
- ce4b469: Add action-palette commands for selecting a session's model and thinking level, with support for assigning custom shortcuts in Settings.
- 69b125b: Show cross-workspace session relationships in the session list. A session whose parent lives in another worktree now names that parent's workspace or branch instead of only reporting an unavailable parent, and offers a "Go to parent session" action that switches to the owning workspace and selects the parent. A session with children in other workspaces of the same project now shows how many, so a parent no longer looks childless when its children are not nested beneath it.
- d19fca4: Add `files.listFiles(path)` to the stable plugin API so workspace panel and label plugins can list workspace directory entries on local and federated machines.
- 8517800: Add `state.selectedMachine` to the stable plugin runtime state so plugin actions and other runtime callbacks can read the selected machine's identity, not just workspace panel contexts.
- 87c0998: Add a built-in Relays plugin: a read-only workspace tab (and **Open Workspace Relays** action) that browses `.pi-web/relays/` packets, with a most-recent relay picker, ordered document tabs, sanitized markdown rendering, and truncation notices.
- c3aeef2: Keep the relays panel document tab strip's horizontal scroll position when switching documents, instead of jumping back to the left edge on every tab click.
- 5c3461d: Remove the legacy session archive migration from session daemon startup. Each `PI_WEB_DATA_DIR` data directory is independent: pointing PI WEB at a new data directory starts there with empty registries and no session archives.

  You are only affected if you have session archives created before July 2026 in the default `~/.pi-web` data directory and you newly set a custom `PI_WEB_DATA_DIR`. To carry those archives over, stop PI WEB, then copy `archived-sessions.json` and the `archived-sessions/` directory from the old data directory into the new one.

- 76f292c: Stop the session and workspace lists from re-scrolling to the selected row on live data refreshes, such as message-count updates while a session streams or workspace topology refreshes. The lists now scroll the selection into view only when the selection moves to a different row, an archived session is revealed, a restored session moves back to the current section, or a collapsed section expands.
- 49e7c39: Say what a slow session start is waiting on. While a session is being created or opened, the activity line now names the current startup step — starting the Pi session, or loading session extensions — and adds a note when provider model lists happen to be refreshing at the same time. When nothing can be attributed, the previous generic wording is kept rather than guessing a cause.
- 8af637b: Give every navigation row a single activity indicator that also carries unread state. When sessions beneath a workspace, project, or machine row have unread completions, the row's indicator becomes a static accent ring around the activity dot — or a filled accent dot while idle — instead of a separate dot next to the name. Session rows now surface unread state even while busy or sending, and the "N unread" header and mobile Sessions badge count busy unread sessions too.
- 8af637b: Add "Mark as read" actions for unread sessions: a per-session item in the session row ⋯ menu (shown only for unread sessions) and a bulk "Mark read" button in the multi-select bar that marks every unread selected session as read.
- 4a51503: Add copy buttons to the workspace menu details so the workspace path and branch can be copied to the clipboard with one click, matching the copy affordances already available in chats.
- 8a24a7c: Pick up git worktrees created or removed outside PI WEB without any user action. The selected project's workspace list is re-read whenever the browser tab regains focus or becomes visible, on local and remote machines, keeping the current workspace, session, and scroll position untouched. Worktrees whose checkout directory no longer exists are hidden instead of being offered as selectable workspaces.

## 1.202607.2

### Patch Changes

- b48b147: Allow npm 12 global installs and updates to run node-pty's required native-module installation scripts, and diagnose blocked native modules before installing services.
- ed9c2f6: Fix multi-minute stalls when opening the model selector, starting sessions, or using the auth dialogs. Provider model catalogs are no longer fetched on request paths: the session daemon now refreshes them in the background on a bounded schedule — shortly after startup and hourly, plus immediately after a provider login or logout — with a per-run timeout and a single retry, keeping the stored catalogs when a provider fails. Setting `PI_WEB_OFFLINE` or `PI_OFFLINE` disables these background refreshes entirely. See the configuration reference for details.
- 4ca4a1d: Add a hierarchical `/tree` navigator for switching conversation branches in place while retaining abandoned branches, with optional branch summaries. Compact branch indentation keeps the tree usable across mobile and desktop, and the preselected no-summary choice navigates immediately.
- b85e1b9: Show project activity indicators for active sessions and terminals in external Git worktrees before the project is opened.
- a77c83b: Clarify agent instructions so independent sessions are created only when explicitly requested and tracked subsessions remain part of the current task.
- 115d74e: Keep session unread indicators and counts synchronized across browser clients and daemon restarts, and clear them when the completed chat is viewed. Tracked sub-sessions remain excluded from unread counts.
- 8a5aaf9: Add a List/Tree toggle to the Git panel's changed-file list. Tree view groups changes by directory and opens fully collapsed, with a one-click expand-all/collapse-all control, and the chosen view is remembered across sessions.
- dd435cb: Expand a changed submodule in the Git panel to see the work inside it. Tree view nests the submodule's own modified and untracked files (keeping their folder structure) and list view flattens them into one group, with a moved commit pointer shown as `<old> → <new>` when it changed. Selecting any inner file shows its real diff instead of the bare `Subproject commit` line.
- 2429113: Build an immutable provider baseline at session-daemon startup. Globally installed Pi extensions can register both config-form and native providers during startup bootstrap; every later Pi extension registration or unregistration—including global replay, project same-ID replacement, lifecycle callbacks, and `/reload`—is ignored. PI WEB browser plugins are a separate browser-only system and are unaffected. Non-provider Pi extension features still work, and ignored calls are de-duplicated in session-daemon logs by operation/provider ID without logging provider configuration or credentials or creating session warnings/notifications.

  After updating PI WEB, or after installing, removing, or updating a globally installed Pi extension that registers providers, manually restart `pi-web-sessiond.service` (`systemctl --user restart pi-web-sessiond`). Restarting only the web/API service and running `/reload` do not rebuild the provider baseline.

- a884773: Keep PI WEB-managed sessions running when extensions use `ctx.ui.theme`, preserving formatted output as readable plain text.
- 503c2c7: Show extension notifications in a compact, dismissible tray for the selected chat, with reconnect recovery and per-chat collapse state.
- 2c777b4: Let users minimise session warnings with an accessible status-bar count that remains available as an expand/collapse toggle, an in-pane minimise chevron on the expanded warnings pane, per-session remembered state, and SVG warning icons.
- 9285448: Require Pi Coding Agent `>=0.82.1 <0.83`. PI WEB no longer supports Pi 0.81 and earlier, so update Pi before updating PI WEB. On Pi 0.82 provider model catalogs revalidate with the server instead of downloading in full when nothing changed, and newly published catalog updates are no longer suppressed for a while after a fresh install.

## 1.202607.1

### Patch Changes

- 73ac24c: Set `PI_WEB_TERMINAL=1` in PI WEB terminal shells.
- 67f673b: Keep auth interactions bound to their originating machine and cancel flows created after their browser start operation becomes stale, preventing secrets from reaching the wrong remote or abandoned provider resources from surviving a closed dialog.
- a1f749c: Add a capability-aware Clear queue action that removes queued session messages, including prompts held during compaction, without stopping active work.
- dde48b3: Validate install and doctor service requirements in the real systemd or launchd manager context before changing native services, with plan-specific PATH guidance and safe probe cleanup. Thanks to @blain3white for the original report, reproduction, and root-cause analysis.
- f539193: Restore session-daemon startup and authentication on supported Pi `>=0.80.8 <0.81` releases by migrating model and credential handling to `ModelRuntime`. Provider discovery now reloads model configuration and reports only complete usable credentials. Login options follow each provider's executable API-key and OAuth capabilities: multi-step API-key setup is supported, legacy one-secret clients fail safely before storing malformed credentials, and OAuth prompts retain their input, selection, and device-code semantics. A committed login remains successful through late cancellation or notification failures. Failed realtime delivery now closes only the affected socket so its browser can reconnect while healthy peers keep receiving events. PI WEB now requires Node.js `>=22.19.0`.
- d72b14f: Add a **Check for PI WEB Updates** action that bypasses cached release data and refreshes update status for the selected local or federated machine.
- 75e2377: Add selectable Pi-compatible agent profiles and companion CLIs for isolated auth, models, settings, sessions, Pi packages, plugins, diagnostics, and safe update commands. Settings shows when a session-daemon restart is required, and mixed-version remote saves fail instead of reporting false success. The embedded runtime remains the bundled Pi SDK.
- ec0ca13: Store session archive metadata and archived session files under `PI_WEB_DATA_DIR` when configured, and automatically migrate a legacy archive on the first eligible session-daemon startup after upgrading.

  Migration runs only when `PI_WEB_DATA_DIR` explicitly selects a different root, the legacy index and every referenced file form a complete valid archive, and the destination archive is pristine. PI WEB copies and verifies files across filesystem boundaries, rewrites their `archivePath` values, atomically commits the destination index, and only then removes legacy archive state. Ambiguous, invalid, partial, or coexisting layouts are left untouched instead of being merged or overwritten; active Pi session files are never moved.

- 2b1507b: Load login shell profiles in new and continued interactive terminals so PATH-managed commands are available.
- 15d25d8: Omit oversized tracked-subsession output from parent completion notices, directing the parent to retrieve the full result with `check_subsession` instead of duplicating a truncated preview in context.
- a493949: Support root and nested reverse-proxy deployments with one published client, including scoped PWA assets, WebSockets, and local or federated plugins.
- 21c58fe: Serve PI WEB plugin SVG assets with a browser-compatible content type and clarify module-relative asset packaging.
- d72a001: Show notifications emitted by Pi extension slash commands in the web chat.
- f181c47: Keep tool-result images visible in clearly labeled standard chat cards outside collapsed event groups while retaining technical execution details and final message metadata.
- 2b17145: Stream in-flight assistant replies immediately when opening or reconnecting to a session mid-turn. The chat now seeds the partial message (text, thinking, and in-progress tool calls) and continues streaming live updates on top of it, replacing the blocking "Catching up…" placeholder and the end-of-turn transcript reload. Sessions still open normally against remote machines or session daemons that predate this feature: the snapshot is fetched as a progressive enhancement and its absence no longer blocks the transcript.
- aedcbf8: Surface live session startup warnings in the web UI. A pinned banner at the top of the session view now shows resource and runtime diagnostics (skills, prompts, themes, and extension load errors) plus the Anthropic subscription-auth billing notice, recomputed from the current runtime so they stay accurate across browser reloads. The Anthropic billing notice can be dismissed, which durably suppresses it through the underlying agent's own warning setting.
- d5154df: Add explicit tracked-subsession yielding with no-poll wake-up guidance, remaining-child status, and clear boundaries around child output.
- 6cd666f: Let chat images open in a full-size modal viewer on click or keyboard activation, with backdrop and Escape to dismiss, a touch-friendly close button, and safe-area handling so the viewer clears device notches.

## 1.202607.0

### Patch Changes

- d165d69: Make archive and delete actions reliable for large multi-session selections.
- d6cfffd: Allow chat copy buttons to work from HTTP private-network addresses by falling back when the browser Clipboard API is unavailable.
- a660ba8: Keep delegation tools available in human-created and independently spawned sessions, remove them from tracked child sessions, and guide parents to wait for required children at join points without polling.
- 256db33: Keep npm release builds working across platforms and exclude internal test-support modules from published packages.
- 338faf4: Speed up chat loading, session resume, and long-conversation rendering while reducing browser response sizes.
- ad62853: Show complete file paths and commands in tool headers and expanded details, with horizontal scrolling for long tool targets and results.
- a874798: Make spawned and tracked subsessions inherit the dispatching session's current model instead of falling back to the last globally selected model.
- eb17276: Preserve archive and archived-session delete actions for older federated PI WEB machines that do not yet advertise session persistence or delete capabilities.
- 8ade238: Manage Pi packages from Settings on the selected local or federated PI WEB machine, with install, update, and removal flows that respect each machine's advertised capabilities.
- 2009e6a: Keep the chat prompt stable during streaming so mobile touch gestures, including iOS paste and edit callouts, are not interrupted.
- 7063c2c: Prevent iOS Safari from zooming into small text inputs across the web UI.
- 386c67e: Require Pi 0.80 or newer and use its stable streaming API for session-name generation.
- 32907bb: Support Pi's `max` thinking level and refresh shipped runtime dependencies.
- 10efb7f: Name Relay handoff sessions consistently from their relay name and leg number.
- 256db33: Improve file suggestions by waiting for all Git probes before deciding whether to scan the wider workspace.
- 0b17b9d: Promote the Updates tab to stable by removing its beta label while keeping update message counts visible.
- 64b2b32: Edit machine-scoped PI WEB settings on the selected machine—including session daemon tools, plugin enablement, path access, and upload defaults—while keeping gateway/browser-only settings local and disabling unsupported remote forms.
- d2e10cd: Show generated suffixes for unnamed sessions so multiple new empty chats are easier to distinguish.
- 889672f: Add `/reload` for PI WEB sessions so newly installed Pi package resources can be loaded without restarting the session daemon, with separate guidance for browser plugin reloads.
- 2665d1e: Open new chats immediately—including on mobile—queue sends until their backend sessions are ready, and keep concurrent starts and archive/delete/reload actions aligned with server persistence.
- b61a9c0: Standardize Settings panels so descriptions, notices, and controls render in a consistent order.
- abcf44b: Show complete message dates and model identifiers in a consistent label, wrapping expanded metadata without changing message-header height.
- 02f34c4: Add a terminal copy mode with a touch-selectable, color-preserving output snapshot and a Copy all action for mobile browsers.

## 1.202606.7

### Patch Changes

- b17faeb: Improve chat, prompt, and session text rendering for RTL and mixed-direction content.
- 7e812aa: Allow chat composer attachments to save and mention general files while preserving native inline image delivery for supported image-only batches.
- 47c9b66: Fix `pi-web doctor` "can find npm/pi" checks on fish. The `--version` check
  wrapped the version command in a POSIX subshell `(cmd --version 2>&1 || true)`,
  which fish parses as a command substitution in command position and rejects
  (`command substitutions not allowed in command position`), producing a false
  negative. Emit fish's `begin; ...; end` grouping when the service shell is fish.
- b14205e: Highlight within-line changes in the Git diff viewer.
- cb13af4: Add a manual sessions cleanup flow that previews and confirms archiving idle sessions and deleting old archived sessions, with per-project selection and capability guidance for unsupported machines. Actions can now expose disabled reasons so unavailable remote-machine actions stay visible with an explanation.
- e46d9ec: Add manual Files panel uploads with direct drag/drop, an options flow from the Upload button, safe non-overwrite defaults, visible per-file progress/error reporting with clear failed/cancelled terminal states, and project-local default destinations.
- 32ea809: Add a Keyboard shortcuts setting for choosing whether Enter sends chat messages or inserts new lines in this browser, with Shift+Enter performing the opposite action when supported, while preserving the desktop-vs-mobile default (desktop Enter sends; mobile/coarse/narrow Enter inserts a new line).
- a99696b: Persist tracked subsession links in session history so parents can list, check, and read child sessions after the session daemon restarts, and reopened children can resume parent notifications.
- 27a3b2b: Add workspace file mutation (`files.writeFile`, `files.deleteFile`, `files.moveFile`) and prompt editor (`prompt.insertText`, `prompt.getText`, `prompt.getSelection`) APIs to the plugin system. File mutations work for local and federated machines, enforce workspace path safety, and auto-refresh the File Explorer.
- 9980027: Expose the plugin prompt editor helper in workspace panel contexts so panel interactions can insert text into the current prompt.

## 1.202606.6

### Patch Changes

- c479a0d: Fix the session daemon startup when PI WEB runs with compatible Pi packages that moved legacy provider registry exports to the Pi AI compatibility entrypoint.

## 1.202606.5

### Patch Changes

- c2e2a29: Add a dedicated PI WEB configuration reference covering config-file precedence, project-local config, external path access allowlists, session daemon tools, plugins, shortcuts, upload limits, and environment variables. Custom `pi-web install --config` paths are now passed to the session daemon service as well as the web service, and the session daemon now honors config-file `maxUploadBytes` values.
- 4f4c6fa: Fix remote session reloads so they proxy through the web/API instead of returning the app shell as JSON.
- 62c2234: Prevent live skill-loading cards from duplicating when the finalized transcript groups multiple skill reads.
- 27bc924: Persist the Settings → Session daemon tracked subsessions toggle so it remains enabled after restart.
- d931101: Fix dead-key/IME input in the terminal (e.g. typing `~` on a Swedish keyboard). The character previously stuck in the top-left corner and was never sent to the shell. The terminal panel now includes the xterm composition-view styles and no longer forces the helper textarea's position with `!important`, so dead-key composition is placed at the cursor and committed correctly.
- 6933d3a: Keep mobile navigation on the selected session when remote workspace loading finishes out of order.
- 2bb6e48: Normalize allowed external path suggestions on Windows so configured absolute paths use platform separators consistently.
- 9cc20d6: Allow configured external filesystem roots to be listed, read, configured from the global settings UI, and completed from absolute `@` path suggestions while keeping absolute paths denied by default, advertise workspace-scoped file suggestion support as a remote-machine capability, and use `fzf` when available to improve file/path completion filtering.
- 355ebe8: Add tracked subsessions (beta, off by default): agents can spawn child sessions they stay attached to. The new `spawn_subsession` tool starts a child session linked to its parent (recorded in the session tree), notifies the parent when the child stops working, and lets the parent inspect children via `list_subsessions`, `check_subsession` (a quick glance at a child's status and latest output), and `read_subsession` (read through a child's transcript with role/content filters, full-content substring search, optional per-value `maxChars` truncation that flags clipped parts, and pagination). The completion notice is delivered as a system-authored message (not attributed to the human), and still wakes an idle parent while queueing behind any in-flight work. Unlike the fire-and-forget `spawn_session`, subsessions are observable by their spawner.

  The capability is gated behind a beta flag so it can ship without being exposed in releases: enable it with the `PI_WEB_SUBSESSIONS` env var, the `subsessions` config key, or the "Allow agents to start tracked subsessions" toggle in Settings → Session daemon. It also requires `spawnSessions` to be enabled. Requires a manual session daemon restart to take effect.

## 1.202606.4

### Patch Changes

- 53b00c4: Show a per-session sending indicator while messages with image attachments are uploading. Previously the composer cleared instantly while the upload, server-side image resizing, and first-session open happened in the background, so it looked like nothing was happening. The chat activity dock now shows "Sending your message…" for the originating session (including the folder-mode upload step), and that session shows the activity dot in the session list so progress is visible even after switching away. The indicator is scoped per session, so it no longer leaks onto other sessions or machines, and the upload itself continues in the background regardless of navigation.
- cfb7493: Improve user/assistant message distinction in the dark theme. Previously the user and assistant message backgrounds were nearly identical (contrast ratio ~1.06), making it hard to tell speakers apart. The dark theme's user-message background was lightened and decoupled from the generic hover color, and the user border brightened, so user turns stand out clearly.
- dd23b3e: Fix a duplicate session appearing in the list when starting a new session. The `session.created` broadcast (added with the spawn_session tool) could race ahead of the start request's HTTP response in the same tab, leaving two badges with the same id — one with archive/reload actions and one with delete. The optimistic insert now replaces any entry the broadcast added, so the locally cached session (with its delete action and draft support) always wins.
- 3930505: Fix the "Catching up…" badge sometimes staying visible after a session goes idle. The stream catch-up mode was tracked by two fields that could drift — a private guard and the public badge flag — and the socket reconnect path updated one without the other, so the terminating idle status no longer cleared the badge. Both facets now route through a single source of truth, and any idle status for the selected session reliably dismisses the badge.
- 411e61a: Declutter the chat composer bar with icon-based actions. The Send, Queue, Steer, and Stop buttons are now compact icons, the Attach button moved into the message box, and the thinking level is shown as a small gauge whose bars reflect the levels available for the current model. This leaves more room on narrow/mobile layouts while keeping the model selector readable. All controls retain accessible labels and tooltips. Thinking levels are now sourced from pi directly, so an unfamiliar level from a newer pi version is still selectable and displayed gracefully instead of causing an error.
- d17050e: Add image attachments to the chat composer. You can now paste (Ctrl/Cmd+V), drag-and-drop, or use the new Attach button to add PNG, JPEG, GIF, and WebP images to a message, with thumbnail previews and multi-image support. Attachments are delivered to the session using pi's native image format (images are auto-resized to pi's inline limits for full compatibility), and image content now renders inline in the transcript. A per-message delivery toggle also lets you instead save attachments into the workspace `.pi-web/attachments` folder and reference them so the agent reads them with its own tools. The accepted HTTP upload size is now configurable via `PI_WEB_MAX_UPLOAD_BYTES` or the `maxUploadBytes` config value.
- 3c6b4a4: Run the suggested Linux restart commands inside a detached transient systemd user service (`systemd-run --user`) instead of directly. The restart now completes even when the launching PI WEB terminal is killed by restarting the session daemon, and its output can be inspected with `journalctl --user -u pi-web-restart`.
- 61f0b79: Move reload to the end of the session action menu.
- 82db15f: Add a **Reload** action to the session three-dot menu that re-reads the session from disk. The session daemon keeps an in-memory `SessionManager` per session and never re-reads the session file, so when the same session is also driven by another process (for example the `pi` CLI), new on-disk entries were invisible to the web UI and the tail of the conversation appeared truncated. Reloading closes the active session, re-opens it from disk, discards the cached transcript, and re-fetches the history.

  Reload is also available from the command palette as **Reload Session**, so it can be triggered from the keyboard and assigned a custom shortcut. Reload refuses to run while the session has work in progress and on archived (read-only) sessions, and is gated behind a new `sessions.reload` runtime capability so it only appears for machines whose Pi-Web runtime supports it (both the menu item and the palette action are disabled otherwise).

  Note: this changes a session daemon code path, so `pi-web-sessiond.service` must be restarted manually for the server side of this change to take effect.

- 95c1512: Let agents start new sessions with a `spawn_session` tool. An agent can dispatch a fresh, independent session with an initial prompt — useful for ralph-style loops (an agent kicks off the next iteration when done) and for chaining long plans across sessions. Spawned sessions are normal sessions a human can open and interact with, and they now appear in the session list the moment they are created (in the matching workspace) without a manual reload.

  To keep every spawned session visible and controllable, an agent may only spawn into a workspace — any worktree, including one it just created — of the same registered project as the spawning session. The capability is on by default and can be toggled under Settings → Session daemon (or via the `spawnSessions` config key / `PI_WEB_SPAWN_SESSIONS` environment variable); changes take effect after the session daemon restarts.

  Note: this adds a session daemon code path, so `pi-web-sessiond.service` must be restarted manually for the server side of this change to take effect.

- 3c6b4a4: Make the Updates panel actionable: every suggested command now has both a Copy and a Run button (Run executes it in a workspace terminal), a single recommended all-in-one command is shown at the top so users do not have to choose, and the remaining commands are grouped as clearly optional additional commands.

## 1.202606.3

### Patch Changes

- c0d1222: Fix sessions outside the server's launch directory being invisible: listing returned no sessions and opening them failed with 404 "Session not found", leaving the model picker empty. Working directories are now normalized at the API boundary and when reading stored session data, so path differences (trailing slashes, redundant segments, and Windows backslash vs forward-slash forms) no longer hide live or archived sessions. Requests with a relative `cwd` are now rejected with a 400 error instead of being resolved against the server's own working directory. Requires Pi coding agent SDK 0.78.0 or newer.
- 38cf334: Restart the web/UI services before the session daemon in the suggested "Restart all" command and `pi-web restart`, so running the command from a PI WEB terminal still restarts the UI even though restarting the session daemon kills the terminal.

## 1.202606.2

### Patch Changes

- 824b7a0: Initialize Pi extensions for web-managed sessions so `session_start` handlers, extension resources, and startup-dependent tools run correctly.
- a73bceb: Reduce desktop navigation crowding by moving machine switching into a compact header control and removing automatic desktop section collapse.
- 9a3f2ce: Make navigation sections collapsible on desktop and auto-collapse completed context sections after selections.
- 271c990: Document machine federation across the website and add a Fleet guide for setup, trust model, remote plugins, and troubleshooting.
- 351ed03: Add a keyboard shortcuts settings editor with manual entry, recording, disabling, reset-to-default controls, and conflict/shadowing indicators.
- 65b4c76: Let Firefox copy only the selected chat text instead of replacing selections with the full message.
- d66eccc: Keep all-file prompt suggestions active while typing file names with spaces, and include git-tracked/untracked matches when broad all-file scans miss them.
- f7eff88: Make the app refresh control perform a full page reload directly instead of opening refresh-data options.
- ad963a2: Simplify the mobile location breadcrumb by hiding the machine crumb when there is only one configured machine and removing activity indicators from breadcrumb items.
- f3e19d1: Add keyboard-first navigation for focusing Machines, Projects, Workspaces, Sessions, and the chat composer.
- b35ce1d: Reduce repeated machine and workspace details in the chat status bar and workspace tool header, keeping compact session metrics right-aligned.
- c57f24d: Allow PI WEB plugins to mark themselves as machine-specific so the gateway copy stays local-only and remote machines can provide their own status/plugin UI.
- 25d8188: Keep the documentation site's GitHub and theme controls visible in mobile portrait layouts.
- ef22247: Keep the selected remote machine during transient reconnects instead of switching the web UI back to Local.
- 0118e6e: Keep archived parent sessions visible in the current session tree while they still have unarchived children.
- 058fdee: Clarify plugin docs and website copy around private PI WEB APIs and the supported helper surface.
- b616684: Add draggable, persistent side panel resizing for the web UI navigation and workspace panels, including reset actions.
- 06052ea: Respect Pi session directory settings in pi-web sessions, including project-local Pi settings, while allowing cwd-scoped session operations without breaking legacy id-only routes.
- b2a7975: Align the desktop machine badge status to the right edge of the badge.
- a3b5b72: Add safe bulk session actions for archiving current sessions and permanently deleting archived sessions, with runtime capability checks for remote compatibility.
- 9dd59c0: Show model response errors in the chat transcript instead of leaving the conversation blank.
- 4bc390a: Keep machine/session navigation snappy by deferring expensive Pi-Web status refreshes and caching status checks.
- 577594a: Allow sidebar action/detail menus to expand beyond their list section when only a few rows are shown.
- f501f9d: Pin navigation activity indicators to the top-right of list chips so active projects, workspaces, and sessions no longer shift their labels.

## 1.202606.1

### Patch Changes

- 93b50e6: Replace add-machine browser prompts with a PI WEB form that asks for the remote URL first, suggests a machine name, and supports an optional bearer token.
- 08f69d0: Document built-in PI WEB plugins, including configuration guidance for Workspace Tasks.
- 9c3dafc: Delete workspaces through a server-side operation that closes target workspace terminals before running the worktree removal command, preventing stale machine activity indicators.
- 159f533: Fix workspace selection in the web UI so local machine project and session loading no longer fails with `api is not defined`.
- 82ba2e0: Prevent malformed session prompt API calls from crashing the session daemon.
- f2d211d: Harden remote machine plugin asset proxying so plugin asset URLs cannot escape the remote plugin directory.
- ccd4a76: Hide the Machines navigation section when only one machine is configured, align Machines list spacing with the other navigation sections, and add a remove action to remote machine rows.
- 193c9d0: Show machine activity indicators when sessions or terminals are active on any workspace for that machine.
- b5f8810: Add machine-scoped local project, workspace, file, and git API aliases as the next step toward machine federation.
- 4495a26: Make the mobile Actions entry available from the top context controls and remove the redundant PI WEB navigation header on mobile.
- 4548e5c: Use compact icons, initials, and inline badges for the mobile main tab bar so tabs are easier to fit without losing horizontal scrolling; let workspace panel plugins provide custom SVG tab icons; and add icons for bundled Info, Updates, and Tasks plugin panels.
- e352dce: Fall back to the local machine when a bookmarked or restored remote machine is offline, and clear stale remote workspace route state.
- bd8d1f1: Keep workspace tool tab icons visible in the desktop workspace panel and collapse tab names only in compact panel widths.
- 30fb960: Preserve machine, workspace, session, and terminal navigation memory across reloads within each browser tab.
- 08f69d0: Add plugin enablement settings so discovered PI WEB plugins can be disabled before the browser imports them.
- e3533eb: Add documented plugin context helpers for machine-scoped workspace files and terminal commands, generate plugin API declarations from source, and move bundled plugins away from direct PI WEB API calls.
- 8cd2bba: Keep the PWA refresh control menu visible above mobile tab navigation and workspace tab content.
- b3bb732: Remember each machine's last selected project, workspace, session, and workspace tool when switching machines in the web UI.
- a142f5e: Add remote machine federation so PI WEB can register trusted remote runtimes and proxy their projects, workspaces, sessions, files, git state, activity, and terminals through the current web server.
- b9be7de: Load trusted PI WEB plugins from selected federated machines with machine-scoped actions, workspace panels, labels, proxied plugin assets, and gateway-preferred duplicate handling.
- f1c8f1f: Clean up the workspace panel plugin context by moving render invalidation to `context.host.requestRender()` and deprecating the legacy runtime-only `openTerminal` alias in favor of `context.terminal.open()`.
- 4495a26: Add a deep-linked Settings UI for editing the active PI WEB config file and viewing registered keyboard shortcuts.
- a58c211: Add shortcut preferences to the PI WEB config schema so keyboard shortcuts can be overridden or disabled by action id.
- 0405b38: Add the first machine registry API and show the synthesized Local machine in the web UI as the foundation for machine federation.
- 4bc0010: Add workspace file and render helpers to plugin workspace label callbacks so labels can load workspace-scoped metadata without hidden panels.
- 08f69d0: Prevent redundant Workspace Tasks panel re-renders from resetting mobile scroll position or replacing task buttons mid-click, and show feedback for stale, cancelled, or already-starting tasks.
- 08f69d0: Bundle Workspace Tasks with PI WEB as a built-in plugin for running `.pi-web/tasks.json` commands in workspace terminals.

## 1.202606.0

### Patch Changes

- 6c094af: Keep slash command autocomplete visible above the chat status indicator.
- bad3a18: Add an action-palette command for deleting browser-cached new sessions, while keeping archive and delete session actions context-specific.
- fdd2cf2: Keep chat file mention suggestions working on installations that do not have ripgrep available, add an all-file `@` mention mode, stop hiding directories in the file explorer, and report optional ripgrep availability in `pi-web doctor`.
- a038da6: Fix mobile browser layout so the app no longer leaves an extra bottom gap above browser controls while preserving standalone PWA safe-area spacing.
- 9c80eb0: Avoid suggesting unavailable `pi-web` restart commands for local checkout installs, and show native service commands only when PI WEB can detect matching service files.
- 5090661: Add `pi-web version` and include installed and running PI WEB version details in doctor output.
- 9c80eb0: Rename the PI WEB status workspace tab to Updates so version and restart guidance is easier to find.

## 1.202605.14

### Patch Changes

- 3bd4773: Correct the chat history range label when normalized display messages are fewer than the raw session transcript entries.
- 1c1740a: Keep left navigation section titles visible while project, workspace, and session lists scroll.
- 5737b22: Add a collapse control for the left navigation panel in wide and two-panel layouts.
- 50f1ddc: Refresh session list message counts from live session status updates.
- c73ac5b: Keep PWA navigation bars visible after returning to the app from the background.
- 2abd1d9: Queue prompts submitted during session compaction in pi-web and deliver them only after compaction finishes.
- 958596a: Make `pi-web status` print a concise service health report without invoking paged system service output.
- f569467: Add an optional terminal soft-key bar for common control, navigation, and Meta-style key sequences, with mobile-friendly defaults and a persistent toggle.
- 61a763a: Keep the chat status indicator bubble above sticky message titles.
- 559c6f6: Add a desktop edge control for collapsing and expanding the workspace tools panel.

## 1.202605.13

### Patch Changes

- 57a6a4a: Improve `pi-web doctor` to report missing commands safely, skip Linux systemd checks on non-Linux platforms, and avoid misleading restart advice after the macOS node-pty permission workaround.
- 34e657d: Add a `pi-web doctor` diagnostic for the upstream macOS node-pty `spawn-helper` permission issue, including the workaround and tracking links.
- 8247281: Add macOS LaunchAgent service installs and a shared development install mode with `pi-web install --dev`.
- 4bfd4ac: Add homepage and remote-first website copy that explains PI WEB's persistent-by-default agent workflow.
- 679008d: Fix workspace and project activity indicators so stale session activity clears instead of reappearing after idle sessions.
- 56fa641: Restore spellcheck and autocorrect for prose in the web chat prompt while keeping command-like input protected from autocorrection.
- 711c4f3: Run workspace deletion and configurable workspace actions in visible PI WEB terminals with reload-safe command-run tracking, mobile-friendly cancellation, and shell continuation after command completion.

## 1.202605.12

### Patch Changes

- 13bb8e4: Add a theme-aware dash favicon and uppercase PI WEB page titles.
- 428f7bb: Add a session list action to archive a session together with its descendant sessions in the same workspace.
- f4aeb06: Make the mobile location breadcrumbs clickable so they open project, workspace, or session selection directly.
- 5bc2542: Extend chat diff row backgrounds across the full horizontal scroll area.
- 9e3d272: Prefill the prompt editor with the selected user message after forking a session.
- 23e82e1: Improve empty states for workspace tools and session selection when no project, workspace, or session is selected.
- a1e903f: Add cached image previews up to 10 MB to the workspace file browser for common image file types.
- df20563: Add refresh controls when PI WEB is launched as a PWA, with action palette commands for refreshing app data or reloading the page.
- 2f5293a: Fix mobile workspace panels, including the PI WEB status panel, so overflowing content remains scrollable on iPhone.
- 3409b0a: Name newly forked and cloned web sessions with readable Fork and Copy counters based on the source session title.
- 6a8f2f2: Prevent the message composer from inserting a stray blank line when starting a new session with the keyboard shortcut.
- 1546143: Add PWA manifest icons so installed PI WEB apps use the project icon.
- 1546143: Standardize user-facing PI WEB branding in uppercase across the app, docs, and install metadata.

## 1.202605.11

### Patch Changes

- 1f06b25: Make the Pi Web light/dark themes the default automatic theme pair and keep Classic as the fallback for missing theme selections.
- 619840a: Clear stale workspace activity indicators when sessions become idle or all remaining sessions are archived.
- 9d4a017: Deep-link terminal selection so action-created terminals open directly and reload back to the same terminal.
- 698a899: Load and watch first-party workspace plugin packages from the single Pi Web development command without requiring local symlinks.
- fb7903f: Document and harden separate Pi Web plugin package development, including the Actions plugin refresh flow and public terminal navigation helper.
- 32182a5: Allow Pi package installs to create systemd services from bundled Pi Web entrypoints when `pi-web-server` and `pi-web-sessiond` are not on the service shell PATH.
- 8fbdd6e: Prevent resize observers from attaching to missing UI elements during panel rerenders.
- 1f06b25: Keep loading other external plugins when one plugin fails during registration.
- 2631a63: Add persistent project, workspace, and session context in the web UI so mobile users keep their location visible while navigating between panels and chat.
- 3da2fcf: Add in-place overflow lenses for workspace rows so truncated workspace labels and plugin links can be read or clicked, and cap long project and session names to two lines.
- 894c4d0: Avoid automatically reselecting archived-only sessions unless an archived session was explicitly selected, and let closing the archived section clear archived session selection.
- cf1b0ed: Replace the workspace hover lens with a workspace actions/details menu so metadata remains accessible without blocking list scrolling or shifting rows.
- ea5d863: Preserve chat scroll positions more reliably across session and workspace changes, and keep live event groups collapsed when users close them during streaming.
- 0a086c9: Keep action-palette plugin actions responsive when they change workspace tools or routes.
- 3cce6d2: Rework chat scroll restoration around explicit bottom and anchor positions so session navigation and streaming updates keep the user's reading position stable.
- e5bc87b: Add a Go to Terminal action with a keyboard shortcut and clarify that plugin shortcuts are default keybindings attached to actions.

## 1.202605.10

### Patch Changes

- fb9e524: Build bundled Pi Web plugins from TypeScript during development and release packaging while shipping browser-loadable JavaScript modules.
- b637add: Update static file serving and WebSocket dependencies to patched releases, removing controlled dependency warnings and npm audit findings.
- ebe5639: Show active session and terminal activity on project and workspace rows so background work is visible from navigation.

## 1.202605.9

### Patch Changes

- 9c028a7: Move archived session files out of active Pi session directories so normal session lists no longer scan archived histories.
- 1d8dba9: Fix the homepage Keep control card icon so it renders clearly across browsers.
- c5dc655: Replace the chat history banner with a count-based conversation position meter that shows approximate message position without extra requests.
- 6f7713f: Contain long edit diff lines inside the diff viewer so they scroll horizontally within the tool card instead of widening the chat transcript.
- ee6f60f: Improve Pi Web tool cards for edit operations with live preview updates, paired call/result display, and rendered diffs that match the TUI more closely.
- 545499a: Add friendlier rotating in-progress response notices when opening a chat mid-reply.
- 71ce2fb: Make workspace navigation bars horizontally scrollable on desktop and mobile, with side shadows showing when more items are available.
- 547b6e6: Expand the live trailing events group while a session is active, then collapse it again once readable conversation output appears.
- e89441f: Make the mobile navigation panel sections collapsible so projects, workspaces, and sessions can each use more screen space.
- babb802: Add a beta-labeled Pi Web status panel with update instructions tailored to global npm, Pi package, or local installs. The panel appears for update/restart messages and stays visible for local or unknown installs, while keeping the bundled Info plugin as the minimal documented plugin example.
- 6f7713f: Keep chat bubble and event group headers sticky while scrolling so long messages remain easier to orient within the transcript.
- b51d56c: Add theme tokens, a theme picker, and built-in current/docs-inspired themes for the Pi Web UI.

## 1.202605.8

### Patch Changes

- c77c47c: Document the Pi Web CalVer release rule so releases use the release month, increment the patch component for additional releases in the same month, and require explicit user confirmation before any breaking major release.
- 3099579: Document and tighten the Pi Web plugin API around explicit `piWeb.plugins` metadata, versioned browser modules, AI-oriented local plugin development, website plugin docs on pi-web.dev, feedback guidance, and resilient discovery that skips invalid plugins without hiding valid ones.

## 1.202605.7

### Patch Changes

- aab9ffb: Preserve newly started empty sessions and their prompt drafts across browser reloads until the user deletes them.
- c5bc855: Improve `pi-web doctor` and `pi-web install` to use the detected bash, zsh, or fish login shell, verify the systemd user service context can find required commands before installation, and print shell-specific PATH setup advice without persisting transient PATH values.
- 9b1b1bb: Fix the docs mobile navigation so FAQ pages no longer overflow and compact the GitHub/theme controls on small screens.
- 0aa0a13: Fix chat history reloads so previously displayed messages are not duplicated from the browser cache.
- 42cad58: Add remote-first development positioning to the website and docs, including a philosophy page and laptop-versus-server FAQ guidance.
- c66d834: Add a static Pi Web website with installation docs, troubleshooting FAQ, and GitHub Pages deployment.
- 6a8f8b6: Add global web UI `/login` and `/logout` flows for configuring API key and subscription provider authentication.

## 1.202605.6

### Patch Changes

- 559436c: Install Pi Web services from the Pi extension using the normal login-shell command shims instead of hardcoded Node paths, so sessions use the same PATH for node and npm.
- c547478: Keep mobile workspace selection in the Sessions view so users can confirm the remembered session before opening chat, and restore mobile URLs without an explicit view back to Sessions.
- 42b9c53: Remove unsupported direct GitHub install instructions from the README.

## 1.202605.5

### Patch Changes

- a807569: Fix browser terminal sizing so progress/status lines update in place instead of wrapping when the PTY size has not caught up with the visible terminal.
- d064c4e: Improve package gallery discoverability for remote web UI and browser control plane searches.

## 1.202605.4

### Patch Changes

- 7a9e7db: Copying selected rendered chat markdown now places the raw markdown source on the clipboard.
- cf43c95: Formalize release notes with Changesets and project-local skills for changelog and npm publishing workflows.
- e12382c: Keep a new prompt separate from the stopped prompt after aborting a session turn.
