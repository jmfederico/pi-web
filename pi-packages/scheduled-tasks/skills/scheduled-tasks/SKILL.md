---
name: scheduled-tasks
description: Schedule agent work for later, create or change recurring tasks, pause or resume future scheduling, inspect task execution history, or explicitly report an outcome from a task-dispatched conversation in PI WEB.
---

# Scheduled agent tasks

Discover the deferred `scheduled_tasks` tools with `tool_search` or codemode `searchTools`. Use `describeNamespace("scheduled_tasks")` for guidance and inspect each tool's schema before calling it. These tools require this package's enabled PI WEB backend on the session's machine; they do not use the browser's selected machine.

- Start with `scheduled_tasks_overview` for tasks and the configured default timezone. Use `scheduled_tasks_targets` to list registered projects, then supply a project ID to list its workspaces. Do not substitute filesystem paths for IDs.
- Translate the user's request into an initial prompt and either a one-off offset-bearing ISO timestamp or a five-field cron schedule. Store an explicit IANA timezone. If the user omitted it, use the configured default; if there is no default, ask rather than guessing. Resolve material schedule ambiguity before creating a task.
- Preserve intent; do not plan execution. Task creation is transcription plus scheduling, not task execution or investigation. Keep the prompt close to the user's request. Do not add goals, deliverables, obligations, workflows, assessment criteria, limits, tools, files, documentation references, or other implementation choices unless the user explicitly requested them. Leave investigation and execution decisions to the dispatched agent. Ask before making assumptions that materially change the work.
- Populate optional `contextPaths` only when the user explicitly asks to include files. Paths are workspace-relative; the dispatched agent reads their current contents, not snapshots.
- Before creating a task or updating its definition, show the proposed name, exact prompt, schedule, timezone, target project/workspace, and any context paths; for updates, highlight what changes. Use `ask_user` to request explicit confirmation and wait for the answer before calling `scheduled_tasks_create` or `scheduled_tasks_update`. The initial request to schedule or change work is not confirmation of the proposed definition. Request confirmation again if substantive changes follow confirmation; harmless formatting or normalization that preserves meaning does not require renewed confirmation.
- Inspect before edits. `scheduled_tasks_update` replaces the full definition and requires its current revision; preserve unchanged fields. Pause/resume and archive also require the current revision. A stale revision means inspect again, not overwrite blindly.
- Pausing affects future scheduled dispatches only. Archiving also prevents manual dispatch. Neither affects existing conversations. A recurring task dispatches each occurrence independently, even when earlier executions have no outcome report.
- Manual dispatch starts a normal independent conversation without consuming the next scheduled occurrence. Inspect history after a failed or uncertain launch; never blindly retry an ambiguous dispatch. There are no automatic retries.
- Use `scheduled_tasks_history` for paged records and `scheduled_tasks_execution` for the exact dispatched task revision, prompt, context references, conversation ID and all outcome corrections.

## When dispatched from a task

The initial message identifies your task and execution IDs. Retrieve your context with `scheduled_tasks_execution`, read any shared files, then do the requested work. You have the same task-management authority as any ordinary session; no extra plugin-specific approval applies.

Explicitly call `scheduled_tasks_report` with your execution ID, `completed` or `errored`, and a useful summary when you have an outcome. You may correct an earlier report; all reports remain in history. If you are still working or waiting for an answer, leave the execution dispatched. Session idle/error/close signals do not determine its outcome. Reporting does not stop your conversation or disable future occurrences.

## Availability

The scheduler runs while its owning daemon is running, without a browser. It cannot wake the machine. After downtime it skips missed recurring occurrences and dispatches an overdue one-off once. Disabling the plugin stops future dispatches and preserves its SQLite tasks/history and existing conversations.
