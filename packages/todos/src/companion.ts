import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createCompanionBackend, type JsonValue } from "@jmfederico/pi-web/server-plugin-api";
import { resultProject, resultTask, resultTasks } from "./browser/protocol.js";

const status = Type.Union([Type.Literal("Open"), Type.Literal("Doing"), Type.Literal("On hold"), Type.Literal("Done")]);
const project = Type.Object({ id: Type.String(), label: Type.String(), kind: Type.Union([Type.Literal("git"), Type.Literal("local")]) });
const namespace = { name: "todos", description: "One shared authoritative to-do list", instructions: "Use todos_list or todos_read to obtain the latest revision before updating. Never automatically retry a conflict. Archived tasks are retained, not deleted. Use todos_project with an absolute local directory to resolve project assignment/filter identity; never fabricate identities. Omitted project keeps an existing assignment; null unassigns. Non-Git identities belong to the originating machine, even on the central list." };

export default function companion(pi: ExtensionAPI): void {
  async function request(operation: string, input: JsonValue, signal?: AbortSignal) {
    const value = await createCompanionBackend(pi.events, "todos").request(operation, input, signal === undefined ? {} : { signal });
    if (operation === "resolve-project") resultProject(value);
    else if (operation === "list") resultTasks(value);
    else resultTask(value);
    return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value, structuredContent: value };
  }
  const outputSchema = Type.Unknown();
  pi.registerTool(defineTool({
    name: "todos_project", label: "Resolve to-do project", namespace, outputSchema,
    description: "Resolve an absolute project directory on this session's machine, not the central server. Returns a descriptor for todos_mutate.project and its id for todos_list.project. Equivalent network Git origins share identity; non-Git/no-origin/local-origin directories use persistent machine-local identity. No task is created or changed.",
    annotations: { readOnlyHint: true }, parameters: Type.Object({ path: Type.String() }),
    execute: (_id, input, signal) => request("resolve-project", input, signal),
  }));
  pi.registerTool(defineTool({
    name: "todos_list", label: "List to-dos", namespace, outputSchema,
    description: "List shared to-dos. Filters combine project ID (null for unassigned; omitted for all projects), status, case-insensitive title/context text, and archived (default false; all includes both). Resolve this machine's directory with todos_project before filtering by project. No workspace selection is required.",
    annotations: { readOnlyHint: true },
    parameters: Type.Object({ status: Type.Optional(status), text: Type.Optional(Type.String()), archived: Type.Optional(Type.Union([Type.Boolean(), Type.Literal("all")])), project: Type.Optional(Type.Union([Type.String(), Type.Null()])) }),
    execute: (_id, input, signal) => request("list", input, signal),
  }));
  pi.registerTool(defineTool({
    name: "todos_read", label: "Read to-do", namespace, outputSchema,
    description: "Read one shared task by ID, including archived tasks and its current edit revision.",
    annotations: { readOnlyHint: true }, parameters: Type.Object({ id: Type.String() }),
    execute: (_id, input, signal) => request("read", input, signal),
  }));
  pi.registerTool(defineTool({
    name: "todos_mutate", label: "Create or update to-do", namespace, outputSchema,
    description: "Without id, create with required title (max 200 characters), optional short context (max 2000), status (default Open), and archived (default false). With id, update only supplied attributes and require its current revision. Archive/restore by changing archived. Missing IDs and stale revisions fail; never retry automatically. For assignment, pass a todos_project descriptor; null unassigns and omission preserves assignment on update.",
    parameters: Type.Object({
      id: Type.Optional(Type.String()), revision: Type.Optional(Type.Integer({ minimum: 1 })), title: Type.Optional(Type.String()),
      context: Type.Optional(Type.String()), project: Type.Optional(Type.Union([project, Type.Null()])), status: Type.Optional(status), archived: Type.Optional(Type.Boolean()),
    }),
    execute: (_id, input, signal) => request("mutate", input, signal),
  }));
}
