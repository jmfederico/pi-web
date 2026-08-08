# Automations

PI WEB automations run prompts in fresh, independent Pi sessions on a selected machine. The long-lived session daemon owns scheduling and execution, so refreshing the browser or restarting the web/API service does not stop active runs.

The target machine and its session daemon must be running to execute a due run. If they are offline at the scheduled time, the run cannot start then; after restart, PI WEB coalesces missed recurring occurrences rather than replaying every one. Local workspaces, credentials, browser bridges, and machine-local tools are not cloud resources and are unavailable while the target machine is offline.

## Open the Automations view

1. Select a machine, project, and workspace.
2. Open **Automations** in the workspace panel tabs.
3. Create a disabled draft.
4. Use **Run now** to test the exact revision.
5. Enable the schedule after the test run completes.

Editing an automation creates a new revision, pauses its schedule, and requires another successful manual test before it can be enabled again.

## Disable automations on a machine

Automations are enabled by default. To turn the feature off for the selected machine, disable **Settings → Session daemon → Workspace automations**, then restart that machine's session daemon.

While disabled, the daemon does not load the automation runtime or SQLite native binding, open the automation database, acquire its ownership record, register automation routes, or poll for due work. The workspace Automations panel is hidden because that daemon no longer advertises support. Definitions and history remain unchanged in `automations.sqlite`; re-enabling resumes from that durable state and coalesces missed recurring occurrences under the normal restart rules.

## Machine federation

Automations belong to the machine that owns the selected workspace. For a federated remote machine, the controlling PI WEB gateway forwards definition, history, model, run, and cancellation requests to that machine. The remote machine's `pi-web-sessiond` stores the automation in its own `$PI_WEB_DATA_DIR`, resolves its own workspace and model configuration, and executes the schedule locally.

The controlling browser and gateway do not need to remain online after a definition is saved. The target machine's session daemon remains the scheduler, so its automations continue through browser disconnects and web/API restarts. The **Automations** panel appears only when the selected machine reports that both its web runtime and session daemon support the `automations` capability. That capability is the baseline federation contract: compatible releases keep its routes and required fields backward-compatible, while future optional or incompatible operations must advertise a separate, feature-specific capability.

Definitions and history are not replicated into the controlling gateway, and removing a machine registration does not delete automations on that machine. PI WEB does not automatically fail over or migrate an automation to another machine. To move one, recreate it explicitly against a destination workspace so that machine can revalidate the model and thinking settings and create its own revision. Session links from run history retain the machine, project, and workspace selection needed to open the resulting remote session.

## Triggers

Every automation can be run manually. Its configured trigger may be:

- **Manual only** — runs only when you select **Run now**.
- **One shot** — runs once at a future timestamp and then disables itself.
- **Interval** — runs at a fixed interval. The minimum interval is one minute.
- **Cron** — uses a six-field cron expression, including seconds, with an explicit IANA timezone such as `Europe/Amsterdam` or `America/New_York`.

Cron and interval schedules may run no more frequently than once per minute. If PI WEB was offline across several interval occurrences, it coalesces the backlog instead of replaying every missed run. The next occurrence is persisted by the session daemon.

An automation never overlaps with another run of the same automation. A scheduled occurrence that collides with an active run is recorded as `skipped` with an overlap reason.

## Model and thinking settings

A job displays the model, provider, thinking policy, and timeout associated with its current revision.

- A **fixed model** pins the provider and model ID. PI WEB validates it again when dispatching the run and does not silently fall back to a different model.
- **Follow machine default** resolves the model when each run starts.
- Thinking can use the model default or a fixed supported level.

Run history freezes the actual model and thinking level used. Later edits or machine-default changes do not rewrite historical records.

## Timeouts and cancellation

The default execution timeout is 60 minutes. The supported range is one minute through 24 hours.

Execution time starts when the fresh session begins running the prompt; queue delay is reported separately. The timeout deadline is persisted, so restarting the web/API service does not reset it.

Select **Cancel** on an active run to request a durable cancellation. PI WEB:

1. records the cancellation before contacting the session;
2. clears queued prompts and requests a soft Pi abort;
3. waits up to 15 seconds for the run to settle;
4. force-closes the runtime if it does not acknowledge the abort.

A run becomes `unknown` when PI WEB cannot prove that cancellation completed. Cancellation cannot undo external effects that already happened, such as a pushed commit, sent message, deployment, or detached child process.

Pausing an automation prevents future scheduled runs; it does not cancel an already active run.

## Run history and visualizations

The Automations view includes:

- a run timeline showing which jobs ran and how long they took;
- completed, failed, timed-out, cancelled, skipped, and unknown outcomes;
- median and p95 execution duration;
- root-session input, output, and cache token totals;
- estimated cost trends and per-automation totals;
- model and thinking-level attribution;
- direct links to the resulting Pi sessions.

Token and cost values are frozen when a run settles. Costs are estimates derived from Pi's model pricing unless a provider reports an authoritative charge. Missing or partial usage remains `unknown`; PI WEB does not display unknown cost as zero.

Current totals cover the fresh root session. Usage from untracked subagents, detached child processes, and external paid tools is not silently included. Future inclusive accounting requires explicit run lineage across those boundaries.

## Run statuses

| Status | Meaning |
| --- | --- |
| `queued` | The occurrence is durably recorded and waiting for capacity. |
| `starting` | PI WEB is resolving the workspace and creating the fresh session. |
| `running` | The prompt is executing. |
| `cancelling` | A user cancellation or timeout is being applied. |
| `completed` | The root agent turn settled. This does not by itself prove a business outcome. |
| `failed` | Setup, model validation, provider execution, or the prompt failed. |
| `cancelled` | A user-requested abort settled. |
| `timed_out` | The execution deadline caused an abort that settled. |
| `skipped` | The occurrence was intentionally not started, currently because of overlap. |
| `unknown` | A restart or force-stop left the final outcome unprovable. |

PI WEB intentionally uses `completed` rather than `succeeded`: an agent finishing a turn does not prove that tests passed, a deployment succeeded, or an external side effect occurred exactly once.

## Persistence and restarts

Automation definitions, revisions, occurrences, attempts, cancellation intent, terminal usage, and run history are stored in `automations.sqlite` under `$PI_WEB_DATA_DIR` (`~/.pi-web` by default). Only `pi-web-sessiond` opens this database. The daemon acquires an exclusive runtime-owner record before listening or recovering work; a second live daemon using the same database refuses to start, while a record left by a dead process is reclaimed.

Browser and web/API restarts reconstruct their view from the daemon. After an unexpected session-daemon restart:

- queued work remains eligible for dispatch;
- ambiguous starting, running, or cancelling attempts become `unknown`;
- PI WEB does not blindly repeat an attempt that may already have caused external effects.

Changes to the automation runtime require a manual restart of `pi-web-sessiond.service`.

The unreleased schedule-plugin prototype used `.pi-web/scheduled-sessions.json`. PI WEB does not import that experimental format because it lacks the immutable revision, attempt, cancellation, and accounting data required by this runtime. If you used the prototype from a development branch, recreate those definitions in the Automations view.

## Security boundaries

A fresh session separates conversational context; it is not a host security sandbox. A Git worktree, when used manually by a prompt, isolates changes but does not restrict filesystem, network, credentials, or process access.

Automations run with the selected machine's Pi configuration and OS-user permissions. PI WEB validates the registered project/workspace identity before every dispatch and never accepts a caller-provided execution directory, but the underlying agent can still use the permissions granted to Pi and the operating-system account.

Review prompts, model settings, tool permissions, network access, and credentials before enabling unattended schedules. Avoid embedding secrets directly in prompts.
