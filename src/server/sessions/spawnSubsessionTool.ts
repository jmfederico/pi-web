import { Type } from "typebox";
import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TranscriptContentKind, TranscriptEntry, TranscriptRole, TranscriptView } from "./subsessionTranscript.js";

/** Lifecycle phase of a tracked subsession as seen by its parent. */
export type SubsessionStatus = "working" | "idle" | "error" | "unknown";

export interface SpawnSubsessionResult {
  sessionId: string;
  cwd: string;
}

export type SpawnSubsessionModel = NonNullable<ExtensionContext["model"]>;

export interface SpawnSubsessionInvocation {
  /** cwd of the session that invoked the tool (used for project-scope checks). */
  spawningCwd: string;
  /** Session id of the parent; the spawned session is tracked against it. */
  parentSessionId: string;
  /** Session file of the parent, recorded in the child's `parentSession` header. */
  parentSessionFile: string | undefined;
  prompt: string;
  cwd: string | undefined;
  /** Current model from the dispatching session, used as the spawned session's default. */
  model?: SpawnSubsessionModel;
}

export interface SubsessionSummary {
  sessionId: string;
  cwd: string;
  status: SubsessionStatus;
}

/** Quick glance at a subsession: status plus its most recent assistant output. */
export interface SubsessionCheckResult {
  sessionId: string;
  cwd: string;
  status: SubsessionStatus;
  finalText: string;
  messageCount: number;
}

/** Exploratory transcript read: a filtered, paginated slice of the subsession's history. */
export interface SubsessionReadResult extends TranscriptView {
  sessionId: string;
  cwd: string;
  status: SubsessionStatus;
}

/** Filters the parent passes to narrow a transcript read; mirrors {@link TranscriptQuery}. */
export interface SubsessionReadQuery {
  roles?: TranscriptRole[];
  include?: TranscriptContentKind[];
  search?: string;
  maxChars?: number;
  includeToolArgs?: boolean;
  before?: number;
  limit?: number;
}

export interface SubsessionToolDeps {
  spawn(input: SpawnSubsessionInvocation): Promise<SpawnSubsessionResult>;
  list(parentSessionId: string, parentSessionFile?: string): Promise<SubsessionSummary[]>;
  check(parentSessionId: string, sessionId: string, parentSessionFile?: string): Promise<SubsessionCheckResult>;
  read(parentSessionId: string, sessionId: string, query: SubsessionReadQuery, parentSessionFile?: string): Promise<SubsessionReadResult>;
}

const SpawnSubsessionParams = Type.Object({
  prompt: Type.String({
    description: "The first instruction to send to the new tracked subsession.",
  }),
  cwd: Type.Optional(Type.String({
    description: "Working directory for the subsession. Must be a workspace (worktree, or root) of the same project as this session. Defaults to this session's working directory.",
  })),
});

const ListSubsessionsParams = Type.Object({});

const CheckSubsessionParams = Type.Object({
  sessionId: Type.String({
    description: "Id of a tracked subsession owned by the calling session, as returned by spawn_subsession or list_subsessions.",
  }),
});

const ReadSubsessionParams = Type.Object({
  sessionId: Type.String({
    description: "Id of a tracked subsession owned by the calling session, as returned by spawn_subsession or list_subsessions.",
  }),
  roles: Type.Optional(Type.Array(
    Type.Union([Type.Literal("assistant"), Type.Literal("user"), Type.Literal("tool"), Type.Literal("system"), Type.Literal("custom")]),
    { description: "Message roles to include. Omit for all roles." },
  )),
  include: Type.Optional(Type.Array(
    Type.Union([Type.Literal("text"), Type.Literal("thinking"), Type.Literal("tool_call"), Type.Literal("tool_result"), Type.Literal("image")]),
    { description: "Content kinds to keep within messages. Omit for all kinds." },
  )),
  search: Type.Optional(Type.String({
    description: "Case-insensitive substring; keep only messages whose text or tool name matches. Always searches full message content, even when maxChars is set.",
  })),
  maxChars: Type.Optional(Type.Integer({
    minimum: 0,
    description: "Truncate each text/thinking/tool-result value to this many characters; clipped parts are marked '[+N chars truncated]'. Omit for full, untruncated text (there is no default, so truncation only happens when you ask for it).",
  })),
  includeToolArgs: Type.Optional(Type.Boolean({
    description: "Include raw tool-call arguments (can be large). A compact one-line summary of each call is always shown regardless.",
  })),
  before: Type.Optional(Type.Integer({
    minimum: 0,
    description: "Return only messages before this transcript index; page backward by passing the previous response's 'start'.",
  })),
  limit: Type.Optional(Type.Integer({
    minimum: 1,
    description: "Maximum number of most-recent matching messages to return within the window (returned in chronological order). Defaults to 50.",
  })),
});

function statusLine(summary: SubsessionSummary): string {
  return `- ${summary.sessionId} [${summary.status}] in ${summary.cwd}`;
}

function renderEntry(entry: TranscriptEntry): string {
  const header = `#${String(entry.index)} ${entry.role}`;
  const body = entry.parts.map(renderPart).filter((line) => line !== "").join("\n");
  return body === "" ? header : `${header}\n${body}`;
}

function clipNotice(part: TranscriptEntry["parts"][number]): string {
  if ((part.kind === "text" || part.kind === "thinking" || part.kind === "tool_result") && part.truncated !== undefined) {
    return ` [+${String(part.truncated.full - part.truncated.shown)} chars truncated]`;
  }
  return "";
}

function renderPart(part: TranscriptEntry["parts"][number]): string {
  if (part.kind === "text") return `${part.text}${clipNotice(part)}`;
  if (part.kind === "thinking") return `[thinking] ${part.text}${clipNotice(part)}`;
  if (part.kind === "tool_call") {
    // Raw args are only present when the caller asked (includeToolArgs); when
    // present, surface them in the model-facing text, not just `details`.
    const args = "args" in part && part.args !== undefined ? `\n  args: ${JSON.stringify(part.args)}` : "";
    return `[tool ${part.toolName}] ${part.summary}${args}`;
  }
  if (part.kind === "tool_result") return `[result${part.isError ? " error" : ""}${part.toolName === undefined ? "" : ` ${part.toolName}`}] ${part.text}${clipNotice(part)}`;
  return "[image]";
}

function renderTranscript(result: SubsessionReadResult): string {
  const last = result.entries[result.entries.length - 1];
  // Distinguish "nothing matched at all" (widen filters) from "matches exist but
  // this page/window is empty" (page differently) so the agent isn't misled.
  const range = last === undefined
    ? (result.matched === 0
      ? "no messages matched your filters"
      : `no messages in this window (${String(result.matched)} matched outside it)`)
    : `messages ${String(result.start)}–${String(last.index)} of ${String(result.total)} (${String(result.matched)} matched)`;
  const more = result.hasMore ? `\n\nEarlier matching messages exist before index ${String(result.start)}.` : "";
  // Empty entries with matches means the `before` cursor excluded every match
  // (they all sit at index >= before): the agent paged too far back and should
  // raise `before` or omit it, not page back further.
  const body = result.entries.length > 0
    ? result.entries.map(renderEntry).join("\n\n")
    : (result.matched === 0
      ? "(no messages matched the filters)"
      : `(no messages before index ${String(result.start)}; all ${String(result.matched)} matches have later indexes)`);
  return `Subsession ${result.sessionId} [${result.status}] — ${range}:\n\n${body}${more}`;
}

/**
 * Tools that let an agent spawn *tracked* child sessions and inspect them.
 *
 * Unlike `spawn_session` (fire-and-forget peers), a subsession records its
 * parent in its session header, the parent is notified when it stops working,
 * and the parent may read its transcript/result. The tools are constructed
 * per-session, carrying the spawning cwd for project-scope validation; the
 * parent's identity is taken from the live extension context at call time.
 */
export function createSubsessionToolDefinitions(spawningCwd: string, deps: SubsessionToolDeps) {
  const spawnTool = defineTool<typeof SpawnSubsessionParams, SpawnSubsessionResult>({
    name: "spawn_subsession",
    label: "Spawn subsession",
    description: "Start a tracked child and return after dispatch. Track required children as pending: continue independent work, then yield at a join point until all have notified completion. Notifications queue while the parent is busy; do not poll for completion.",
    promptSnippet: "spawn_subsession: delegate parallel work; yield at a join point until all required children complete.",
    parameters: SpawnSubsessionParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const parentSessionId = ctx.sessionManager.getSessionId();
      const parentSessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
      const result = await deps.spawn({
        spawningCwd,
        parentSessionId,
        parentSessionFile,
        prompt: params.prompt,
        cwd: params.cwd,
        ...(ctx.model === undefined ? {} : { model: ctx.model }),
      });
      return {
        content: [{ type: "text", text: `Started tracked subsession ${result.sessionId} in ${result.cwd}. Track it as pending and, before finalizing dependent work, yield until all required children have notified completion.` }],
        details: result,
      };
    },
  });

  const listTool = defineTool<typeof ListSubsessionsParams, { subsessions: SubsessionSummary[] }>({
    name: "list_subsessions",
    label: "List subsessions",
    description: "List tracked child sessions owned by the calling session, with each child's current status (working, idle, error, or unknown).",
    promptSnippet: "list_subsessions: see the tracked child sessions you spawned",
    parameters: ListSubsessionsParams,
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const parentSessionId = ctx.sessionManager.getSessionId();
      const parentSessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
      const subsessions = await deps.list(parentSessionId, parentSessionFile);
      const text = subsessions.length === 0
        ? "No tracked subsessions."
        : `Tracked subsessions:\n${subsessions.map(statusLine).join("\n")}`;
      return { content: [{ type: "text", text }], details: { subsessions } };
    },
  });

  const checkTool = defineTool<typeof CheckSubsessionParams, SubsessionCheckResult>({
    name: "check_subsession",
    label: "Check subsession",
    description: "Return a tracked subsession's current status, message count, and most recent assistant output.",
    promptSnippet: "check_subsession: glance at a subsession's status and latest output",
    parameters: CheckSubsessionParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const parentSessionId = ctx.sessionManager.getSessionId();
      const parentSessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
      const result = await deps.check(parentSessionId, params.sessionId, parentSessionFile);
      const body = result.finalText === "" ? "(no output yet)" : result.finalText;
      return {
        content: [{ type: "text", text: `Subsession ${result.sessionId} [${result.status}]:\n\n${body}` }],
        details: result,
      };
    },
  });

  const readTool = defineTool<typeof ReadSubsessionParams, SubsessionReadResult>({
    name: "read_subsession",
    label: "Read subsession",
    description: "Return a filtered, paginated transcript of a tracked subsession. Filters select message roles and content kinds, search full message content, optionally include raw tool arguments, and cap or page the returned entries.",
    promptSnippet: "read_subsession: read through a subsession's transcript with filters",
    parameters: ReadSubsessionParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const parentSessionId = ctx.sessionManager.getSessionId();
      const parentSessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
      const { sessionId, ...query } = params;
      const result = await deps.read(parentSessionId, sessionId, query, parentSessionFile);
      return {
        content: [{ type: "text", text: renderTranscript(result) }],
        details: result,
      };
    },
  });

  return [spawnTool, listTool, checkTool, readTool];
}
