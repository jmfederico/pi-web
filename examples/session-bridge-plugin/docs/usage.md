# Using Workspace Reviews

## Install on the selected machine

This directory is a standalone local Pi package, not a default PI WEB feature. Copy it to a durable location, run `npm install` and `npm run build` there, and install that absolute directory through **Settings → Pi packages** on the machine that will run reviews. Do not also link another copy into the PI WEB plugins directory.

For manual configuration, preserve existing entries and add the package directory to `packages` in the **Pi profile used by that machine's session daemon**:

```json
{ "packages": ["/absolute/path/to/session-bridge-plugin"] }
```

Alternatively, `pi install /absolute/path/to/session-bridge-plugin` updates the CLI's active Pi profile; use it only if that is sessiond's profile. A project-local installation (`pi install -l ...` from the workspace) requires normal project trust. Leave `src/companion.ts` enabled in native resource filters. PI WEB discovers `piWeb.plugins`; Pi separately loads `pi.extensions`. Enabling only the backend is insufficient.

Activate a newly installed backend with a manual target session-daemon restart when safe, then reload the browser. Restarting sessiond interrupts hosted sessions: never do it from a session it owns. For remote machines, install/build/enable on that machine and select it in PI WEB. No hosting-instance installation or restart is part of this example's build or tests.

The example requires the plugin platform release floor declared in `package.json`. For an unreleased PI WEB checkout, build and pack PI WEB first, then install its tarball into this copied example in place of the registry dependency before building. The package remains `private` to prevent accidental npm publication; a built directory can be installed separately, and `npm pack` can archive it. A publisher can choose a package name, remove `private`, and publish the built package explicitly.

## Review and browse

1. Configure a model and its credentials on the target machine.
2. Select a project/workspace and open **Reviews**.
3. Click **Start review** and handle any normal startup/trust prompts. The backend admits one review at a time per workspace and creates a new conversation. It never injects a prompt into your selected existing conversation.
4. Use **Refresh reviews** to see progress. Follow the displayed full session id in Sessions for streaming output, provider errors, or cancellation. Refresh is manual; switching workspaces or refreshing the browser does not stop an admitted review.
5. Choose a dated entry in **Saved reviews**, or cycle with **Previous review / Next review**. Findings are displayed as escaped plain text, not executable HTML or rendered Markdown.

The fixed prompt asks Pi to inspect staged, unstaged, and relevant untracked source changes, including surrounding code. With no changes, it should say so. It asks for actionable bugs, file/line references, impact, fixes to consider, and limitations, without modifying files. It does not compare against a configurable branch or commit, run fixes, or guarantee complete coverage. The workspace is live, not a frozen diff: avoid editing it during a review if you need a consistent target.

**Completed** means a correlated review run settled with a normal, non-empty final assistant text and the backend saved it. It does not mean “no bugs” or certify review quality. “No actionable findings” is ordinary saved text. Any observed provider error, abort, failed tool, truncated/empty final response, or interfering user prompt makes the review fail conservatively, even if a later retry or tool recovery produces text. Do not steer or queue follow-ups into the dedicated review session until it finishes.

**Failed** records explain what went wrong instead of storing partial findings as success. A missing companion receipt times out after five seconds; completion times out ten minutes after kickoff. Check companion enablement/trust, credentials, and the conversation before starting another review. There is no automatic retry. Closing the event connection, timing out, or disconnecting the browser does not stop agent work. Stop it in Sessions if needed.

After a backend restart, a record left running is shown as **interrupted**, never completed. There is no event replay, reconnect, or crash recovery of findings. Inspect the conversation and explicitly start a new review if desired. A session reload/shutdown during capture also fails the review. If a browser request fails after admission, refresh the list before retrying: the review may already exist.

## Storage and ownership

The backend owns JSON files under its host-provided `dataDirectory`, on the selected machine. Each workspace has a SHA-256 directory derived from the host-resolved project/workspace ids; each record has a generated UUID filename. Records contain a creation timestamp, full session id, status, and final findings or failure text. Workspace ids, rather than paths, define history; deleting/recreating an identity does not reassign old reviews.

Writes use an exclusive private temporary file, file sync, and atomic rename. Scope directories and files reject symlinks; peer input can only select a validated review id, not a path. Readers validate records and fail visibly on corrupt data. There is no separate host state-store capability, project config, or assistant-authored findings path. Storage failures are shown on refresh when the backend remains alive and logged; if a write fails and the backend then exits, the last durable running record is shown as interrupted.

The initial running record is saved before creating a session, then updated with the session id before kickoff. A crash between session creation and that update can leave an empty id in the record; find the new conversation in Sessions. This is not a transactional durable job queue.

Findings are limited to 48,000 JavaScript string characters (the prompt asks for fewer than 12,000). Oversized findings fail rather than silently truncate. List responses include metadata only; reading fetches one text record. This intentionally small archive scans its files on refresh, with no pagination, retention policy, delete UI, automatic migrations, or multi-process writer coordination. Back up or prune plugin-owned files offline as needed; do not have two backend processes share the same directory. Files may contain sensitive code details and are not encrypted. Atomic visibility is provided, not a guarantee against every power-loss scenario.

## Native Pi and host boundaries

- `src/browser/index.ts` uses only selected-machine `context.peer`. UI state is keyed by machine/project/workspace; late replies cannot populate another scope. Browser modules and their shared protocol stay within `browserRoot`, including on nested deployments.
- `src/server.ts` resolves the two public session capabilities in `start()`, creates a session in host-resolved workspace authority, then connects separately. An admitted run belongs to the plugin lifetime, not the short browser request. Disposal closes capture through lifetime cancellation; it does not own the hosted session.
- `src/companion.ts` uses native `pi.sendUserMessage`, `before_agent_start`, message/tool hooks, and `agent_settled`. A generated request id appears in the kickoff prompt and reply events; the backend subscribes before emitting. Receipt and final completion are distinct. `agent_end` alone is not completion because retries and compaction can follow it.
- The companion has no standalone SDK runtime and does not write storage files. Outside PI WEB it loads harmlessly but has no review panel/backend to request or save work.

This is trusted-author tooling, **not a read-only sandbox**. “Do not modify files” is a model instruction; normal Pi tools, project instructions, and installed extensions still have their usual permissions. Do not use it where prompt-only protection is insufficient. Other installed extensions can affect model behavior and can emit events on the same native bus. The protocol correlates cooperative events; it is not authentication against malicious extensions.

See the [PI WEB plugin guide](https://pi-web.dev/plugins) for discovery, capability and peer limits, trust, and lifecycle contracts. Source is strict TypeScript; the example build uses `skipLibCheck` for native Pi dependency declarations. The repository's installed-package smoke separately checks standalone browser/backend declarations with library checking enabled.
