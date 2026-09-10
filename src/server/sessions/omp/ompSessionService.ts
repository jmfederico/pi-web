import { homedir as defaultHomedir } from "node:os";
import { join } from "node:path";
import { OmpRpcClient } from "./ompRpcClient.js";
import { fromOmpSessionId, OmpSessionStore, toOmpSessionId } from "./ompSessionStore.js";
import type {
  AskUserCloseResponse,
  AskUserSubmission,
  ExtensionDialogAnswer,
  ExtensionDialogCloseResponse,
  PromptAttachment,
  PromptImageAttachment,
  SavedPromptAttachment,
  SessionBulkArchiveResponse,
  SessionBulkDeleteArchivedResponse,
  SessionBulkMutationRef,
  SessionInfo,
  SessionModelScopeMode,
  SessionNotificationCatalogSnapshot,
  SessionNotificationDismissAllRequest,
  SessionNotificationDismissRequest,
  SessionNotificationInboxSnapshot,
  SessionNotificationSeverity,
  SessionRef,
  SessionUnreadAcknowledgeRequest,
  SessionUnreadCatalogSnapshot,
} from "../../../shared/apiTypes.js";
import { piWebDataDir } from "../../../config.js";
import { SessionEventHub } from "../../realtime/sessionEventHub.js";
import type { WorkspaceActivityService } from "../../activity/workspaceActivityService.js";
import { canonicalizeStoredCwd } from "../../workingDirectory.js";
import { attachmentsToInlineImages, saveAttachmentsToWorkspace } from "../attachmentService.js";
import { pageMessagesAtSafeBoundary } from "../messagePaging.js";
import { PendingExtensionDialogStore } from "../pendingExtensionDialogStore.js";
import { SessionArchiveStore } from "../sessionArchiveStore.js";
import type { ArchivedSessionRecord, ArchiveSessionInput } from "../sessionArchiveStore.js";
import { planSessionCleanup, summarizeSessionCleanupExecution, type NormalizedSessionCleanupRequest, type SessionCleanupPlan } from "../sessionCleanup.js";
import { SessionNotificationStore } from "../sessionNotificationStore.js";
import type { SessionRouteRef, SessionRouteService } from "../sessionService.js";
import { SessionUnreadStore, type SessionUnreadMutation } from "../sessionUnreadStore.js";
import type {
  ClientArchiveSessionsResponse,
  ClientCommand,
  ClientCommandResult,
  ClientMessagePage,
  ClientSession,
  ClientSessionCleanupExecuteResponse,
  ClientSessionCleanupPreviewResponse,
  ClientSessionModel,
  ClientSessionModelCatalogEntry,
  ClientSessionStatus,
  ClientSessionTreeForkRequest,
  ClientSessionTreeForkResult,
  ClientSessionTreeNavigateRequest,
  ClientSessionTreeNavigateResult,
  ClientThinkingLevel,
  SessionStreamSnapshot,
} from "../../types.js";

/** The `omp:` id prefix contract (brief item 1): OmpSessionService owns prefix normalization end-to-end, using the shared `toOmpSessionId`/`fromOmpSessionId` from ompSessionStore.ts. */

/**
 * Fixed thinking-level set OMP's `ThinkingLevel` enum documents (get_state's
 * `thinkingLevel` field, `set_thinking_level`'s `level` param). Unlike Pi's
 * per-model dynamic list, OMP does not expose a "levels this model supports"
 * query over RPC, so this is reported statically rather than fetched.
 */
const OMP_THINKING_LEVELS: readonly ClientThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Fixed capability set every OMP session reports. Every flag is `false`
 * because the corresponding OMP RPC command genuinely does not exist (no
 * clear_queue/dismiss-warning/ask_user/custom-transcript-entry commands, no
 * enabled-model-scope concept, cycle_model has no reverse direction, and
 * OMP's `branch` command only rewinds to a selected user message rather than
 * forking an arbitrary tree entry). Absent on Pi sessions, so old clients
 * default to fully capable.
 */
const OMP_CAPABILITIES = {
  askUser: false,
  queueClear: false,
  warnings: false,
  modelScope: false,
  treeNavigate: false,
  treeFork: false,
  interactiveCommands: false,
  detachParent: false,
  shellStreaming: false,
  cycleModelBackward: false,
} as const;

/** One inbound OMP RPC command/frame. */
export interface OmpRpcCommand {
  id?: string;
  type: string;
  [key: string]: unknown;
}

/** Structural mirror of the real `OmpRpcClient` (brief item 2). */
export interface OmpRpcClientLike {
  start(): Promise<void>;
  request<T = unknown>(command: OmpRpcCommand): Promise<T>;
  send(frame: OmpRpcCommand): void;
  close(): Promise<void>;
  readonly alive: boolean;
}

export interface OmpRpcClientFactoryOptions {
  cwd: string;
  agentDir: string;
  command?: string;
  sessionFile?: string;
  env?: NodeJS.ProcessEnv;
  onEvent?: (frame: Record<string, unknown>) => void;
}

/** Structural mirror of the real, read-only `OmpSessionStore` (brief item 3). */
export interface OmpSessionStoreLike {
  list(cwd: string): Promise<SessionInfo[]>;
  /** Every known OMP session across every cwd, for cleanup when projectCwds is omitted. */
  listAll(): Promise<SessionInfo[]>;
  resolve(ref: SessionRef): Promise<{ path: string; nativeId: string }>;
  messages(ref: SessionRef): Promise<unknown[]>;
}

export interface OmpSessionServiceOptions {
  /** OMP agent state directory. Defaults to `<homedir>/.omp/agent`, independent of the Pi daemon's inherited agentDir. */
  agentDir?: string;
  /** OMP CLI command; forwarded to the transport as-is (including when omitted, so its own "omp" default applies). */
  command?: string;
  env?: NodeJS.ProcessEnv;
  /** Test seam for the default agentDir resolution; defaults to node:os `homedir`. */
  homedir?: () => string;
  /** Injected transport boundary; defaults to the real `OmpRpcClient`. */
  createRpcClient?: (options: OmpRpcClientFactoryOptions) => OmpRpcClientLike;
  /** Injected read-only session-tree store; defaults to the real `OmpSessionStore(agentDir)`. */
  store?: OmpSessionStoreLike;
  /** Daemon-lifetime notification state, shared with PiSessionService (sessionId-keyed; omp: prefix cannot collide with Pi's raw ids). */
  notificationStore?: SessionNotificationStore;
  /** Daemon-lifetime unread state, shared with PiSessionService for the same reason. */
  unreadStore?: SessionUnreadStore;
  /** Shared daemon workspace activity projection; OMP mutates only omp:-owned session records. */
  workspaceActivity?: Pick<WorkspaceActivityService, "applySessionStatus" | "applySessionActivity" | "removeSession" | "reconcileSessionActivity">;
  onUnreadChanged?: () => void;
  /**
   * OMP-only archive metadata store. Deliberately NEVER the same instance as
   * Pi's: `SessionArchiveStore.archive()` physically copies/removes the
   * transcript file keyed by basename, so sharing risks cross-engine
   * collisions and lets Pi's own cleanup discover/delete OMP archives.
   * Defaults to its own file under `<PI_WEB_DATA_DIR>/omp/`.
   */
  archiveStore?: SessionArchiveStore;
  /** Daemon-lifetime open-dialog state; backend-agnostic, safe to share with Pi if a caller chooses to, but defaults to its own instance. */
  pendingExtensionDialogStore?: PendingExtensionDialogStore;
  /** Clock seam for tests. */
  now?: () => Date;
}

interface ActiveOmpSession {
  nativeId: string;
  cwd: string;
  sessionFile?: string;
  client: OmpRpcClientLike;
  notificationGeneration: import("../sessionNotificationStore.js").SessionNotificationGeneration;
  /** Buffered in-flight assistant text between agent_start and agent_end, or null when idle. */
  partial: { text: string } | null;
  isBashRunning: boolean;
  /** Maps the browser-visible dialogId (PendingExtensionDialogStore's own id) back to the OMP wire frame id an answer/cancel must be sent against. */
  dialogFrameIdByDialogId: Map<string, string>;
  /** Last browser status projection, retained so event-driven flag changes do not discard model/token fields. */
  lastStatus?: ClientSessionStatus;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeTokens(value: unknown): { input: number; output: number; cacheRead: number; cacheWrite: number; total: number } {
  if (typeof value !== "object" || value === null) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  return {
    input: "input" in value && typeof value.input === "number" ? value.input : 0,
    output: "output" in value && typeof value.output === "number" ? value.output : 0,
    cacheRead: "cacheRead" in value && typeof value.cacheRead === "number" ? value.cacheRead : 0,
    cacheWrite: "cacheWrite" in value && typeof value.cacheWrite === "number" ? value.cacheWrite : 0,
    total: "total" in value && typeof value.total === "number" ? value.total : 0,
  };
}

function stringifyPrimitive(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return "";
}

function shortToolValue(value: unknown): string {
  if (typeof value === "string") return value.length > 80 ? `${value.slice(0, 77)}…` : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `${String(value.length)} item${value.length === 1 ? "" : "s"}`;
  if (typeof value === "object" && value !== null) return "object";
  return "";
}

/**
 * Human-readable one-line summary of a tool call's arguments, mirroring
 * `summarizeToolArgs` in piSessionService.ts (duplicated rather than
 * imported: it is a small, pure, Pi-SDK-free formatting helper operating on
 * `unknown`, and importing it would create a production dependency on Pi's
 * file for OMP sessions).
 */
function summarizeToolArgs(args: unknown): string {
  if (typeof args !== "object" || args === null) return stringifyPrimitive(args);
  if ("command" in args && typeof args.command === "string") return args.command;
  if ("path" in args && typeof args.path === "string") return args.path;
  if ("oldText" in args && "newText" in args && typeof args.oldText === "string" && typeof args.newText === "string") return "edit text replacement";
  if ("edits" in args && Array.isArray(args.edits)) return `${String(args.edits.length)} edit${args.edits.length === 1 ? "" : "s"}`;
  const entries = Object.entries(args).filter(([, value]) => value !== null && value !== undefined).slice(0, 3);
  return entries.map(([key, value]) => `${key}: ${shortToolValue(value)}`).join(" · ");
}

/** Mirrors `toolResultContent` in piSessionService.ts (same duplication rationale as {@link summarizeToolArgs}). */
function toolResultContent(result: unknown): unknown {
  if (typeof result === "object" && result !== null) {
    if ("content" in result && result.content !== undefined) return result.content;
    const text = "text" in result && typeof result.text === "string"
      ? result.text
      : "output" in result && typeof result.output === "string" ? result.output : undefined;
    if (text !== undefined) return [{ type: "text", text }];
  }
  if (typeof result === "string") return [{ type: "text", text: result }];
  return result;
}

/** Mirrors `stringifyToolResult` in piSessionService.ts (same duplication rationale as {@link summarizeToolArgs}). */
function stringifyToolResult(result: unknown): string {
  if (typeof result === "string") return result;
  if (Array.isArray(result)) return result.map(stringifyToolResult).filter((text) => text !== "").join("\n");
  if (typeof result === "object" && result !== null) {
    if ("type" in result && result.type === "image") return "[image]";
    const text = "text" in result && typeof result.text === "string"
      ? result.text
      : "content" in result && typeof result.content === "string"
        ? result.content
        : "output" in result && typeof result.output === "string" ? result.output : undefined;
    if (text !== undefined) return text;
    if ("content" in result && Array.isArray(result.content)) return stringifyToolResult(result.content);
    return JSON.stringify(result, null, 2);
  }
  return stringifyPrimitive(result);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `Array.isArray`'s built-in type predicate narrows to `any[]`; this one keeps element access honest. */
function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function persistedEntryTimestamp(entry: Record<string, unknown>): number {
  const timestamp = entry["timestamp"];
  if (typeof timestamp === "number") return timestamp;
  return typeof timestamp === "string" ? new Date(timestamp).getTime() : 0;
}

function persistedCustomMessage(entry: Record<string, unknown>): Record<string, unknown> | undefined {
  const content = entry["content"];
  if (typeof content !== "string" && !Array.isArray(content)) return undefined;
  const customType = typeof entry["customType"] === "string" && entry["customType"].length > 0
    ? entry["customType"]
    : "custom-message";
  return {
    role: "custom",
    customType,
    content,
    display: typeof entry["display"] === "boolean" ? entry["display"] : false,
    ...(entry["details"] === undefined ? {} : { details: entry["details"] }),
    ...(entry["attribution"] === undefined ? {} : { attribution: entry["attribution"] === "user" ? "user" : "agent" }),
    timestamp: persistedEntryTimestamp(entry),
  };
}

function persistedBranchSummary(entry: Record<string, unknown>): Record<string, unknown> | undefined {
  const summary = entry["summary"];
  if (typeof summary !== "string" || summary.length === 0) return undefined;
  return {
    role: "branchSummary",
    summary,
    fromId: typeof entry["fromId"] === "string" ? entry["fromId"] : "",
    timestamp: persistedEntryTimestamp(entry),
  };
}

function remoteCompactionPayload(entry: Record<string, unknown>): Record<string, unknown> | undefined {
  const preserveData = entry["preserveData"];
  if (!isObjectRecord(preserveData)) return undefined;
  const candidate = preserveData["openaiRemoteCompaction"];
  if (!isObjectRecord(candidate) || typeof candidate["provider"] !== "string" || candidate["provider"].length === 0) return undefined;
  const replacementHistory = candidate["replacementHistory"];
  if (!Array.isArray(replacementHistory) || !replacementHistory.every(isObjectRecord)) return undefined;
  return { type: "openaiResponsesHistory", provider: candidate["provider"], items: replacementHistory };
}

function snapcompactBrowserContent(entry: Record<string, unknown>): { blocks: Record<string, unknown>[]; images: Record<string, unknown>[] } | undefined {
  const preserveData = entry["preserveData"];
  if (!isObjectRecord(preserveData)) return undefined;
  const archive = preserveData["snapcompact"];
  if (!isObjectRecord(archive)) return undefined;
  const rawFrames = archive["frames"];
  const frames = Array.isArray(rawFrames)
    ? rawFrames.filter((frame): frame is Record<string, unknown> => {
      if (!isObjectRecord(frame)) return false;
      const data = frame["data"];
      return typeof data === "string"
        && data.length > 0
        && typeof frame["mimeType"] === "string"
        && typeof frame["cols"] === "number"
        && typeof frame["rows"] === "number"
        && typeof frame["chars"] === "number";
    })
    : [];
  const textHead = typeof archive["textHead"] === "string" && archive["textHead"].length > 0 ? archive["textHead"] : undefined;
  const textTail = typeof archive["textTail"] === "string" && archive["textTail"].length > 0 ? archive["textTail"] : undefined;
  if (frames.length === 0 && textHead === undefined && textTail === undefined) return undefined;

  const images = frames.map((frame) => ({
    type: "image",
    data: frame["data"],
    mimeType: frame["mimeType"],
    ...(frame["detail"] === undefined ? {} : { detail: frame["detail"] }),
  }));
  const blocks: Record<string, unknown>[] = [];
  if (textHead !== undefined) {
    blocks.push({ type: "text", text: textHead + (images.length > 0 ? "\n-------------- imaged middle below\n" : "") });
  }
  blocks.push(...images);
  if (textTail !== undefined) {
    const prefix = images.length > 0
      ? "-------------- imaged middle above\n"
      : typeof archive["truncatedChars"] === "number" && archive["truncatedChars"] > 0
        ? "\n-------------- middle history omitted above\n"
        : "";
    blocks.push({ type: "text", text: prefix + textTail });
  }
  return { blocks, images };
}

function persistedEntryIsUserRequest(entry: Record<string, unknown>): boolean {
  if (entry["type"] === "message") {
    const message = entry["message"];
    return isObjectRecord(message) && message["role"] === "user";
  }
  return entry["type"] === "custom_message"
    && entry["attribution"] === "user"
    && (entry["customType"] === "skill-prompt" || entry["customType"] === "collab-prompt");
}

function persistedCompactionSummary(entry: Record<string, unknown>): Record<string, unknown> {
  const providerPayload = remoteCompactionPayload(entry);
  const archivedContent = snapcompactBrowserContent(entry);
  return {
    role: "compactionSummary",
    summary: typeof entry["summary"] === "string" ? entry["summary"] : "",
    ...(typeof entry["shortSummary"] === "string" ? { shortSummary: entry["shortSummary"] } : {}),
    tokensBefore: typeof entry["tokensBefore"] === "number" ? entry["tokensBefore"] : 0,
    ...(typeof entry["tokensAfter"] === "number" ? { tokensAfter: entry["tokensAfter"] } : {}),
    ...(typeof entry["method"] === "string" ? { method: entry["method"] } : {}),
    ...(providerPayload === undefined ? {} : { providerPayload }),
    ...(archivedContent === undefined || archivedContent.blocks.length === 0 ? {} : { blocks: archivedContent.blocks }),
    ...(archivedContent === undefined || archivedContent.images.length === 0 ? {} : { images: archivedContent.images }),
    ...(typeof entry["warning"] === "string" ? { warning: entry["warning"] } : {}),
    timestamp: persistedEntryTimestamp(entry),
  };
}

function appendPersistedMessage(messages: unknown[], entry: Record<string, unknown>): void {
  switch (entry["type"]) {
    case "message":
      if (entry["message"] !== undefined) messages.push(entry["message"]);
      return;
    case "custom_message": {
      const message = persistedCustomMessage(entry);
      if (message !== undefined) messages.push(message);
      return;
    }
    case "branch_summary": {
      const message = persistedBranchSummary(entry);
      if (message !== undefined) messages.push(message);
      return;
    }
    default:
      return;
  }
}

/**
 * Convert OMP's persisted active-branch entries into the same message list
 * exposed by RPC `get_messages` after resume. The store deliberately owns
 * only read-only branch discovery; this service owns the browser-facing
 * representation. The ordering follows OMP's canonical
 * `session/session-context.ts` buildSessionContext path: a later `/clear`
 * wins, otherwise the active compaction summary precedes its retained tail
 * and all post-compaction messages.
 */
function persistedMessagesForBrowser(entries: readonly unknown[]): unknown[] {
  const path = entries.filter(isObjectRecord);
  let compactionIndex = -1;
  let resetBoundaryIndex = -1;
  for (let index = 0; index < path.length; index++) {
    const type = path[index]?.["type"];
    if (type === "compaction") compactionIndex = index;
    else if (type === "reset_boundary") resetBoundaryIndex = index;
  }

  const messages: unknown[] = [];
  if (resetBoundaryIndex > compactionIndex) {
    for (let index = resetBoundaryIndex + 1; index < path.length; index++) {
      const entry = path[index];
      if (entry !== undefined) appendPersistedMessage(messages, entry);
    }
    return messages;
  }

  if (compactionIndex >= 0) {
    const compaction = path[compactionIndex];
    if (compaction === undefined) return messages;
    messages.push(persistedCompactionSummary(compaction));

    const providerPayload = remoteCompactionPayload(compaction);
    const details = compaction["details"];
    if (isObjectRecord(details) && details["kind"] === "experimental-context-rollover") {
      const firstKeptIndex = path.findIndex((entry) => entry["id"] === compaction["firstKeptEntryId"]);
      for (let index = compactionIndex - 1; index > resetBoundaryIndex; index--) {
        const entry = path[index];
        if (entry === undefined || !persistedEntryIsUserRequest(entry)) continue;
        if (index < firstKeptIndex) appendPersistedMessage(messages, entry);
        break;
      }
    }
    if (providerPayload === undefined) {
      const firstKeptEntryId = compaction["firstKeptEntryId"];
      let retaining = false;
      for (let index = 0; index < compactionIndex; index++) {
        const entry = path[index];
        if (entry === undefined) continue;
        if (entry["id"] === firstKeptEntryId) retaining = true;
        if (retaining) appendPersistedMessage(messages, entry);
      }
    } else if (typeof compaction["providerReplayThroughEntryId"] === "string") {
      const replayThroughIndex = path.findIndex((entry) => entry["id"] === compaction["providerReplayThroughEntryId"]);
      for (let index = replayThroughIndex + 1; replayThroughIndex >= 0 && index < compactionIndex; index++) {
        const entry = path[index];
        if (entry !== undefined) appendPersistedMessage(messages, entry);
      }
    }

    for (let index = compactionIndex + 1; index < path.length; index++) {
      const entry = path[index];
      if (entry !== undefined) appendPersistedMessage(messages, entry);
    }
    return messages;
  }

  for (const entry of path) appendPersistedMessage(messages, entry);
  return messages;
}

/**
 * OMP-backed `SessionRouteService`. Owns one `OmpRpcClient` process per live
 * OMP native session: fresh sessions are created with an explicit
 * `new_session` before publishing their final identity; persisted sessions
 * are resumed by respawning the process with `--resume <sessionFile>`, and
 * concurrent opens for the same native id share one in-flight spawn.
 */
export class OmpSessionService implements SessionRouteService {
  private readonly agentDir: string;
  private readonly createRpcClient: (options: OmpRpcClientFactoryOptions) => OmpRpcClientLike;
  private readonly store: OmpSessionStoreLike;
  private readonly notificationStore: SessionNotificationStore;
  private readonly unreadStore: SessionUnreadStore;
  private readonly archiveStore: SessionArchiveStore;
  private readonly pendingExtensionDialogStore: PendingExtensionDialogStore;
  private readonly now: () => Date;
  private readonly workspaceActivity: OmpSessionServiceOptions["workspaceActivity"];
  private readonly active = new Map<string, ActiveOmpSession>();
  private readonly pendingOpens = new Map<string, Promise<ActiveOmpSession>>();
  private readonly pendingCloses = new Map<string, Promise<void>>();
  private unreadPublication: Promise<void> = Promise.resolve();

  constructor(
    private readonly eventHub: SessionEventHub,
    private readonly options: OmpSessionServiceOptions,
  ) {
    const homedir = options.homedir ?? defaultHomedir;
    this.agentDir = options.agentDir ?? join(homedir(), ".omp", "agent");
    this.createRpcClient = options.createRpcClient ?? ((factoryOptions) => new OmpRpcClient(factoryOptions));
    this.store = options.store ?? new OmpSessionStore(this.agentDir);
    this.notificationStore = options.notificationStore ?? new SessionNotificationStore();
    this.unreadStore = options.unreadStore ?? new SessionUnreadStore();
    this.archiveStore = options.archiveStore ?? new SessionArchiveStore(join(piWebDataDir(options.env ?? process.env), "omp", "archived-sessions.json"));
    this.pendingExtensionDialogStore = options.pendingExtensionDialogStore ?? new PendingExtensionDialogStore();
    this.workspaceActivity = options.workspaceActivity;
    this.now = options.now ?? (() => new Date());
  }

  activeCount(): number {
    return this.active.size;
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([...this.pendingOpens.values()]);
    await Promise.all([...this.active.keys()].map((sessionId) => this.closeActiveSession(sessionId)));
    await Promise.allSettled([...this.pendingCloses.values()]);
  }

  private reportCloseFailure(prefixedId: string, error: unknown): void {
    this.eventHub.publish(prefixedId, { type: "session.error", message: `Failed to close the OMP process cleanly: ${errorMessage(error)}` });
  }

  // ---------------------------------------------------------------------
  // Listing and messages (read-only; never spawns a process just to browse)
  // ---------------------------------------------------------------------

  async list(cwd: string): Promise<ClientSession[]> {
    const [sessions, archivedRecords] = await Promise.all([this.store.list(cwd), this.archiveStore.list()]);
    const canonicalCwd = canonicalizeStoredCwd(cwd);
    const archivedForCwd = archivedRecords.filter((record) =>
      isValidOmpArchiveRecord(record) && canonicalizeStoredCwd(record.cwd) === canonicalCwd
    );
    const archivedById = new Map(archivedForCwd.map((record) => [record.sessionId, record]));
    const unarchivedSessions = sessions
      .filter((session) => !archivedById.has(session.id))
      .map((session) => ({ ...session, backend: "omp" as const }));
    const archivedSessions = archivedForCwd
      .map((record) => this.clientSessionFromArchivedRecord(record))
      .filter((session): session is ClientSession => session !== undefined);
    const result = [...unarchivedSessions, ...archivedSessions];
    const sessionIds = result.map((session) => session.id);
    this.workspaceActivity?.reconcileSessionActivity(canonicalCwd, sessionIds, "omp");
    await this.publishUnreadMutations(this.unreadStore.reconcileCwd(canonicalCwd, sessionIds, "omp"));
    return result;
  }

  async messages(ref: SessionRouteRef, page?: { before?: number; limit?: number }): Promise<ClientMessagePage> {
    const registered = this.active.get(ref.id);
    const runtimeInFlight = registered !== undefined || this.pendingOpens.has(ref.id) || this.pendingCloses.has(ref.id);
    const messages = runtimeInFlight
      ? (await (await this.ensureOpen(ref)).client.request<{ messages: unknown[] }>({ type: "get_messages" })).messages
      : persistedMessagesForBrowser(await this.store.messages(ref));
    return pageMessagesAtSafeBoundary(messages, page);
  }

  // ---------------------------------------------------------------------
  // Fresh creation and resume
  // ---------------------------------------------------------------------

  async start(cwd: string, options: { startupToken?: string; backend?: "pi" | "omp" } = {}): Promise<ClientSession> {
    const idHolder: { current?: string } = {};
    const client = this.spawnClient({ cwd, sessionFile: undefined, idHolder });
    let provisionalId: string | undefined;
    try {
      await client.start();
      const initialStats = await client.request<Record<string, unknown>>({ type: "get_session_stats" });
      const initialNativeId = stringField(initialStats, "sessionId");
      provisionalId = validatedOmpSessionId(initialNativeId);
      idHolder.current = provisionalId;
      const initialSessionFile = typeof initialStats["sessionFile"] === "string" ? initialStats["sessionFile"] : undefined;
      const active = this.registerActive(provisionalId, {
        nativeId: initialNativeId,
        cwd,
        ...(initialSessionFile === undefined ? {} : { sessionFile: initialSessionFile }),
        client,
        partial: null,
        isBashRunning: false,
        dialogFrameIdByDialogId: new Map(),
      });
      active.lastStatus = this.syntheticStatus(active, initialStats);
      this.publishStartupProgress(provisionalId, options.startupToken, "active", "Creating OMP session");

      const newSessionResult = await client.request<{ cancelled: boolean }>({ type: "new_session" });
      if (newSessionResult.cancelled) {
        throw new Error("OMP declined to start a new session: new_session was cancelled");
      }
      const stats = await client.request<Record<string, unknown>>({ type: "get_session_stats" });
      const nativeId = stringField(stats, "sessionId");
      const prefixedId = validatedOmpSessionId(nativeId);
      const collision = this.active.get(prefixedId);
      if (collision !== undefined && collision !== active) {
        throw new Error(`OMP session ${prefixedId} is already owned by another active process`);
      }

      if (prefixedId !== provisionalId) {
        this.endSessionDialogs(provisionalId, active);
        this.unreadStore.forgetActivity(provisionalId, canonicalizeStoredCwd(cwd));
        this.workspaceActivity?.removeSession(provisionalId, canonicalizeStoredCwd(cwd));
        if (this.active.get(provisionalId) === active) this.active.delete(provisionalId);
        for (const mutation of this.notificationStore.clearGeneration(active.notificationGeneration, "runtime-close")) {
          this.eventHub.publish(mutation.sessionId, mutation.inboxEvent);
          this.eventHub.publishNotificationSummary(mutation.summaryEvent);
        }
        active.nativeId = nativeId;
        const registration = this.notificationStore.registerSession(prefixedId, canonicalizeStoredCwd(cwd));
        for (const mutation of registration.mutations) {
          this.eventHub.publish(mutation.sessionId, mutation.inboxEvent);
          this.eventHub.publishNotificationSummary(mutation.summaryEvent);
        }
        active.notificationGeneration = registration.generation;
        this.active.set(prefixedId, active);
        idHolder.current = prefixedId;
      }
      const sessionFile = typeof stats["sessionFile"] === "string" ? stats["sessionFile"] : undefined;
      if (sessionFile === undefined) delete active.sessionFile;
      else active.sessionFile = sessionFile;
      active.lastStatus = this.syntheticStatus(active, stats);
      const nowIso = this.now().toISOString();
      const session: ClientSession = {
        id: prefixedId,
        cwd,
        path: sessionFile ?? "",
        persisted: sessionFile !== undefined,
        created: nowIso,
        modified: nowIso,
        messageCount: typeof stats["totalMessages"] === "number" ? stats["totalMessages"] : 0,
        firstMessage: "",
        backend: "omp",
      };
      this.publishStartupProgress(provisionalId, options.startupToken, "idle", "OMP session ready");
      this.eventHub.publishGlobal({ type: "session.created", session });
      this.publishStatus(active);
      return session;
    } catch (error: unknown) {
      if (provisionalId !== undefined && this.active.get(provisionalId)?.client === client) {
        await this.closeActiveSession(provisionalId);
        this.publishStartupProgress(provisionalId, options.startupToken, "idle", "OMP session startup ended");
      } else {
        await client.close().catch(() => undefined);
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------
  // Status, streaming, and event mapping
  // ---------------------------------------------------------------------

  async status(ref: SessionRouteRef): Promise<ClientSessionStatus> {
    const active = await this.ensureOpen(ref);
    const [state, stats] = await Promise.all([
      active.client.request<Record<string, unknown>>({ type: "get_state" }),
      active.client.request<Record<string, unknown>>({ type: "get_session_stats" }),
    ]);
    const status = this.statusFromState(ref.id, active, state, stats);
    this.workspaceActivity?.applySessionStatus(canonicalizeStoredCwd(active.cwd), status);
    return status;
  }

  async streamSnapshot(ref: SessionRouteRef): Promise<SessionStreamSnapshot> {
    const active = await this.ensureOpen(ref);
    const seq = this.eventHub.currentSeq(ref.id);
    const partial = active.partial === null ? null : { role: "assistant", content: [{ type: "text", text: active.partial.text }] };
    return { seq, partial };
  }

  private syntheticStatus(active: ActiveOmpSession, stats: Record<string, unknown>): ClientSessionStatus {
    return {
      sessionId: toOmpSessionId(active.nativeId),
      backend: "omp",
      isStreaming: active.partial !== null,
      isCompacting: false,
      isBashRunning: active.isBashRunning,
      pendingMessageCount: 0,
      queuedMessages: [],
      tokens: normalizeTokens(stats["tokens"]),
      cost: typeof stats["cost"] === "number" ? stats["cost"] : 0,
      pendingDialogs: this.pendingExtensionDialogStore.pendingDialogs(toOmpSessionId(active.nativeId)),
      capabilities: OMP_CAPABILITIES,
    };
  }

  private statusFromState(sessionId: string, active: ActiveOmpSession, state: Record<string, unknown>, stats: Record<string, unknown>): ClientSessionStatus {
    const model = state["model"];
    const thinkingLevel = state["thinkingLevel"];
    const messageCount = state["messageCount"];
    const queuedMessageCount = state["queuedMessageCount"];
    const status: ClientSessionStatus = {
      sessionId,
      backend: "omp",
      isStreaming: state["isStreaming"] === true,
      isCompacting: state["isCompacting"] === true,
      isBashRunning: active.isBashRunning,
      pendingMessageCount: typeof queuedMessageCount === "number" ? queuedMessageCount : 0,
      queuedMessages: [],
      ...(typeof messageCount === "number" ? { messageCount } : {}),
      tokens: normalizeTokens(stats["tokens"]),
      cost: typeof stats["cost"] === "number" ? stats["cost"] : 0,
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- `model` comes from the OMP RPC `get_state` response (Record<string, unknown>); the wire boundary provides no runtime schema to narrow it to ClientSessionModel.
      ...(model === undefined ? {} : { model: model as ClientSessionModel }),
      ...(typeof thinkingLevel === "string" ? { thinkingLevel } : {}),
      pendingDialogs: this.pendingExtensionDialogStore.pendingDialogs(sessionId),
      capabilities: OMP_CAPABILITIES,
    };
    active.lastStatus = status;
    return status;
  }

  private hasActiveWork(active: ActiveOmpSession): boolean {
    return active.partial !== null || active.isBashRunning;
  }

  private publishStatus(active: ActiveOmpSession): void {
    const status: ClientSessionStatus = {
      ...(active.lastStatus ?? this.syntheticStatus(active, {})),
      isStreaming: active.partial !== null,
      isBashRunning: active.isBashRunning,
      pendingDialogs: this.pendingExtensionDialogStore.pendingDialogs(toOmpSessionId(active.nativeId)),
    };
    active.lastStatus = status;
    this.workspaceActivity?.applySessionStatus(canonicalizeStoredCwd(active.cwd), status);
    this.eventHub.publish(status.sessionId, { type: "status.update", status });
    this.eventHub.publishGlobal({ type: "status.update", status });
  }

  private publishStartupProgress(
    sessionId: string,
    startupToken: string | undefined,
    phase: "active" | "idle",
    detail: string,
  ): void {
    const activity = {
      sessionId,
      phase,
      label: "Creating OMP session",
      detail,
      at: this.now().toISOString(),
      startup: true,
    } as const;
    this.eventHub.publishGlobal(
      startupToken === undefined
        ? { type: "session.startup", activity }
        : { type: "session.startup", startupToken, activity },
    );
  }

  private publishActivity(active: ActiveOmpSession, label: string, settledPhase: "idle" | "error" = "idle"): void {
    const phase = this.hasActiveWork(active) ? "active" : settledPhase;
    const activity = {
      sessionId: toOmpSessionId(active.nativeId),
      phase,
      label,
      at: this.now().toISOString(),
    } as const;
    this.workspaceActivity?.applySessionActivity(canonicalizeStoredCwd(active.cwd), activity);
    this.eventHub.publish(activity.sessionId, { type: "activity.update", activity });
    this.eventHub.publishGlobal({ type: "activity.update", activity });
    const mutations = this.unreadStore.observeActivityState(
      activity.sessionId,
      canonicalizeStoredCwd(active.cwd),
      this.hasActiveWork(active),
    );
    if (mutations.length > 0) void this.publishUnreadMutations(mutations).catch(() => undefined);
  }

  private publishUnreadMutations(mutations: readonly SessionUnreadMutation[]): Promise<void> {
    if (mutations.length === 0) return Promise.resolve();
    this.options.onUnreadChanged?.();
    const publication = this.unreadPublication.then(async () => {
      await this.unreadStore.flush();
      for (const mutation of mutations) this.eventHub.publishGlobal(mutation.event);
    });
    this.unreadPublication = publication.catch(() => undefined);
    return publication;
  }

  private async forgetUnreadSessions(identities: readonly { sessionId: string; cwd: string }[]): Promise<void> {
    const mutations: SessionUnreadMutation[] = [];
    for (const identity of identities) {
      mutations.push(...this.unreadStore.forgetSession(identity.sessionId, canonicalizeStoredCwd(identity.cwd)));
    }
    await this.publishUnreadMutations(mutations);
  }

  private endSessionDialogs(prefixedId: string, active: ActiveOmpSession): void {
    for (const dialog of this.pendingExtensionDialogStore.pendingDialogs(prefixedId)) {
      const result = this.pendingExtensionDialogStore.cancel(prefixedId, dialog.dialogId, "session-ended");
      if (result.status !== "closed") continue;
      active.dialogFrameIdByDialogId.delete(dialog.dialogId);
      this.eventHub.publish(prefixedId, {
        type: "dialog.closed",
        dialogId: dialog.dialogId,
        reason: result.outcome.reason,
      });
    }
  }

  /**
   * Maps one OMP `onEvent` frame onto a `SessionUiEvent`, mirroring
   * `toClientEvent` in piSessionService.ts wherever the underlying
   * `AgentSessionEvent` is the same (OMP's rpc-mode forwards the identical
   * `AgentSession.subscribe()` stream Pi's own SDK usage does). Frame types
   * outside that shared core (`extension_error`, `extension_ui_request`, the
   * late-unmatched `response`) are OMP-RPC-transport-specific and have no Pi
   * counterpart. Anything else falls through to a generic `pi.event` rather
   * than being silently dropped, matching Pi's own catch-all.
   */
  private handleEvent(prefixedId: string, frame: Record<string, unknown>): void {
    const active = this.active.get(prefixedId);
    const type = frame["type"];
    switch (type) {
      case "agent_start": {
        if (active === undefined) return;
        active.partial = { text: "" };
        this.eventHub.publish(prefixedId, { type: "agent.start" });
        this.publishActivity(active, "OMP agent working");
        this.publishStatus(active);
        return;
      }
      case "message_update": {
        const assistantEvent = frame["assistantMessageEvent"];
        if (typeof assistantEvent !== "object" || assistantEvent === null) return;
        if (!("delta" in assistantEvent) || typeof assistantEvent.delta !== "string") return;
        const delta = assistantEvent.delta;
        if ("type" in assistantEvent && assistantEvent.type === "text_delta") {
          if (active?.partial !== null && active !== undefined) active.partial.text += delta;
          this.eventHub.publish(prefixedId, { type: "assistant.delta", text: delta });
        } else if ("type" in assistantEvent && assistantEvent.type === "thinking_delta") {
          this.eventHub.publish(prefixedId, { type: "assistant.thinking.delta", text: delta });
        }
        return;
      }
      case "tool_execution_start": {
        const args = frame["args"];
        this.eventHub.publish(prefixedId, { type: "tool.start", toolCallId: stringField(frame, "toolCallId"), toolName: stringField(frame, "toolName"), summary: summarizeToolArgs(args), args });
        return;
      }
      case "tool_execution_update": {
        const partialResult = frame["partialResult"];
        this.eventHub.publish(prefixedId, { type: "tool.update", toolCallId: stringField(frame, "toolCallId"), toolName: stringField(frame, "toolName"), text: stringifyToolResult(partialResult), content: toolResultContent(partialResult) });
        return;
      }
      case "tool_execution_end": {
        const result = frame["result"];
        this.eventHub.publish(prefixedId, { type: "tool.end", toolCallId: stringField(frame, "toolCallId"), toolName: stringField(frame, "toolName"), text: stringifyToolResult(result), content: toolResultContent(result), isError: frame["isError"] === true });
        return;
      }
      case "agent_end": {
        if (active === undefined) return;
        active.partial = null;
        this.eventHub.publish(prefixedId, { type: "agent.end" });
        this.publishActivity(active, "OMP agent finished");
        this.publishStatus(active);
        return;
      }
      case "message_end": {
        const message = frame["message"];
        this.eventHub.publish(prefixedId, message === undefined ? { type: "message.end" } : { type: "message.end", message });
        return;
      }
      case "command_output": {
        if (typeof frame["text"] === "string") {
          this.eventHub.publish(prefixedId, { type: "command.output", level: "info", message: frame["text"] });
        }
        return;
      }
      case "prompt_result":
        // Local-only commands complete without an agent lifecycle. Their
        // command_output frames are the visible result; never fabricate an
        // agent_end that could clear a concurrent real turn.
        return;
      case "extension_error": {
        this.eventHub.publish(prefixedId, { type: "session.error", message: stringField(frame, "error") || "OMP extension error" });
        return;
      }
      case "extension_ui_request": {
        this.handleExtensionUiRequest(prefixedId, active, frame);
        return;
      }
      case "response": {
        // Unmatched late response frame the transport forwards after the
        // originating request already settled: the operation was accepted,
        // then failed asynchronously (e.g. a scheduling failure after
        // `prompt` returned success). Surface it as a terminal error rather
        // than leaving the browser believing the turn is still running.
        if (frame["success"] === false) {
          this.eventHub.publish(prefixedId, { type: "session.error", message: stringField(frame, "error") || "OMP request failed" });
        }
        return;
      }
      default: {
        this.eventHub.publish(prefixedId, { type: "pi.event", eventType: typeof type === "string" ? type : "unknown" });
        return;
      }
    }
  }

  private handleExtensionUiRequest(prefixedId: string, active: ActiveOmpSession | undefined, frame: Record<string, unknown>): void {
    const method = frame["method"];
    const frameId = stringField(frame, "id");
    switch (method) {
      case "confirm":
      case "select":
      case "input":
      case "editor": {
        if (active === undefined) return;
        if (frameId.trim() === "") {
          this.failBlockingExtensionRequest(prefixedId, "OMP sent a blocking UI request without a valid wire id");
          return;
        }
        const kind: "confirm" | "select" | "input" = method === "confirm" ? "confirm" : method === "select" ? "select" : "input";
        const options = frame["options"];
        try {
          const dialog = this.pendingExtensionDialogStore.open({
            sessionId: prefixedId,
            kind,
            title: stringField(frame, "title"),
            ...(typeof frame["message"] === "string" ? { message: frame["message"] } : {}),
            // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- `options` is the OMP wire frame's `select`-dialog choice list (unvalidated Record<string, unknown> field); no runtime schema narrows it beyond the array check.
            ...(Array.isArray(options) ? { options: options as string[] } : {}),
            ...(typeof frame["placeholder"] === "string" ? { placeholder: frame["placeholder"] } : {}),
            ...(method === "editor" ? { multiline: true } : {}),
            ...(method === "editor" && typeof frame["prefill"] === "string" ? { initialValue: frame["prefill"] } : {}),
            runScoped: false,
          });
          active.dialogFrameIdByDialogId.set(dialog.dialogId, frameId);
          this.eventHub.publish(prefixedId, { type: "dialog.opened", dialog });
        } catch (error: unknown) {
          this.eventHub.publish(prefixedId, { type: "session.error", message: `Invalid OMP UI request: ${errorMessage(error)}` });
          try {
            active.client.send({ id: frameId, type: "extension_ui_response", cancelled: true });
          } catch (sendError: unknown) {
            this.failBlockingExtensionRequest(prefixedId, `Failed to cancel invalid OMP UI request: ${errorMessage(sendError)}`);
          }
        }
        return;
      }
      case "cancel": {
        if (active === undefined) return;
        const targetId = stringField(frame, "targetId");
        const dialogId = [...active.dialogFrameIdByDialogId.entries()].find(([, sentFrameId]) => sentFrameId === targetId)?.[0];
        if (dialogId === undefined) return;
        active.dialogFrameIdByDialogId.delete(dialogId);
        const result = this.pendingExtensionDialogStore.cancel(prefixedId, dialogId, "aborted");
        if (result.status === "closed") {
          this.eventHub.publish(prefixedId, { type: "dialog.closed", dialogId, reason: result.outcome.reason });
        }
        return;
      }
      case "notify": {
        this.recordNotification(prefixedId, stringField(frame, "message"), normalizeNotifySeverity(frame["notifyType"]));
        return;
      }
      case "setTitle": {
        const name = typeof frame["title"] === "string" ? frame["title"] : undefined;
        this.eventHub.publish(prefixedId, { type: "session.name", sessionId: prefixedId, ...(name === undefined ? {} : { name }) });
        return;
      }
      case "setStatus":
      case "setWidget":
      case "set_editor_text":
      case "open_url":
        // Documented fire-and-forget hints (rpc-types.ts:411-440) with no
        // PI WEB rendering surface yet; safely ignored, never cancelled.
        return;
      default: {
        // A genuinely unrecognized method: fail closed so OMP is never left
        // waiting for an answer PI WEB cannot render, and make the failure
        // observable rather than silent.
        this.recordNotification(prefixedId, `Unsupported OMP interaction request "${String(method)}" was automatically dismissed.`, "error");
        if (active !== undefined) active.client.send({ id: frameId, type: "extension_ui_response", cancelled: true });
        return;
      }
    }
  }

  private failBlockingExtensionRequest(prefixedId: string, message: string): void {
    this.eventHub.publish(prefixedId, { type: "session.error", message });
    void this.closeActiveSession(prefixedId).catch((error: unknown) => {
      this.reportCloseFailure(prefixedId, error);
    });
  }

  private recordNotification(prefixedId: string, message: string, severity: SessionNotificationSeverity): void {
    const active = this.active.get(prefixedId);
    if (active === undefined) return;
    const result = this.notificationStore.addNotification(active.notificationGeneration, message, severity);
    for (const mutation of result.mutations) {
      this.eventHub.publish(mutation.sessionId, mutation.inboxEvent);
      this.eventHub.publishNotificationSummary(mutation.summaryEvent);
    }
  }

  // ---------------------------------------------------------------------
  // Notification and unread catalogs (shared, backend-agnostic stores)
  // ---------------------------------------------------------------------

  notificationCatalog(): SessionNotificationCatalogSnapshot {
    return this.notificationStore.catalogSnapshot();
  }

  async unreadCatalog(): Promise<SessionUnreadCatalogSnapshot> {
    return this.unreadStore.durableCatalogSnapshot();
  }

  async acknowledgeUnread(sessionId: string, request: SessionUnreadAcknowledgeRequest): Promise<SessionUnreadCatalogSnapshot> {
    this.unreadStore.acknowledge(sessionId, { ...request, cwd: canonicalizeStoredCwd(request.cwd) });
    this.options.onUnreadChanged?.();
    return this.unreadStore.durableCatalogSnapshot();
  }

  notificationInbox(ref: SessionRouteRef): SessionNotificationInboxSnapshot {
    return this.notificationStore.inboxSnapshot(ref.id, canonicalizeStoredCwd(ref.cwd));
  }

  dismissNotification(ref: SessionRouteRef, request: Omit<SessionNotificationDismissRequest, "cwd">): SessionNotificationInboxSnapshot {
    const result = this.notificationStore.dismissNotification(ref.id, canonicalizeStoredCwd(ref.cwd), request.daemonInstanceId, request.notificationId);
    for (const mutation of result.mutations) {
      this.eventHub.publish(mutation.sessionId, mutation.inboxEvent);
      this.eventHub.publishNotificationSummary(mutation.summaryEvent);
    }
    return result.snapshot;
  }

  dismissAllNotifications(ref: SessionRouteRef, request: Omit<SessionNotificationDismissAllRequest, "cwd">): SessionNotificationInboxSnapshot {
    const result = this.notificationStore.dismissAll(ref.id, canonicalizeStoredCwd(ref.cwd), request.daemonInstanceId, request.throughOrder, request.throughOverflowWatermark);
    for (const mutation of result.mutations) {
      this.eventHub.publish(mutation.sessionId, mutation.inboxEvent);
      this.eventHub.publishNotificationSummary(mutation.summaryEvent);
    }
    return result.snapshot;
  }

  // ---------------------------------------------------------------------
  // Model and thinking-level controls
  // ---------------------------------------------------------------------

  async availableModels(ref: SessionRouteRef): Promise<ClientSessionModel[]> {
    const active = await this.ensureOpen(ref);
    const result = await active.client.request<{ models: ClientSessionModel[] }>({ type: "get_available_models" });
    return result.models;
  }

  async modelCatalog(ref: SessionRouteRef): Promise<ClientSessionModelCatalogEntry[]> {
    const models = await this.availableModels(ref);
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- `models` is the OMP RPC `get_available_models` response typed as the generic wire-boundary ClientSessionModel (optional provider/id); OMP always reports both for real models, but the RPC boundary provides no runtime schema to prove it statically.
    return models.map((model, catalogIndex) => ({ ...model, enabled: true, editable: false, catalogIndex }) as ClientSessionModelCatalogEntry);
  }

  async setModel(ref: SessionRouteRef, provider: string, modelId: string): Promise<ClientSessionStatus> {
    const active = await this.ensureOpen(ref);
    await active.client.request({ type: "set_model", provider, modelId });
    return this.status(ref);
  }

  setModelEnabled(ref: SessionRouteRef, provider: string, modelId: string, enabled: boolean): Promise<ClientSessionModelCatalogEntry[]> {
    void ref;
    void provider;
    void modelId;
    void enabled;
    return this.rejectNotSupported("Toggling individual model availability");
  }

  setModelScope(ref: SessionRouteRef, mode: SessionModelScopeMode): Promise<ClientSessionModelCatalogEntry[]> {
    void ref;
    void mode;
    return this.rejectNotSupported("Bulk model-scope toggling");
  }

  async cycleModel(ref: SessionRouteRef, direction: "forward" | "backward"): Promise<ClientSessionStatus> {
    if (direction === "backward") this.notSupported("Cycling the model backward");
    const active = await this.ensureOpen(ref);
    await active.client.request({ type: "cycle_model" });
    return this.status(ref);
  }

  async availableThinkingLevels(ref: SessionRouteRef): Promise<ClientThinkingLevel[]> {
    await this.ensureOpen(ref);
    return [...OMP_THINKING_LEVELS];
  }

  async setThinkingLevel(ref: SessionRouteRef, level: string): Promise<ClientSessionStatus> {
    const active = await this.ensureOpen(ref);
    await active.client.request({ type: "set_thinking_level", level });
    return this.status(ref);
  }

  async cycleThinkingLevel(ref: SessionRouteRef): Promise<ClientSessionStatus> {
    const active = await this.ensureOpen(ref);
    await active.client.request({ type: "cycle_thinking_level" });
    return this.status(ref);
  }

  // ---------------------------------------------------------------------
  // Commands and prompting
  // ---------------------------------------------------------------------

  async commands(ref: SessionRouteRef): Promise<ClientCommand[]> {
    const active = await this.ensureOpen(ref);
    const result = await active.client.request<{
      commands: (Omit<ClientCommand, "source"> & { source: ClientCommand["source"] | "custom" | "mcp_prompt" | "file" })[];
    }>({ type: "get_available_commands" });
    return result.commands.map((command) => ({
      ...command,
      source: command.source === "custom" ? "extension"
        : command.source === "file" || command.source === "mcp_prompt" ? "prompt"
          : command.source,
    }));
  }

  async prompt(ref: SessionRouteRef, text: unknown, streamingBehavior?: unknown, attachments?: unknown): Promise<void> {
    const active = await this.ensureOpen(ref);
    const message = typeof text === "string" ? text : String(text);
    const type = streamingBehavior === "steer" ? "steer" : streamingBehavior === "followUp" ? "follow_up" : "prompt";
    const images = await this.inlineImagesFromAttachments(attachments);
    await active.client.request({ type, message, ...(images.length === 0 ? {} : { images }) });
  }

  private async inlineImagesFromAttachments(attachments: unknown): Promise<unknown[]> {
    if (!isUnknownArray(attachments)) return [];
    const imageAttachments = attachments.filter((entry): entry is PromptImageAttachment => typeof entry === "object" && entry !== null && "kind" in entry && entry.kind === "image");
    if (imageAttachments.length === 0) return [];
    const inlined = await attachmentsToInlineImages(imageAttachments);
    return inlined.map((entry) => entry.image);
  }

  async saveAttachments(ref: SessionRouteRef, attachments: unknown, folder?: string): Promise<SavedPromptAttachment[]> {
    const active = await this.ensureOpen(ref);
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- `attachments` is the route boundary's parsed request-body value (arbitrary JSON); no runtime schema here narrows it to PromptAttachment beyond the array check.
    const list = Array.isArray(attachments) ? (attachments as PromptAttachment[]) : [];
    if (list.length === 0) return [];
    return saveAttachmentsToWorkspace(active.cwd, list, folder === undefined ? {} : { folder });
  }

  async shell(ref: SessionRouteRef, text: string): Promise<void> {
    if (text.startsWith("!!")) {
      throw new Error("Shell commands excluded from conversation context are not supported for OMP sessions");
    }
    const command = text.slice(1).trim();
    if (command.length === 0) throw new Error("Usage: !<shell command>");
    const active = await this.ensureOpen(ref);
    if (active.isBashRunning) throw new Error("A bash command is already running");

    active.isBashRunning = true;
    this.eventHub.publish(ref.id, { type: "shell.start", command, excludeFromContext: false });
    this.publishActivity(active, "OMP shell command running");
    this.publishStatus(active);
    void active.client.request<{ exitCode?: number; cancelled?: boolean; output?: string; truncated?: boolean }>({ type: "bash", command }).then(
      (result) => {
        active.isBashRunning = false;
        this.eventHub.publish(ref.id, {
          type: "shell.end",
          ...(result.output === undefined ? {} : { output: result.output }),
          exitCode: result.exitCode ?? null,
          cancelled: result.cancelled ?? false,
          truncated: result.truncated ?? false,
        });
        this.publishActivity(active, "OMP shell command finished");
        this.publishStatus(active);
      },
      (error: unknown) => {
        active.isBashRunning = false;
        this.eventHub.publish(ref.id, { type: "shell.end", isError: true, output: errorMessage(error) });
        this.publishActivity(active, "OMP shell command failed", "error");
        this.publishStatus(active);
      },
    );
  }

  async runCommand(ref: SessionRouteRef, text: string): Promise<ClientCommandResult> {
    const active = await this.ensureOpen(ref);
    await active.client.request<{ agentInvoked?: boolean }>({ type: "prompt", message: text });
    return { type: "done" };
  }

  respondToCommand(ref: SessionRouteRef, requestId: string, value: string): Promise<ClientCommandResult> {
    void ref;
    void requestId;
    void value;
    return this.rejectNotSupported("Responding to an interactive slash-command follow-up");
  }

  // ---------------------------------------------------------------------
  // Session tree (OMP can rewind user messages, not navigate arbitrary entries)
  // ---------------------------------------------------------------------

  navigateTree(ref: SessionRouteRef, request: ClientSessionTreeNavigateRequest): Promise<ClientSessionTreeNavigateResult> {
    void ref;
    void request;
    return this.rejectNotSupported("Session tree navigation");
  }

  forkFromTree(ref: SessionRouteRef, request: ClientSessionTreeForkRequest): Promise<ClientSessionTreeForkResult> {
    void ref;
    void request;
    return this.rejectNotSupported("Forking from an arbitrary session-tree entry");
  }

  // ---------------------------------------------------------------------
  // Abort / stop / reload
  // ---------------------------------------------------------------------

  async abort(ref: SessionRouteRef): Promise<void> {
    const active = this.active.get(ref.id);
    if (active === undefined) return;
    await active.client.request({ type: active.isBashRunning ? "abort_bash" : "abort" });
  }

  async stop(ref: SessionRouteRef): Promise<void> {
    await this.closeActiveSession(ref.id);
  }

  async reload(ref: SessionRouteRef): Promise<void> {
    await this.closeActiveSession(ref.id);
    await this.ensureOpen(ref);
  }

  // ---------------------------------------------------------------------
  // Archive / restore / cleanup
  // ---------------------------------------------------------------------

  async archive(ref: SessionRouteRef): Promise<void> {
    fromOmpSessionId(ref.id);
    const active = this.active.get(ref.id);
    await this.closeActiveSession(ref.id);
    const input = await this.archiveInputForRef(ref, active);
    await this.archiveStore.archive(input);
    await this.forgetUnreadSessions([{ sessionId: ref.id, cwd: ref.cwd }]);
  }

  async archiveTree(ref: SessionRouteRef): Promise<ClientArchiveSessionsResponse> {
    // OMP has no tracked-subsession/session-tree concept for pi-web to walk
    // (contract item 4: OMP sessions never get the spawn_session/subsession
    // tools registered), so archiving a "tree" degenerates to archiving the
    // one session.
    await this.archive(ref);
    return { archived: true, sessionIds: [ref.id], archivedCount: 1, skippedAlreadyArchivedCount: 0 };
  }

  async restore(ref: SessionRouteRef): Promise<void> {
    fromOmpSessionId(ref.id);
    await this.archiveStore.restore(ref.id);
    await this.forgetUnreadSessions([{ sessionId: ref.id, cwd: ref.cwd }]);
  }

  async archiveMany(refs: readonly SessionBulkMutationRef[]): Promise<SessionBulkArchiveResponse> {
    const archivedSessionIds: string[] = [];
    const failures: { sessionId: string; error: string }[] = [];
    for (const ref of refs) {
      try {
        await this.archive({ id: ref.id, cwd: ref.cwd });
        archivedSessionIds.push(ref.id);
      } catch (error: unknown) {
        failures.push({ sessionId: ref.id, error: errorMessage(error) });
      }
    }
    return { archived: true, archivedSessionIds, failures, generatedAt: this.now().toISOString() };
  }

  async deleteArchivedMany(refs: readonly SessionBulkMutationRef[]): Promise<SessionBulkDeleteArchivedResponse> {
    for (const ref of refs) fromOmpSessionId(ref.id);
    const deletedSessionIds = await this.archiveStore.deleteArchivedMany(refs.map((ref) => ref.id));
    const deletedIds = new Set(deletedSessionIds);
    const deletedRefs = refs
      .filter((ref) => deletedIds.has(ref.id))
      .map((ref) => ({ sessionId: ref.id, cwd: ref.cwd }));
    await this.forgetUnreadSessions(deletedRefs);
    const failures = refs.filter((ref) => !deletedIds.has(ref.id)).map((ref) => ({ sessionId: ref.id, error: "Archived session not found" }));
    return { deleted: true, deletedSessionIds, failures, generatedAt: this.now().toISOString() };
  }

  private async archiveInputForRef(ref: SessionRouteRef, active: ActiveOmpSession | undefined): Promise<ArchiveSessionInput> {
    const sessions = await this.store.list(ref.cwd);
    const info = sessions.find((session) => session.id === ref.id);
    const nowIso = this.now().toISOString();
    return {
      sessionId: ref.id,
      cwd: ref.cwd,
      path: info?.path ?? active?.sessionFile ?? "",
      created: info?.created ?? nowIso,
      modified: info?.modified ?? nowIso,
      messageCount: info?.messageCount ?? 0,
      firstMessage: info?.firstMessage ?? "",
      ...(info?.name === undefined ? {} : { name: info.name }),
    };
  }

  private clientSessionFromArchivedRecord(record: ArchivedSessionRecord): ClientSession | undefined {
    if (record.created === undefined || record.modified === undefined) return undefined;
    return {
      id: record.sessionId,
      cwd: record.cwd,
      path: record.archivePath ?? record.originalPath ?? "",
      created: record.created,
      modified: record.modified,
      messageCount: record.messageCount ?? 0,
      firstMessage: record.firstMessage ?? "",
      archived: true,
      archivedAt: record.archivedAt,
      backend: "omp",
      ...(record.name === undefined ? {} : { name: record.name }),
    };
  }

  async cleanupPreview(request: NormalizedSessionCleanupRequest): Promise<ClientSessionCleanupPreviewResponse> {
    return this.cleanupPlan(request);
  }

  async cleanup(request: NormalizedSessionCleanupRequest): Promise<ClientSessionCleanupExecuteResponse> {
    const plan = await this.cleanupPlan(request);
    const skippedBusySessionIds = new Set(plan.skippedBusySessionIds);
    const readyArchiveInputs: ArchiveSessionInput[] = [];
    for (const input of plan.archiveInputs) {
      if (this.sessionHasActiveWork(input.sessionId)) {
        skippedBusySessionIds.add(input.sessionId);
        continue;
      }
      await this.closeActiveSession(input.sessionId);
      readyArchiveInputs.push(input);
    }
    if (readyArchiveInputs.length > 0) await this.archiveStore.archiveMany(readyArchiveInputs);
    await this.forgetUnreadSessions(readyArchiveInputs.map((input) => ({ sessionId: input.sessionId, cwd: input.cwd })));

    const readyDeleteRecords: ArchivedSessionRecord[] = [];
    for (const record of plan.deleteRecords) {
      if (this.sessionHasActiveWork(record.sessionId)) {
        skippedBusySessionIds.add(record.sessionId);
        continue;
      }
      readyDeleteRecords.push(record);
    }
    const deletedIds = readyDeleteRecords.length === 0 ? [] : await this.archiveStore.deleteArchivedMany(readyDeleteRecords.map((record) => record.sessionId));
    const deletedSet = new Set(deletedIds);
    await this.forgetUnreadSessions(
      readyDeleteRecords.filter((record) => deletedSet.has(record.sessionId)).map((record) => ({ sessionId: record.sessionId, cwd: record.cwd })),
    );

    return summarizeSessionCleanupExecution({
      archiveInputs: readyArchiveInputs,
      deleteRecords: readyDeleteRecords.filter((record) => deletedSet.has(record.sessionId)),
      thresholds: plan.thresholds,
      generatedAt: plan.generatedAt,
      skippedBusySessionIds: [...skippedBusySessionIds],
    });
  }

  private sessionHasActiveWork(sessionId: string): boolean {
    const active = this.active.get(sessionId);
    return active !== undefined && (active.partial !== null || active.isBashRunning);
  }

  private async cleanupPlan(request: NormalizedSessionCleanupRequest): Promise<SessionCleanupPlan> {
    const [sessions, archivedRecords] = await Promise.all([
      request.projectCwds === undefined
        ? this.store.listAll()
        : Promise.all(request.projectCwds.map((cwd) => this.store.list(cwd))).then((lists) => lists.flat()),
      this.archiveStore.list(),
    ]);
    return planSessionCleanup({
      sessions: sessions.map((info) => ({
        id: info.id,
        path: info.path,
        cwd: info.cwd,
        created: new Date(info.created),
        modified: new Date(info.modified),
        messageCount: info.messageCount,
        firstMessage: info.firstMessage,
        allMessagesText: "",
        ...(info.name === undefined ? {} : { name: info.name }),
      })),
      archivedRecords: archivedRecords.filter(isValidOmpArchiveRecord),
      activeSessions: [...this.active.keys()].map((sessionId) => ({ sessionId, hasActiveWork: this.sessionHasActiveWork(sessionId) })),
      thresholds: request.thresholds,
      ...(request.projectCwds === undefined ? {} : { projectCwds: request.projectCwds }),
      now: this.now(),
    });
  }

  // ---------------------------------------------------------------------
  // Unsupported operations: no safe OMP RPC equivalent
  // ---------------------------------------------------------------------

  clearQueue(ref: SessionRouteRef): Promise<ClientSessionStatus> {
    void ref;
    return this.rejectNotSupported("Clearing the prompt queue");
  }

  dismissWarning(ref: SessionRouteRef, dismissId: string): Promise<ClientSessionStatus> {
    void ref;
    void dismissId;
    return this.rejectNotSupported("Dismissing a session warning");
  }

  submitAsk(ref: SessionRouteRef, askId: string, submission: AskUserSubmission): Promise<AskUserCloseResponse> {
    void ref;
    void askId;
    void submission;
    return this.rejectNotSupported("The ask_user tool form (native OMP interactive dialogs still work)");
  }

  cancelAsk(ref: SessionRouteRef, askId: string): Promise<AskUserCloseResponse> {
    void ref;
    void askId;
    return this.rejectNotSupported("The ask_user tool form (native OMP interactive dialogs still work)");
  }

  detachParent(ref: SessionRouteRef): Promise<void> {
    void ref;
    return this.rejectNotSupported("Detaching a tracked parent session");
  }

  private notSupported(operation: string): never {
    throw new Error(`${operation} is not supported for OMP sessions`);
  }

  /** Non-async variant of {@link notSupported} for methods with no other await: keeps the public contract a rejected promise (not a synchronous throw) without an eslint-require-await no-op await. */
  private rejectNotSupported(operation: string): Promise<never> {
    return Promise.reject(new Error(`${operation} is not supported for OMP sessions`));
  }

  // ---------------------------------------------------------------------
  // Extension dialog answers (native OMP interactive dialogs)
  // ---------------------------------------------------------------------

  async answerDialog(ref: SessionRouteRef, dialogId: string, value: ExtensionDialogAnswer): Promise<ExtensionDialogCloseResponse> {
    const active = this.active.get(ref.id);
    const result = this.pendingExtensionDialogStore.answer(ref.id, dialogId, value);
    if (result.status === "stale") return { result: "stale", sessionStatus: await this.status(ref) };
    this.replyToDialogFrame(active, dialogId, result.outcome.answer);
    return { result: "closed", outcome: result.outcome, sessionStatus: await this.status(ref) };
  }

  async cancelDialog(ref: SessionRouteRef, dialogId: string): Promise<ExtensionDialogCloseResponse> {
    const active = this.active.get(ref.id);
    const result = this.pendingExtensionDialogStore.cancel(ref.id, dialogId, "cancelled");
    if (result.status === "stale") return { result: "stale", sessionStatus: await this.status(ref) };
    this.replyToDialogFrame(active, dialogId, undefined);
    return { result: "closed", outcome: result.outcome, sessionStatus: await this.status(ref) };
  }

  private replyToDialogFrame(active: ActiveOmpSession | undefined, dialogId: string, answer: ExtensionDialogAnswer | undefined): void {
    const frameId = active?.dialogFrameIdByDialogId.get(dialogId);
    if (active === undefined || frameId === undefined) return;
    active.dialogFrameIdByDialogId.delete(dialogId);
    if (answer === undefined) active.client.send({ id: frameId, type: "extension_ui_response", cancelled: true });
    else if (typeof answer === "boolean") active.client.send({ id: frameId, type: "extension_ui_response", confirmed: answer });
    else active.client.send({ id: frameId, type: "extension_ui_response", value: answer });
  }

  // ---------------------------------------------------------------------
  // Process lifecycle: spawn, dedup, identity confirmation
  // ---------------------------------------------------------------------

  private closeActiveSession(prefixedId: string): Promise<void> {
    const pending = this.pendingCloses.get(prefixedId);
    if (pending !== undefined) return pending;

    const closing: Promise<void> = (async () => {
      const opening = this.pendingOpens.get(prefixedId);
      if (opening !== undefined) await Promise.allSettled([opening]);
      const active = this.active.get(prefixedId);
      if (active === undefined) return;
      if (this.active.get(prefixedId) === active) this.active.delete(prefixedId);
      this.unreadStore.forgetActivity(prefixedId, canonicalizeStoredCwd(active.cwd));
      this.workspaceActivity?.removeSession(prefixedId, canonicalizeStoredCwd(active.cwd));
      this.endSessionDialogs(prefixedId, active);
      active.dialogFrameIdByDialogId.clear();
      await active.client.close().catch((error: unknown) => {
        this.reportCloseFailure(prefixedId, error);
      });
    })().finally(() => {
      if (this.pendingCloses.get(prefixedId) === closing) this.pendingCloses.delete(prefixedId);
    });
    this.pendingCloses.set(prefixedId, closing);
    return closing;
  }

  private spawnClient(input: { cwd: string; sessionFile: string | undefined; idHolder: { current?: string } }): OmpRpcClientLike {
    const client: OmpRpcClientLike = this.createRpcClient({
      cwd: input.cwd,
      agentDir: this.agentDir,
      ...(this.options.command === undefined ? {} : { command: this.options.command }),
      ...(input.sessionFile === undefined ? {} : { sessionFile: input.sessionFile }),
      ...(this.options.env === undefined ? {} : { env: this.options.env }),
      onEvent: (frame) => {
        const prefixedId = input.idHolder.current;
        if (prefixedId !== undefined && this.active.get(prefixedId)?.client === client) {
          this.handleEvent(prefixedId, frame);
        }
      },
    });
    return client;
  }

  private registerActive(prefixedId: string, partial: Omit<ActiveOmpSession, "notificationGeneration">): ActiveOmpSession {
    const existing = this.active.get(prefixedId);
    if (existing !== undefined && existing.client !== partial.client) {
      throw new Error(`OMP session ${prefixedId} is already owned by another active process`);
    }
    const registration = this.notificationStore.registerSession(prefixedId, canonicalizeStoredCwd(partial.cwd));
    for (const mutation of registration.mutations) {
      this.eventHub.publish(mutation.sessionId, mutation.inboxEvent);
      this.eventHub.publishNotificationSummary(mutation.summaryEvent);
    }
    const active: ActiveOmpSession = { ...partial, notificationGeneration: registration.generation };
    this.active.set(prefixedId, active);
    return active;
  }

  /** Ensure a live process backs `ref`, opening (dedup'd) or reusing one. Never falls back to Pi. */
  private async ensureOpen(ref: SessionRouteRef): Promise<ActiveOmpSession> {
    fromOmpSessionId(ref.id); // strict format guard: never silently treat a malformed/non-OMP ref as one
    const closing = this.pendingCloses.get(ref.id);
    if (closing !== undefined) await closing;

    const existing = this.active.get(ref.id);
    if (existing !== undefined) {
      if (canonicalizeStoredCwd(existing.cwd) !== canonicalizeStoredCwd(ref.cwd)) {
        throw new Error(`OMP session ${ref.id} is active for workspace ${existing.cwd}, not ${ref.cwd}`);
      }
      if (existing.client.alive) return existing;
      await this.closeActiveSession(ref.id);
    }
    const pending = this.pendingOpens.get(ref.id);
    if (pending !== undefined) return pending;
    const openPromise = this.openExisting(ref).finally(() => {
      this.pendingOpens.delete(ref.id);
    });
    this.pendingOpens.set(ref.id, openPromise);
    return openPromise;
  }

  private async openExisting(ref: SessionRouteRef): Promise<ActiveOmpSession> {
    const resolved = await this.store.resolve(ref);
    const idHolder: { current?: string } = {};
    const client = this.spawnClient({ cwd: ref.cwd, sessionFile: resolved.path, idHolder });
    await client.start();
    try {
      const stats = await client.request<{ sessionId: string; sessionFile?: string }>({ type: "get_session_stats" });
      const reportedId = validatedOmpSessionId(stringField(stats, "sessionId"));
      if (reportedId !== ref.id) {
        throw new Error(`OMP session identity mismatch: expected ${ref.id}, resumed process reports ${reportedId}`);
      }
      idHolder.current = ref.id;
      return this.registerActive(ref.id, {
        nativeId: stats.sessionId,
        cwd: ref.cwd,
        sessionFile: stats.sessionFile ?? resolved.path,
        client,
        partial: null,
        isBashRunning: false,
        dialogFrameIdByDialogId: new Map(),
      });
    } catch (error: unknown) {
      await client.close().catch(() => undefined);
      throw error;
    }
  }
}
function validatedOmpSessionId(nativeId: string): string {
  const prefixedId = toOmpSessionId(nativeId);
  fromOmpSessionId(prefixedId);
  return prefixedId;
}

function isValidOmpArchiveRecord(record: ArchivedSessionRecord): boolean {
  if (typeof record.cwd !== "string" || record.cwd.trim() === "") return false;
  try {
    fromOmpSessionId(record.sessionId);
    canonicalizeStoredCwd(record.cwd);
    return true;
  } catch {
    return false;
  }
}


function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function normalizeNotifySeverity(value: unknown): SessionNotificationSeverity {
  return value === "warning" || value === "error" ? value : "info";
}
