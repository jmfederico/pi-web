import { Type } from "typebox";
import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TranscriptContentKind, TranscriptEntry, TranscriptRole, TranscriptView } from "./subsessionTranscript.js";

/** Lifecycle phase of a tracked subsession as seen by its parent. */
export type SubsessionStatus = "working" | "idle" | "error" | "unknown";

export interface SpawnSubsessionResult {
  sessionId: string;
  cwd: string;
  /** Model the child session runs with, as `provider/id`; absent when unknown. */
  model?: string;
}

export type SpawnSubsessionModel = NonNullable<ExtensionContext["model"]>;
export type SpawnSubsessionThinkingLevel = NonNullable<ExtensionContext["thinkingLevel"]>;

export interface SpawnSubsessionInvocation {
  /**
   * cwd of the session that invoked the tool. A tracked child always runs in
   * this workspace, so it is both the project-scope check input and the target.
   */
  spawningCwd: string;
  /** Session id of the parent; the spawned session is tracked against it. */
  parentSessionId: string;
  /** Session file of the parent, recorded in the child's `parentSession` header. */
  parentSessionFile: string | undefined;
  prompt: string;
  /**
   * Requested target workspace. The tool never sets it; other callers may, and
   * anything other than {@link spawningCwd} is refused rather than retargeted.
   */
  cwd?: string;
  /** Current model from the dispatching session, used as the spawned session's default. */
  model?: SpawnSubsessionModel;
  /** Strict `provider/model-id` requested by the parent; overrides {@link model} when set. */
  modelSpec?: string;
  /** Parent's current thinking level, inherited by the child session (pi clamps it to the child model's capabilities). */
  thinkingLevel?: SpawnSubsessionThinkingLevel;
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
    description: "Initial instruction for the tracked child.",
  }),
  model: Type.Optional(Type.String({
    description: 'Model for the child session, as an exact "provider/model-id" such as "anthropic/claude-sonnet-4-5". When the user references a model as #provider/model-id in their request, forward it here. An unknown value is rejected. Omit to inherit this session\'s model.',
  })),
});

const ListSubsessionsParams = Type.Object({});
const YieldToSubsessionsParams = Type.Object({});

const CheckSubsessionParams = Type.Object({
  sessionId: Type.String({
    description: "Tracked child id from spawn_subsession or list_subsessions.",
  }),
});

const ReadSubsessionParams = Type.Object({
  sessionId: Type.String({
    description: "Tracked child id from spawn_subsession or list_subsessions.",
  }),
  roles: Type.Optional(Type.Array(
    Type.Union([Type.Literal("assistant"), Type.Literal("user"), Type.Literal("tool"), Type.Literal("system"), Type.Literal("custom")]),
    { description: "Roles to include; omit for all." },
  )),
  include: Type.Optional(Type.Array(
    Type.Union([Type.Literal("text"), Type.Literal("thinking"), Type.Literal("tool_call"), Type.Literal("tool_result"), Type.Literal("image")]),
    { description: "Content kinds to include; omit for all." },
  )),
  search: Type.Optional(Type.String({
    description: "Case-insensitive text or tool-name substring; searches full content before maxChars truncation.",
  })),
  maxChars: Type.Optional(Type.Integer({
    minimum: 0,
    description: "Maximum characters per text, thinking, or tool-result value; omit for no truncation.",
  })),
  includeToolArgs: Type.Optional(Type.Boolean({
    description: "Include raw tool-call arguments; summaries are always included.",
  })),
  before: Type.Optional(Type.Integer({
    minimum: 0,
    description: "Return messages before this index; use the previous start to page backward.",
  })),
  limit: Type.Optional(Type.Integer({
    minimum: 1,
    description: "Maximum recent matches, in chronological order. Defaults to 50.",
  })),
});

function statusLine(summary: SubsessionSummary): string {
  return `- ${summary.sessionId} [${summary.status}] in ${summary.cwd}`;
}

function workingInspectionGuidance(sessionId: string): string {
  return `Subsession ${sessionId} is working; partial output is withheld. Continue other work, or call yield_to_subsessions alone and last at the join point. Completion notices wake you; do not poll.`;
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
  const more = result.hasMore ? ` Earlier matching messages exist before index ${String(result.start)}.` : "";
  // Empty entries with matches means the `before` cursor excluded every match
  // (they all sit at index >= before): the agent paged too far back and should
  // raise `before` or omit it, not page back further.
  const body = result.entries.length > 0
    ? result.entries.map(renderEntry).join("\n\n")
    : (result.matched === 0
      ? "(no messages matched the filters)"
      : `(no messages before index ${String(result.start)}; all ${String(result.matched)} matches have later indexes)`);
  return `Subsession ${result.sessionId} [${result.status}] — ${range}.${more}\n\n--- SUBSESSION TRANSCRIPT: ${result.sessionId} ---\n${body}`;
}

/**
 * Tools that let an agent spawn *tracked* child sessions, inspect them, and
 * explicitly yield at a join point.
 *
 * A subsession records its parent in its session header, the parent is notified
 * when it stops working, and the parent may read its transcript/result. The
 * tools are constructed per-session, carrying the spawning cwd, which is both
 * the project-scope validation input and the child's workspace; the parent's
 * identity is taken from the live extension context at call time.
 */
export function createSubsessionToolDefinitions(spawningCwd: string, deps: SubsessionToolDeps) {
  const spawnTool = defineTool<typeof SpawnSubsessionParams, SpawnSubsessionResult>({
    name: "spawn_subsession",
    label: "Spawn subsession",
    description: "Start a tracked child session in this session's working directory to carry out part of the current task and return immediately. Its transcript and result are available here after it finishes.",
    promptSnippet: "spawn_subsession: tracked child work in this workspace; result available after completion",
    parameters: SpawnSubsessionParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const parentSessionId = ctx.sessionManager.getSessionId();
      const parentSessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
      const result = await deps.spawn({
        spawningCwd,
        parentSessionId,
        parentSessionFile,
        prompt: params.prompt,
        ...(ctx.model === undefined ? {} : { model: ctx.model }),
        ...(params.model === undefined ? {} : { modelSpec: params.model }),
        ...(ctx.thinkingLevel === undefined ? {} : { thinkingLevel: ctx.thinkingLevel }),
      });
      const modelNote = result.model === undefined ? "" : ` using model ${result.model}`;
      return {
        content: [{ type: "text", text: `Started tracked subsession ${result.sessionId} in ${result.cwd}${modelNote}. Continue other work, then join with yield_to_subsessions; do not poll.` }],
        details: result,
      };
    },
  });

  const listTool = defineTool<typeof ListSubsessionsParams, { subsessions: SubsessionSummary[] }>({
    name: "list_subsessions",
    label: "List subsessions",
    description: "List tracked child statuses. Never yields or changes control flow; do not poll.",
    promptSnippet: "list_subsessions: inspect child statuses; never yields",
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
    description: "Get a tracked child's status and latest output. Working output is withheld. Never yields; do not poll.",
    promptSnippet: "check_subsession: inspect child status and available output; never yields",
    parameters: CheckSubsessionParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const parentSessionId = ctx.sessionManager.getSessionId();
      const parentSessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
      const result = await deps.check(parentSessionId, params.sessionId, parentSessionFile);
      const body = result.finalText === "" ? "(no output yet)" : result.finalText;
      const text = result.status === "working"
        ? workingInspectionGuidance(result.sessionId)
        : `Subsession ${result.sessionId} [${result.status}].\n\n--- SUBSESSION OUTPUT: ${result.sessionId} ---\n${body}`;
      return {
        content: [{ type: "text", text }],
        details: result,
      };
    },
  });

  const readTool = defineTool<typeof ReadSubsessionParams, SubsessionReadResult>({
    name: "read_subsession",
    label: "Read subsession",
    description: "Read a tracked child's filtered transcript. Working transcripts are withheld. Never yields; do not poll.",
    promptSnippet: "read_subsession: inspect an available child transcript; never yields",
    parameters: ReadSubsessionParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const parentSessionId = ctx.sessionManager.getSessionId();
      const parentSessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
      const { sessionId, ...query } = params;
      const result = await deps.read(parentSessionId, sessionId, query, parentSessionFile);
      const text = result.status === "working"
        ? workingInspectionGuidance(result.sessionId)
        : renderTranscript(result);
      return {
        content: [{ type: "text", text }],
        details: result,
      };
    },
  });

  const yieldTool = defineTool<typeof YieldToSubsessionsParams, { subsessions: SubsessionSummary[] }>({
    name: "yield_to_subsessions",
    label: "Yield to subsessions",
    description: "At a join point, end this run while tracked children work; completion notices wake you. If none work, continue. Call alone and last; do not poll.",
    promptSnippet: "yield_to_subsessions: end the run at a join point; call alone and last",
    promptGuidelines: [
      "After calling spawn_subsession, you can continue with other work. At the join point, call yield_to_subsessions alone and last; completion notices wake you, so do not poll.",
    ],
    parameters: YieldToSubsessionsParams,
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const parentSessionId = ctx.sessionManager.getSessionId();
      const parentSessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
      const subsessions = await deps.list(parentSessionId, parentSessionFile);
      const working = subsessions.filter(({ status }) => status === "working");
      if (working.length === 0) {
        return {
          content: [{ type: "text", text: "No tracked subsessions are working; continuing." }],
          details: { subsessions },
        };
      }
      return {
        content: [{ type: "text", text: `Working: ${working.map(({ sessionId }) => sessionId).join(", ")}. Ending this run; completion notices will wake you.` }],
        details: { subsessions },
        terminate: true,
      };
    },
  });

  return [spawnTool, listTool, checkTool, readTool, yieldTool];
}
