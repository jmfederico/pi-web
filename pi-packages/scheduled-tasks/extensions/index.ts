import { Type, type TSchema } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createCompanionBackend, type JsonValue } from "@jmfederico/pi-web/server-plugin-api";

const id = (description: string) => Type.String({ minLength: 1, maxLength: 512, description });
const taskId = id("Task ID returned by scheduled task tools.");
const executionId = id("Execution ID returned by dispatch or history, or included in the task's initial message.");
const revision = Type.Integer({ minimum: 1, description: "Current task revision from inspect; stale writes reject. Read again before retrying." });
const definition = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 512 }),
  projectId: id("Registered project ID from scheduled_tasks_targets; not a filesystem path."),
  workspaceId: id("Registered workspace ID from scheduled_tasks_targets; not a filesystem path."),
  prompt: Type.String({ minLength: 1, maxLength: 49152, description: "Initial instructions for a normal conversation." }),
  timezone: Type.Optional(Type.String({ description: "IANA timezone. Omit only to use the configured default; if no default exists, ask the user." })),
  schedule: Type.Union([
    Type.Object({ kind: Type.Literal("once"), at: Type.String({ description: "Future ISO timestamp with an explicit UTC offset or Z." }) }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal("cron"), expression: Type.String({ description: "Deterministic five-field cron expression, evaluated in the task timezone." }) }, { additionalProperties: false }),
  ]),
  contextPaths: Type.Optional(Type.Array(Type.String({ description: "Workspace-relative shared context file; read when dispatched, not snapshotted." }), { maxItems: 32 })),
}, { additionalProperties: false });
const object = (properties: Record<string, TSchema>) => Type.Object(properties, { additionalProperties: false });

/** Thin deferred transport: the daemon owns all state, validation and dispatch. */
export default function scheduledTasksExtension(pi: ExtensionAPI): void {
  function register(operation: string, description: string, parameters: TSchema, readOnly: boolean): void {
    pi.registerTool(defineTool({
      name: `scheduled_tasks_${operation}`,
      label: `Scheduled tasks: ${operation}`,
      description,
      exposure: "deferred",
      namespace: {
        name: "scheduled_tasks",
        description: "Create and manage machine-local scheduled agent tasks and explicit execution outcomes.",
        instructions: "Use targets for registered project/workspace IDs. Inspect before revision-checked edits. Ask for timezone if no configured default exists. Pause/archive affect only future scheduling. Delete requires an archived task and permanently removes it and all its history, not conversations. Dispatch creates an ordinary independent conversation. Never infer an execution outcome from session activity; use report explicitly. Do not blindly repeat a dispatch after an error or uncertainty; inspect history first.",
      },
      annotations: { readOnlyHint: readOnly, destructiveHint: operation === "delete", openWorldHint: !readOnly, idempotentHint: readOnly },
      parameters,
      async execute(_toolCallId, input, signal) {
        signal?.throwIfAborted();
        const peer = createCompanionBackend(pi.events, "scheduled-tasks").forScope({ kind: "machine" });
        if (peer.request === undefined) throw new Error("Scheduled tasks backend does not support requests");
        // Pi validates the TypeBox object before execution; backend validation is authoritative.
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- JSON tool input at the transport boundary.
        const result = await peer.request(operation, input as JsonValue, signal === undefined ? {} : { signal });
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
    }));
  }
  register("targets", "List registered local projects, or workspaces for a project. Use these opaque IDs when creating tasks.", object({ projectId: Type.Optional(id("Omit to list projects; supply a project ID to list its workspaces.")) }), true);
  register("overview", "List scheduled tasks, configured default timezone, next dispatches and latest explicit execution outcomes.", object({}), true);
  register("inspect", "Read a task's full current definition and revision before editing it.", object({ taskId }), true);
  register("create", "Create a one-off or recurring agent task. Resolve target IDs with targets first. If timezone is omitted and no default exists, ask the user; do not guess.", definition, false);
  register("update", "Replace a task definition at its current revision. Preserve unchanged fields from inspect. Changes affect future dispatches, not existing conversations.", object({ taskId, revision, definition }), false);
  register("pause", "Pause or resume future scheduled dispatches. Does not pause or resume any existing conversation.", object({ taskId, revision, paused: Type.Boolean() }), false);
  register("archive", "Archive a task, preventing future scheduled and manual dispatches. Preserve history and existing conversations.", object({ taskId, revision }), false);
  register("delete", "Permanently delete a task and all its revisions, execution history and outcome reports. Only archived tasks can be deleted; archive first and use its new revision. Existing conversations and their transcripts are not deleted or stopped. Rejects while dispatch admission is in progress; inspect again before retrying.", object({ taskId, revision }), false);
  register("dispatch", "Manually dispatch one execution as a normal independent conversation, including for a paused task. Does not consume its scheduled occurrence. Inspect history before retrying any ambiguous result; no automatic retries.", object({ taskId }), false);
  register("history", "Read paged execution history and conversation IDs, optionally limited to one task. Outcomes are explicit reports, not session status.", object({ taskId: Type.Optional(taskId), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })), offset: Type.Optional(Type.Integer({ minimum: 0 })) }), true);
  register("execution", "Retrieve an execution's dispatched task revision, instructions, shared context paths, conversation identity and full outcome correction history.", object({ executionId }), true);
  register("report", "Explicitly report a completed or errored execution with a summary, or correct a previous report. Corrections retain history. Reporting does not stop the conversation or disable a recurring task.", object({ executionId, outcome: Type.Enum(["completed", "errored"]), summary: Type.String({ minLength: 1, maxLength: 16384 }) }), false);
}
