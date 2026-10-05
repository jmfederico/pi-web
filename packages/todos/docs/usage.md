# Shared to-dos

## Install and configure

Build the standalone package using the commands in [its README](../README.md). The repository build resolves only the host's **emitted public declarations**; it does not add this package to the host distribution. For development from a separate source checkout with the matching PI WEB peer and declared development dependencies installed, `npm run build` uses the package's own `tsconfig.json`. `npm pack` then builds and packs the standalone package. The repository's prebuilt-artifact smoke instead packs a temporary copy without lifecycle scripts.

Install the built `packages/todos` directory via **Settings → Pi packages** on each participating machine. The path must exist on the selected machine. Ensure that the matching PI WEB package is resolvable as the `@jmfederico/pi-web` peer beside the companion package; Pi-managed installations suppress automatic peer installation. For a standalone local development directory outside the host's dependency tree, provision that peer explicitly (for example, `npm install --no-save --package-lock=false /path/to/the/built/pi-web`). Do not substitute a URL in the package's role settings.

In the machine-global config (`$PI_WEB_CONFIG` or `~/.config/pi-web/config.json`), configure exactly one authoritative server:

```json
{
  "plugins": {
    "todos": {
      "enabled": true,
      "settings": { "role": "server" }
    }
  }
}
```

On each client, register the server under PI WEB's machine Settings, then use its **registry-local machine ID**:

```json
{
  "plugins": {
    "todos": {
      "enabled": true,
      "settings": { "role": "client", "targetMachineId": "central-server-id" }
    }
  }
}
```

The package is disabled by default. There is no role/target configuration UI. Missing/invalid roles, targets and unsupported hosts fail explicitly. A client never creates a fallback task database, retries a mutation, or switches to another authority when a remote request fails. Point clients directly to the server, not to another client.

Update web/API processes on affected hosts to a version supporting the public transport, then safely restart their session daemons and reload the browser. **A daemon restart interrupts its active sessions and terminals, including sessions running the restart command.** Inspect and finish active work first; restart from an external terminal or service manager, not from a hosted agent session. For the native systemd user install, the manual order is:

```sh
systemctl --user restart pi-web-ui-dev.service
systemctl --user restart pi-web-sessiond.service
```

Use the equivalent web/API-before-session-daemon ordering for other install modes. This guide does not authorize a live restart or deployment. Changes to server plugin settings/code require another safe daemon restart. Pi's `/reload` refreshes the companion in an idle hosted session, not its server backend.

## Use the tab and tools

Open **To-dos** without selecting a project, workspace or conversation. **Project** offers this machine's registered projects and descriptors already encountered in the list; choose **Unassigned** for the shared bucket. Registered directory choices are resolved by this machine's backend when saving. Editing preserves the stored assignment, including projects from another machine, unless you change it. Create a title (1–200 characters) and optional short context (up to 2,000 characters). Select Open, Doing, On hold or Done. **Edit** loads the displayed task revision; **Save** updates it. Check **Archived** to archive and uncheck it to restore. **New task** clears the editor. Nothing deletes a task.

**Refresh** loads the authoritative list, combining **Filter project** (all projects by default, unassigned, a registered local directory or an encountered stored descriptor), a case-insensitive title/context search, a status filter and archived selection (not archived by default). A local directory filter is resolved on the current machine before querying the central list. To discover archived/foreign assignments, first use All projects and the appropriate archived selection. Registered project choices are captured when opening the tab; reopen it after changing PI WEB's project registry. The list is not live-pushed; refresh after edits from another tab or agent. An outdated edit is rejected and its draft retained. Refresh, inspect the current task, and choose **Edit** again before intentionally reapplying your changes; the package never silently rebases your draft. A network timeout may happen after a remote write committed: inspect the list before retrying a create.

In a hosted session on a participating machine:

- `todos_project`: resolve `{ "path": "/absolute/project/directory" }` on the hosted session's machine, not on the central server. Returns `project: { id, label, kind }`; use that descriptor for assignment and its `id` for filtering. The directory need not be registered in PI WEB. No task is changed.
- `todos_list`: list/filter by `status`, `text`, `archived` (boolean or `"all"`), and `project` (a resolved ID, `null` for the shared unassigned bucket, or omitted for all projects).
- `todos_read`: read `{ "id": "task-id" }`, including archived tasks and the current revision.
- `todos_mutate`: one create-or-update operation. Without `id`, a title is required; defaults are empty context, unassigned, Open and not archived. With `id`, the current `revision` is required and **only supplied attributes change**. Missing IDs fail rather than creating a new task. Archive/restore by supplying `archived`, using the same operation.

Example create:

```json
{ "title": "Check the release", "context": "Confirm the smoke checks", "status": "Open" }
```

Example update after reading revision 1:

```json
{ "id": "the-returned-id", "revision": 1, "status": "Doing" }
```

To assign a project, call `todos_project`, then pass its returned descriptor as `todos_mutate.project`. To unassign an existing task, pass `project: null` with its current ID/revision. Omitting `project` on update keeps the stored assignment; omitting it on create uses the shared unassigned bucket. `todos_list.project` takes the descriptor's **ID**, not its directory path or full descriptor. Do not fabricate project IDs.

The backend operations are `resolve-project`, `list`, `read`, `mutate`; successful responses contain `ok: true` and `project`, `tasks` or `task`. Validation, missing IDs and stale edits return `ok: false` with `error.code` (`invalid`, `missing`, `conflict`) and a message. Companion tools turn those failures into failed tool results. Transport/database failures reject. There is no tool-side remote URL logic or model use by the package itself. Outside a supporting PI WEB hosted session, the tools fail immediately.

## Project identity

Resolution reads Git on the originating backend using the host's bounded command service. Equivalent SSH/scp, HTTPS, HTTP and Git network origins match after removing credentials, protocol, default ports, leading/trailing slashes and a trailing `.git`, and lowercasing the hostname. Repository path case and non-default ports remain significant. For example, `git@example.com:Owner/Repo.git` and `https://example.com/Owner/Repo/` share an ID. No DNS/SSH-alias resolution or provider-specific repository renaming is performed. Git inspection errors are visible, not silently converted into local identity.

For a non-Git directory, a Git repository without origin, or a local/file/unsupported origin, identity combines a persistent package-generated machine UUID with the canonical directory path (Git root for repositories). A symlink to the same directory on that machine matches; the same path on a different machine does not. These tasks still live in the central SQLite store and appear in the global list. A stored foreign descriptor can be explicitly preserved/reused; it is never automatically matched to a current-machine directory. Only descriptors (ID, display label, Git/local kind) are stored on tasks, not origin credentials or local paths.

Keep `project-machine-id` in each participating machine's persistent plugin data directory across upgrades and restarts, including **clients**. Do not clone that file onto another machine: it defines the originating machine's identity. Losing it or moving a local directory yields a new local identity; old tasks remain accessible globally and can be explicitly reassigned with the normal revision-checked mutation. Changing an origin likewise affects future resolution, not saved assignments. Labels are display snapshots, not identity or authorization.

## Storage and limits

Only the server opens `todos.sqlite` in its host-supplied persistent plugin `dataDirectory` (normally `$PI_WEB_DATA_DIR/plugin-data/todos`). Identity is a stable task ID; edit revision starts at 1 and advances on every accepted mutation. SQLite's normal transactions/locking make the revision check atomic even across independent connections. Node 22's built-in SQLite API emits its expected experimental-feature warning; no native addon or runtime upgrade is required.

Keep the plugin data directory when upgrading/reinstalling package code. Schema v2 automatically upgrades the original v1 database while retaining every saved unassigned task, ID, revision and timestamp; assigned descriptors use its nullable project column. Update the package on **all** participating machines before using project assignments. Older package code cannot read schema v2; retain a quiesced backup before upgrade rather than downgrading the live database. To back up the database, quiesce writes and safely stop the server's daemon from outside hosted sessions, then copy the plugin data directory before restarting it. Do not copy only part of a database while it is being written. Switching a machine's role does not migrate or merge databases. Choose one authority and keep clients directed at it.

There are no work/personal categories, deletion, stored priority, dates, recurrence or board. Project identity is not an ACL: all exposed operations keep PI WEB's existing accessibility. Project assignment descriptors are validated, not a new host authority/security grant.

The package inherits PI WEB's existing HTTP accessibility and trusted-plugin model. It adds no listener, authentication, ACL, or approval layer. Install only on hosts whose existing accessibility is appropriate for your task data.
