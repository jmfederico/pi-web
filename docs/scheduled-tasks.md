# Scheduled agent tasks

Schedule agent work from an ordinary PI WEB conversation. At each due time, the plugin starts a normal conversation in the chosen workspace and records the dispatch. Use the read-only **Scheduled tasks** tab to review schedules and execution history; ask an agent to make changes.

This is separate from [Workspace Tasks](plugins.md#workspace-tasks), which runs project commands in terminals from `.pi-web/tasks.json`.

## Install and enable

Scheduled agent tasks ships with PI WEB as an optional package, `@jmfederico/pi-web-scheduled-tasks`. It is not installed automatically, and its web plugin is disabled by default.

1. On the machine that will run the schedules, open **Settings → Pi packages → Available packages** and install **Scheduled agent tasks**. Use the shipped package offered there; no separate npm publication is required.
2. Open **Settings → PI WEB plugins** and enable `scheduled-tasks`.
3. Optionally configure the default timezone below.
4. When safe, manually restart that machine's session daemon, then reload the browser. For an existing idle conversation, run `/reload` to load the package's extension and discovery skill, or start a new conversation.

**Restarting the session daemon interrupts active sessions and terminals.** Check active work first and restart from outside its hosted sessions. Follow the [plugin installation and restart guidance](plugins.md#install-and-manage) for your deployment. A browser refresh, web/API restart, or conversation `/reload` alone does not activate the backend or changed plugin settings.

Installation and settings apply to the machine selected in Settings. Each task targets a registered project and workspace on that same machine. An agent's task tools use its conversation's machine, not the browser's selected machine; this is not a cross-machine scheduling service.

## Default timezone

Set `plugins.scheduled-tasks.settings.defaultTimezone` in the machine's global [PI WEB configuration](config.md). For example, merge this into `$PI_WEB_CONFIG`, or the default `$XDG_CONFIG_HOME/pi-web/config.json` (`~/.config/pi-web/config.json` when unset):

```json
{
  "plugins": {
    "scheduled-tasks": {
      "enabled": true,
      "settings": {
        "defaultTimezone": "Europe/London"
      }
    }
  }
}
```

Use an IANA timezone such as `Europe/London`, `America/New_York`, or `UTC`. Settings currently edits enablement, not this timezone value. The plugin reads machine-global settings at activation; restart the session daemon when safe to apply a change. It does not use project-local timezone overrides.

There is no built-in timezone default. If a request omits the timezone, the tools use the configured default. Without either, the agent must ask you rather than guess from the browser, machine clock, or interface region settings. Every saved task stores its resolved timezone explicitly; changing the default does not reschedule existing tasks. An invalid configured timezone prevents backend activation.

## Ask an agent to schedule work

Describe the work, target workspace, and timing in a conversation on the scheduling machine. For example:

> Every weekday at 09:00 Europe/London, review new issues for this project and summarize anything needing a decision. Read `maintenance/issue-review.md` for the review criteria.

Or request a one-off investigation with a specific date, time, and timezone. These are prompts for ordinary agents, not built-in GitHub or maintenance integrations. The dispatched conversation has the normal session's capabilities and access; any credentials or external integrations must already be available there.

The package includes a small `scheduled-tasks` discovery skill. Its `scheduled_tasks_*` tools are **deferred**: their full schemas are not automatically added to every conversation. Agents find them through `tool_search` or codemode `searchTools` and inspect the `scheduled_tasks` namespace before use. Tool discovery may succeed while backend calls remain unavailable if the web plugin is disabled, not yet activated, or unhealthy. The backend requires a supporting PI WEB-hosted session; it does not fall back to a standalone HTTP scheduler.

Agents can discover registered project/workspace IDs, create and inspect tasks, replace definitions, pause/resume, archive, permanently delete archived tasks, manually dispatch, inspect history and exact execution context, and report outcomes. There is no additional plugin-specific approval gate, including for task-dispatched agents. Normal session permissions and instructions still apply.

Edits use the current task revision to avoid silently overwriting another change. Agents should inspect first and preserve unchanged fields when replacing a definition.

## Schedules and future dispatches

- **One-off:** an ISO timestamp with `Z` or an explicit UTC offset, stored in UTC. The task still stores an explicit timezone.
- **Recurring:** a deterministic five-field cron expression, with minute granularity, interpreted in the task's timezone. For example, `0 9 * * 1-5` means 09:00 Monday–Friday in that zone. Timezone and daylight-saving transitions follow the cron parser; this is not a fixed elapsed-time interval. Randomized `H` expressions are not supported.
- **Shared context:** optional workspace-relative file references. The dispatched agent reads their current contents; the plugin preserves the references, not snapshots of the files.

The scheduler runs without an open browser while its owning session daemon and machine are running. It cannot wake a sleeping machine or dispatch while the daemon is stopped. On startup, it skips missed recurring occurrences and dispatches an overdue one-off once. Each recurring occurrence is independent: an earlier execution without an outcome report does not block the next.

Pausing stops future scheduled dispatches. Archiving also prevents manual dispatch. Neither action changes conversations already started. Manual dispatch is allowed while paused and does not consume the next scheduled occurrence. Editing a consumed one-off's prompt does not schedule it again; explicitly changing its schedule does.

To permanently remove a task, archive it first, then ask an agent to delete it. Deletion requires the archived task's current revision and removes the task, every saved definition revision, and all execution history and outcome reports. It cannot be undone. Existing conversations and their transcripts remain intact and are not stopped; reporting outcomes for deleted executions fails. Deletion is temporarily rejected while a dispatch is being admitted; wait for it to settle and inspect the task again before retrying.

There are no automatic execution retries. A scheduled occurrence is consumed even if launch fails or cannot be confirmed. Inspect its history and existing conversations before asking for another dispatch, especially when the result is uncertain.

## Tasks, executions, and conversations

These are separate records:

- A **task** defines instructions, target, schedule, timezone, and whether future scheduling is paused or archived.
- An **execution** records one scheduled or manual dispatch, including the exact task revision and instructions used, dispatch identity, and explicit outcome reports.
- A **conversation** is the normal PI WEB session created by that dispatch. Its transcript stays in ordinary session storage.

Execution history distinguishes these states:

| State | Meaning |
| --- | --- |
| `dispatching` | Launch has been reserved and is in progress. |
| `dispatched` | Launch was confirmed; no explicit outcome has been reported. |
| `completed` | An agent explicitly reported completion with a summary. |
| `errored` | An agent explicitly reported an error outcome with a summary. |
| `failed` | Launch was rejected before a conversation was published. |
| `uncertain` | Launch could not be confirmed or safely ruled out; inspect before redispatching. |

An interrupted `dispatching` record becomes `uncertain` on startup, rather than being blindly retried. Local database transactions protect records, but do not promise exactly-once session launch or external effects.

The initial message tells a dispatched agent its task and execution IDs, how to retrieve context with `scheduled_tasks_execution`, and how to report `completed` or `errored` with `scheduled_tasks_report`. Later explicit corrections are allowed; previous reports remain in history.

**Execution outcomes are not inferred from conversation activity.** Becoming idle, waiting for your answer, finishing a turn, encountering a session error, or closing a session does not change the recorded outcome. An execution can remain `dispatched` after its conversation stops. Reporting completion does not stop the conversation or disable a recurring task.

The plugin does not pause, resume, cancel, supervise, or change the capabilities of dispatched conversations. Continue or manage them through ordinary PI WEB session controls.

## Read-only dashboard

The **Scheduled tasks** tab opens a read-only overview grouped by what needs review:

- **Needs attention:** non-archived tasks whose latest execution is `failed`, `errored`, or `uncertain`.
- **Recent results:** up to five non-archived tasks whose latest run reported completion, ordered by run creation time, not completion time.
- **Up next:** up to five active, unpaused, non-archived tasks with a next due time, soonest first.
- **Awaiting an outcome:** executions marked `dispatching` or `dispatched`. This does not mean their conversations are still running; status is never inferred from session activity.

The collapsed **All tasks** section contains every task, including paused and archived tasks. Overview cards show shortened reports. Select a task to open its dedicated detail view with the full report, next due time, paginated execution history, and available conversation links. Native **Technical details** disclosures hold exact schedules, timezones, target IDs, execution revisions, session IDs, and diagnostics. Open the separate **All history** view on demand to browse history across tasks.

The dashboard has no task-editing controls. Its collapsed help directs you to ask an agent in a conversation to create, change, pause, reschedule, or archive tasks. Agents also support manual dispatch. Workspace Tasks' separate **Tasks** tab runs terminal commands; it does not manage these schedules.

## Persistence and disabling

The plugin owns one SQLite database, `tasks.sqlite`, in its host-provided persistent `dataDirectory`, shared across projects for that plugin installation on the machine. No separate database service is required. The database stores task definitions and revisions, prompts, explicit timezones, schedules, execution history, outcome reports/corrections, and dispatch identity records. The plugin owns schema migrations.

These are machine-local managed records, not user-editable project configuration. Do not put task definitions in `.pi-web/config.json` or `.pi-web/tasks.json`. Shared context remains in workspace files; conversation transcripts remain in PI WEB session storage rather than being copied into SQLite. Keep the host's persistent data directory on persistent storage if deploying in a container.

Browser and daemon restarts, package updates, and disabling the plugin preserve its saved tasks and history. Disabling takes effect after the required session-daemon restart: until then, the active backend may still dispatch. Once disabled, it prevents future dispatches without controlling existing conversations. Agent resources may remain loaded, but backend calls fail explicitly while disabled.

To stop future scheduling without restarting the daemon, ask an agent to pause the relevant tasks. Manage already-dispatched conversations separately. Re-enabling resumes from saved records using the downtime rules above; it does not replay missed recurring work.
