import { statSync } from "node:fs";
import { open, readFile, writeFile } from "node:fs/promises";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  AuthStorage,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  createEditToolDefinition,
  defineTool,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  type CreateAgentSessionRuntimeFactory,
  type EditToolDetails,
} from "@earendil-works/pi-coding-agent";
import type { ClientArchiveSessionsResponse, ClientCommand, ClientCommandResult, ClientMessagePage, ClientSession, ClientSessionCleanupExecuteResponse, ClientSessionCleanupPreviewResponse, ClientSessionModel, ClientSessionRef, ClientSessionStatus, ClientThinkingLevel, SessionUiEvent } from "../types.js";
import { pageMessagesAtSafeBoundary } from "./messagePaging.js";
import type { SessionEventHub } from "../realtime/sessionEventHub.js";
import { BUILTIN_COMMANDS } from "./builtinCommands.js";
import { SessionCommandService } from "./sessionCommandService.js";
import { SessionArchiveStore, type ArchivedSessionRecord, type ArchiveSessionInput } from "./sessionArchiveStore.js";
import { findArchiveCandidateByIdOrPrefix, planSessionArchiveTree, type SessionArchiveTreeCandidate } from "./sessionArchiveTree.js";
import type { ActiveSession } from "./sessionRuntimeStore.js";
import type { AuthChange } from "./authService.js";
import { deterministicSessionName, fallbackSessionName, generateShortSessionName } from "./sessionNameGenerator.js";
import { computeEditPreview, type EditPreviewResult } from "./editPreview.js";
import { createPiSessionManagerGateway } from "./piSessionManagerGateway.js";
import { attachmentsToInlineImages, saveAttachmentsToWorkspace } from "./attachmentService.js";
import { parsePromptAttachments } from "../../shared/promptAttachments.js";
import type { SavedPromptAttachment, SessionBulkArchiveResponse, SessionBulkDeleteArchivedResponse, SessionBulkFailure, SessionBulkMutationRef } from "../../shared/apiTypes.js";

import { cwdPathsEqual } from "../workingDirectory.js";
import type { WorkspaceActivityService } from "../activity/workspaceActivityService.js";
import { createSpawnSessionToolDefinition, type SpawnSessionInvocation, type SpawnSessionResult } from "./spawnSessionTool.js";
import { createSubsessionToolDefinitions, type SpawnSubsessionInvocation, type SpawnSubsessionResult, type SubsessionCheckResult, type SubsessionReadQuery, type SubsessionReadResult, type SubsessionStatus, type SubsessionSummary, type SubsessionToolDeps } from "./spawnSubsessionTool.js";
import { buildTranscriptView } from "./subsessionTranscript.js";
import { planSessionCleanup, summarizeSessionCleanupExecution, type NormalizedSessionCleanupRequest, type SessionCleanupPlan } from "./sessionCleanup.js";
import type { SpawnTargetDecision, SpawnTargetResolver } from "./spawnTargetResolver.js";
import type { PushService } from "../push/pushService.js";

/**
 * Minimal structured-logging seam, shaped like Fastify's logger so sessiond can
 * pass `app.log` directly. Defaults to a no-op so the service stays usable
 * without booting a server (e.g. in tests).
 */
export interface PiSessionLogger {
  info(details: Record<string, unknown>, message: string): void;
}

const noopLogger: PiSessionLogger = { info() { /* no-op */ } };

function noop(): void {
  // Intentionally empty default unsubscribe callback.
}

function spawnTargetError(decision: Extract<SpawnTargetDecision, { allowed: false }>): Error {
  if (decision.reason === "not-registered") return new Error("Spawning session is not in a registered project");
  return new Error(`cwd must be a workspace of this project. Allowed: ${decision.allowedCwds.join(", ")}`);
}

function authLossWarningKey(sessionId: string, provider: string, modelId: string): string {
  return `${sessionId}:${provider}/${modelId}`;
}

function sessionIdFromLookup(ref: PiSessionLookup): string {
  return typeof ref === "string" ? ref : ref.id;
}

function isPiSessionRef(ref: PiSessionLookup): ref is PiSessionRef {
  return typeof ref !== "string";
}

function lookupMatchesActiveSession(ref: PiSessionLookup, active: ActiveSession<PiSessionRuntime>): boolean {
  return !isPiSessionRef(ref) || cwdPathsEqual(active.runtime.cwd, ref.cwd);
}

type QueuedPromptKind = "steer" | "followUp";

interface QueuedPrompt {
  kind: QueuedPromptKind;
  text: string;
  images?: ImageContent[];
  echoUserMessage?: boolean;
}

interface TrackedSubsessionLink {
  parentSessionId: string;
  childSessionId: string;
  childSessionFile?: string;
  parentSessionFile?: string;
  cwd?: string;
}

interface PersistedParentSubsessionLink {
  spawnedBySessionId: string;
  spawnedSessionId: string;
  spawnedSessionFile?: string;
  cwd?: string;
}

interface PersistedChildSubsessionLink {
  spawnedBySessionId: string;
  spawnedSessionId: string;
}

interface StartSessionOptions {
  parentSession?: string;
  initialModel?: AgentModel;
}

function requirePromptText(value: unknown): string {
  if (typeof value !== "string") throw new Error("Prompt text is required");
  return value;
}

function parsePromptStreamingBehavior(value: unknown): QueuedPromptKind | undefined {
  if (value === undefined) return undefined;
  if (value === "steer" || value === "followUp") return value;
  throw new Error('Prompt streamingBehavior must be "steer" or "followUp"');
}

type SessionArchiveRepository = Pick<SessionArchiveStore, "list" | "get" | "archive" | "restore" | "isArchived"> & {
  archiveMany?: (sessions: readonly ArchiveSessionInput[]) => Promise<ArchivedSessionRecord[]>;
  deleteArchived?: (sessionId: string) => Promise<void>;
  deleteArchivedMany?: (sessionIds: readonly string[]) => Promise<string[]>;
};

export type PiSessionRef = ClientSessionRef;

type PiSessionLookup = string | PiSessionRef;

export interface PiSessionListEntry {
  id: string;
  path: string;
  cwd: string;
  created: Date;
  modified: Date;
  messageCount: number;
  firstMessage: string;
  allMessagesText: string;
  name?: string;
  parentSessionPath?: string;
}

interface WorkspaceArchiveCandidate extends SessionArchiveTreeCandidate {
  cwd: string;
  listEntry?: PiSessionListEntry;
  activeSession?: PiAgentSession;
}

interface BulkSessionLookupContext {
  sessionsByCwd: Map<string, PiSessionListEntry[]>;
  allSessions?: readonly PiSessionListEntry[];
}

interface BulkArchivePlanItem {
  input: ArchiveSessionInput;
}

interface BulkDeletePlanItem {
  record: ArchivedSessionRecord;
}

type AgentModel = NonNullable<SpawnSessionInvocation["model"]>;
type ModelRegistryInstance = ReturnType<typeof ModelRegistry.create>;

export interface PiSessionManager {
  getCwd(): string;
  getBranch(): unknown[];
  getEntries?(): readonly unknown[];
  getLeafId(): string | null;
  getHeader?(): { parentSession?: string } | null | undefined;
  appendCustomEntry?(customType: string, data?: unknown): string;
}

export interface PiSessionManagerGateway {
  list(cwd: string): Promise<PiSessionListEntry[]>;
  create(cwd: string, options?: { parentSession?: string }): PiSessionManager;
  /**
   * Legacy id-only lookup surface for older clients. This intentionally searches
   * only Pi's default session store, because custom session directories require
   * a cwd-scoped lookup.
   */
  listAll?(): Promise<PiSessionListEntry[]>;
  open(path: string): PiSessionManager;
}

interface PiExtensionError {
  extensionPath: string;
  event: string;
  error: string;
  stack?: string;
}

interface PiExtensionBindings {
  onError?: (error: PiExtensionError) => void;
}

export interface PiAgentSession {
  modelRegistry: ModelRegistryInstance;
  sessionManager: PiSessionManager;
  scopedModels: readonly { model: AgentModel; thinkingLevel?: ClientThinkingLevel }[];
  sessionId: string;
  sessionFile: string | undefined;
  sessionName: string | undefined;
  messages: readonly unknown[];
  model: AgentModel | undefined;
  thinkingLevel: ClientThinkingLevel;
  isStreaming: boolean;
  isCompacting: boolean;
  isBashRunning: boolean;
  pendingMessageCount: number;
  extensionRunner: { getRegisteredCommands(): readonly { invocationName: string; description?: string }[] };
  promptTemplates: readonly { name: string; description?: string }[];
  resourceLoader: { getSkills(): { skills: readonly { name: string; description?: string }[] } };
  subscribe(listener: (event: unknown) => void): () => void;
  bindExtensions(bindings: PiExtensionBindings): Promise<void>;
  compact(instructions?: string): Promise<{ summary: string; tokensBefore: number }>;
  getUserMessagesForForking(): readonly { entryId: string; text: string }[];
  getSessionStats(): { sessionId: string; totalMessages: number; userMessages: number; assistantMessages: number; toolCalls: number; tokens: ClientSessionStatus["tokens"]; cost: number };
  reload(): Promise<void>;
  getContextUsage(): ClientSessionStatus["contextUsage"] | undefined;
  prompt(text: string, options?: { streamingBehavior?: "steer" | "followUp"; images?: ImageContent[] }): Promise<void>;
  sendCustomMessage(message: { customType: string; content: string; display: boolean; details?: unknown }, options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }): Promise<void>;
  executeBash(command: string, onChunk?: (chunk: string) => void, options?: { excludeFromContext?: boolean }): Promise<{ output: string; exitCode: number | undefined; cancelled: boolean; truncated: boolean; fullOutputPath?: string }>;
  abort(): Promise<void>;
  clearQueue(): { steering: string[]; followUp: string[] };
  getSteeringMessages(): readonly string[];
  getFollowUpMessages(): readonly string[];
  setModel(model: AgentModel): Promise<void>;
  cycleModel(direction?: "forward" | "backward"): Promise<{ model: AgentModel } | undefined>;
  getAvailableThinkingLevels(): ClientThinkingLevel[];
  setThinkingLevel(level: ClientThinkingLevel): void;
  cycleThinkingLevel(): ClientThinkingLevel | undefined;
  setSessionName(name: string): void;
  /**
   * Narrow re-expression of `AgentSession.agent` (an `@earendil-works/pi-agent-core`
   * `Agent`), exposing only `streamFn` — the resolved-auth/headers/retry "call this
   * model" function pi's own compaction/branch-summarization code uses internally.
   * Lets callers (e.g. session title generation) issue one-off model calls without
   * depending on pi-ai's deprecated `/compat` provider registry or leaking the full
   * `Agent`/`AgentSession` surface.
   */
  agent: { streamFn: StreamFn };
}

export interface PiSessionRuntime {
  readonly cwd: string;
  readonly session: PiAgentSession;
  setRebindSession(rebindSession?: (session: PiAgentSession) => Promise<void>): void;
  fork(entryId: string, options?: { position?: "before" | "at" }): Promise<{ cancelled: boolean; selectedText?: string }>;
  dispose(): Promise<void>;
}

interface CreateAgentRuntimeOptions {
  cwd: string;
  agentDir: string;
  sessionManager: PiSessionManager;
  initialModel?: AgentModel;
}

type PiWebCreateAgentSessionRuntimeFactory = (
  options: Parameters<CreateAgentSessionRuntimeFactory>[0] & { initialModel?: AgentModel }
) => ReturnType<CreateAgentSessionRuntimeFactory>;

type CreateAgentRuntime = (createRuntime: PiWebCreateAgentSessionRuntimeFactory, options: CreateAgentRuntimeOptions) => Promise<PiSessionRuntime>;

function defaultCreateAgentRuntime(createRuntime: PiWebCreateAgentSessionRuntimeFactory, options: CreateAgentRuntimeOptions): Promise<PiSessionRuntime> {
  if (!(options.sessionManager instanceof SessionManager)) throw new Error("Default runtime creation requires an SDK SessionManager");
  const runtimeFactory = createRuntimeWithOneShotInitialModel(createRuntime, options.initialModel);
  return createAgentSessionRuntime(runtimeFactory, {
    cwd: options.cwd,
    agentDir: options.agentDir,
    sessionManager: options.sessionManager,
  });
}

function createRuntimeWithOneShotInitialModel(createRuntime: PiWebCreateAgentSessionRuntimeFactory, initialModel: AgentModel | undefined): CreateAgentSessionRuntimeFactory {
  // The inherited model belongs only to the session being spawned. Do not keep
  // reapplying it if that runtime later creates/forks/switches sessions itself.
  let pendingInitialModel = initialModel;
  return async (options) => {
    const model = pendingInitialModel;
    pendingInitialModel = undefined;
    return createRuntime({
      ...options,
      ...(model === undefined ? {} : { initialModel: model }),
    });
  };
}

type SpawnSessionFn = (input: SpawnSessionInvocation) => Promise<SpawnSessionResult>;

function createDefaultRuntimeFactory(authStorage: AuthStorage, modelRegistry: ModelRegistryInstance, spawn?: SpawnSessionFn, subsessions?: SubsessionToolDeps): PiWebCreateAgentSessionRuntimeFactory {
  return async ({ cwd, agentDir, sessionManager, sessionStartEvent, initialModel }) => {
    const services = await createAgentSessionServices({ cwd, agentDir, authStorage, modelRegistry });
    const customTools = [
      createPiWebEditToolDefinition(cwd),
      ...(spawn === undefined ? [] : [createSpawnSessionToolDefinition(cwd, { spawn })]),
      ...(subsessions === undefined ? [] : createSubsessionToolDefinitions(cwd, subsessions)),
    ];
    const result = await createAgentSessionFromServices({
      services,
      sessionManager,
      customTools,
      ...(sessionStartEvent === undefined ? {} : { sessionStartEvent }),
      ...(initialModel === undefined ? {} : { model: initialModel }),
    });
    return { ...result, services, diagnostics: services.diagnostics };
  };
}

type PiWebEditToolDetails = EditToolDetails | { preview: EditPreviewResult } | undefined;

function createPiWebEditToolDefinition(cwd: string) {
  const editTool = createEditToolDefinition(cwd);
  return defineTool<typeof editTool.parameters, PiWebEditToolDetails>({
    name: editTool.name,
    label: editTool.label,
    description: editTool.description,
    ...(editTool.promptSnippet === undefined ? {} : { promptSnippet: editTool.promptSnippet }),
    ...(editTool.promptGuidelines === undefined ? {} : { promptGuidelines: editTool.promptGuidelines }),
    parameters: editTool.parameters,
    ...(editTool.renderShell === undefined ? {} : { renderShell: editTool.renderShell }),
    ...(editTool.prepareArguments === undefined ? {} : { prepareArguments: editTool.prepareArguments }),
    ...(editTool.executionMode === undefined ? {} : { executionMode: editTool.executionMode }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const preview = await computeEditPreview(params.path, params.edits, cwd);
      if (signal?.aborted !== true) {
        onUpdate?.({ content: [{ type: "text", text: "Edit preview computed." }], details: { preview } });
      }
      return editTool.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  });
}

export interface PiSessionServiceDependencies {
  archiveStore?: SessionArchiveRepository;
  agentDir?: string;
  sessionManager?: PiSessionManagerGateway;
  createRuntime?: PiWebCreateAgentSessionRuntimeFactory;
  createAgentRuntime?: CreateAgentRuntime;
  modelRegistry?: ModelRegistryInstance;
  heartbeatIntervalMs?: number;
  workspaceActivity?: Pick<WorkspaceActivityService, "applySessionStatus" | "applySessionActivity" | "removeSession" | "reconcileSessionActivity">;
  /**
   * When provided, the `spawn_session` tool is registered on every session,
   * letting the LLM start new sessions scoped to its project's workspaces.
   * Omit to keep the capability disabled (the tool is never registered).
   */
  spawnTargets?: SpawnTargetResolver;
  /**
   * Beta: when true (and `spawnTargets` is provided), the tracked-subsession
   * tools (`spawn_subsession`, `list_subsessions`, `check_subsession`,
   * `read_subsession`) are
   * registered on every session. Off by default so the capability can ship in
   * main without being exposed in releases.
   */
  subsessionsEnabled?: boolean;
  /** Structured logger for notable runtime events (e.g. spawns). */
  logger?: PiSessionLogger;
  /** Clock seam for cleanup planning tests. */
  now?: () => Date;
  /** Best-effort OS push notification on agent completion. Never throws. */
  pushNotifier?: Pick<PushService, "isEnabled" | "send">;
}

export class PiSessionService {
  private readonly active = new Map<string, ActiveSession<PiSessionRuntime>>();
  private readonly activities = new Map<string, { phase: "active" | "idle" | "error"; label: string; detail?: string; at: string }>();
  private readonly heartbeat: NodeJS.Timeout;
  private readonly commandService: SessionCommandService<PiAgentSession>;
  private readonly compactionPromptQueues = new Map<string, QueuedPrompt[]>();
  private readonly compactionDrainTimers = new Map<string, NodeJS.Timeout>();
  private readonly authLossWarnings = new Set<string>();
  /** Tracked subsession id -> the parent session id that spawned it. */
  private readonly subsessionParents = new Map<string, string>();
  /** Parent session id -> the set of tracked subsession ids it spawned. */
  private readonly subsessionChildren = new Map<string, Set<string>>();
  /** Tracked subsession id -> persisted recovery details for the child. */
  private readonly subsessionLinks = new Map<string, TrackedSubsessionLink>();
  /** Parent id/file identities whose persisted links have already been loaded. */
  private readonly subsessionHydratedParents = new Set<string>();
  /**
   * Tracked subsession id -> whether a completion notification is armed.
   * Armed when the child starts working; firing on completion disarms it so a
   * child that works again (and stops again) notifies the parent each time.
   */
  private readonly subsessionNotifyArmed = new Map<string, boolean>();
  private readonly archiveStore: SessionArchiveRepository;
  private readonly agentDir: string;
  private readonly sessionManager: PiSessionManagerGateway;
  private readonly createRuntime: PiWebCreateAgentSessionRuntimeFactory;
  private readonly createAgentRuntime: CreateAgentRuntime;
  private readonly modelRegistry: ModelRegistryInstance;
  private readonly workspaceActivity: Pick<WorkspaceActivityService, "applySessionStatus" | "applySessionActivity" | "removeSession" | "reconcileSessionActivity"> | undefined;
  private readonly spawnTargets: SpawnTargetResolver | undefined;
  private readonly logger: PiSessionLogger;
  private readonly now: () => Date;
  private readonly pushNotifier: Pick<PushService, "isEnabled" | "send"> | undefined;

  constructor(private readonly events: SessionEventHub, deps: PiSessionServiceDependencies = {}) {
    this.archiveStore = deps.archiveStore ?? new SessionArchiveStore();
    this.agentDir = deps.agentDir ?? getAgentDir();
    this.sessionManager = deps.sessionManager ?? createPiSessionManagerGateway({ agentDir: this.agentDir });
    this.modelRegistry = deps.modelRegistry ?? ModelRegistry.create(AuthStorage.create());
    this.spawnTargets = deps.spawnTargets;
    this.logger = deps.logger ?? noopLogger;
    this.now = deps.now ?? (() => new Date());
    this.pushNotifier = deps.pushNotifier;
    // Subsessions are a beta capability gated behind their own flag, and they
    // also require the spawn capability (they share its project-scope resolver).
    const subsessionsActive = this.spawnTargets !== undefined && deps.subsessionsEnabled === true;
    this.createRuntime = deps.createRuntime ?? createDefaultRuntimeFactory(
      this.modelRegistry.authStorage,
      this.modelRegistry,
      this.spawnTargets === undefined ? undefined : (input) => this.spawnSession(input),
      !subsessionsActive ? undefined : {
        spawn: (input) => this.spawnSubsession(input),
        list: (parentSessionId, parentSessionFile) => this.listSubsessions(parentSessionId, parentSessionFile),
        check: (parentSessionId, sessionId, parentSessionFile) => this.checkSubsession(parentSessionId, sessionId, parentSessionFile),
        read: (parentSessionId, sessionId, query, parentSessionFile) => this.readSubsession(parentSessionId, sessionId, query, parentSessionFile),
      },
    );
    this.createAgentRuntime = deps.createAgentRuntime ?? defaultCreateAgentRuntime;
    this.workspaceActivity = deps.workspaceActivity;
    this.heartbeat = setInterval(() => { this.publishHeartbeats(); }, deps.heartbeatIntervalMs ?? 2000);
    this.commandService = new SessionCommandService(
      (sessionId) => this.getActive(sessionId),
      (sessionId, text) => this.prompt(sessionId, text, undefined, undefined, { echoUserMessage: false }),
      events,
      {
        onCompactionStart: (session) => {
          this.publishActivity(session, "compacting", "active");
          this.publishStatus(session);
        },
        onCompactionEnd: (session, result, detail) => {
          this.publishActivity(session, result === "success" ? "compaction complete" : "compaction failed", result === "success" ? "idle" : "error", detail);
          this.publishStatus(session);
        },
        reloadSession: (session) => this.reloadSessionRuntime(session),
      },
      { listSessionNames: (cwd) => this.listSessionNames(cwd) },
    );
  }

  activeCount(): number {
    return this.active.size;
  }

  async cleanupPreview(request: NormalizedSessionCleanupRequest): Promise<ClientSessionCleanupPreviewResponse> {
    return previewResponseFromPlan(await this.cleanupPlan(request));
  }

  async cleanup(request: NormalizedSessionCleanupRequest): Promise<ClientSessionCleanupExecuteResponse> {
    const plan = await this.cleanupPlan(request);
    if (plan.deleteRecords.length > 0 && this.archiveStore.deleteArchived === undefined && this.archiveStore.deleteArchivedMany === undefined) throw new Error("Archive store does not support deletion");

    const archiveInputs: ArchiveSessionInput[] = [];
    const readyArchiveInputs: ArchiveSessionInput[] = [];
    const deleteRecords: ArchivedSessionRecord[] = [];
    const readyDeleteRecords: ArchivedSessionRecord[] = [];
    const skippedBusySessionIds = new Set(plan.skippedBusySessionIds);

    for (const input of plan.archiveInputs) {
      if (this.activeSessionHasWork(input.sessionId)) {
        skippedBusySessionIds.add(input.sessionId);
        continue;
      }
      await this.closeActive(input.sessionId);
      readyArchiveInputs.push(input);
    }
    await this.archiveStoreArchiveMany(readyArchiveInputs);
    archiveInputs.push(...readyArchiveInputs);

    for (const record of plan.deleteRecords) {
      if (this.activeSessionHasWork(record.sessionId)) {
        skippedBusySessionIds.add(record.sessionId);
        continue;
      }
      await this.closeActive(record.sessionId);
      readyDeleteRecords.push(record);
    }
    await this.ensureArchivedRecordsMoved(readyDeleteRecords);
    const deletedSessionIds = new Set(await this.archiveStoreDeleteArchivedMany(readyDeleteRecords.map((record) => record.sessionId)));
    deleteRecords.push(...readyDeleteRecords.filter((record) => deletedSessionIds.has(record.sessionId)));

    return summarizeSessionCleanupExecution({
      archiveInputs,
      deleteRecords,
      thresholds: plan.thresholds,
      generatedAt: plan.generatedAt,
      skippedBusySessionIds: [...skippedBusySessionIds],
    });
  }

  async dispose(): Promise<void> {
    clearInterval(this.heartbeat);
    this.clearCompactionDrainTimers();
    const activeSessions = Array.from(new Set(this.active.values()));
    this.active.clear();
    this.activities.clear();
    this.compactionPromptQueues.clear();
    this.authLossWarnings.clear();
    this.subsessionParents.clear();
    this.subsessionChildren.clear();
    this.subsessionLinks.clear();
    this.subsessionHydratedParents.clear();
    this.subsessionNotifyArmed.clear();
    await Promise.all(activeSessions.map(async (active) => {
      active.unsubscribe();
      this.workspaceActivity?.removeSession(active.runtime.session.sessionId, active.runtime.session.sessionManager.getCwd());
      await active.runtime.session.abort();
      await active.runtime.dispose();
    }));
  }

  async list(cwd: string): Promise<ClientSession[]> {
    const [sessions, archivedRecords] = await Promise.all([this.sessionManager.list(cwd), this.archiveStore.list()]);
    const sessionsById = new Map(sessions.map((session) => [session.id, session]));
    const archivedForCwd = await Promise.all(
      archivedRecords
        .filter((record) => record.cwd === cwd)
        .map((record) => this.ensureArchivedSessionMoved(record, sessionsById.get(record.sessionId))),
    );
    const archivedById = new Map(archivedForCwd.map((record) => [record.sessionId, record]));
    const unarchivedSessions = sessions.filter((session) => !archivedById.has(session.id)).map(clientSessionFromListEntry);
    this.workspaceActivity?.reconcileSessionActivity(cwd, this.reconcilableSessionIds(cwd, unarchivedSessions.map((session) => session.id), archivedById));
    const archivedSessions = archivedForCwd
      .sort(compareArchivedRecords)
      .map((record) => clientSessionFromArchivedRecord(record, sessionsById.get(record.sessionId)))
      .filter(isDefined);
    return [...unarchivedSessions, ...archivedSessions];
  }

  async start(cwd: string, options: StartSessionOptions = {}): Promise<ClientSession> {
    const active = await this.create(
      this.sessionManager.create(cwd, options.parentSession === undefined ? undefined : { parentSession: options.parentSession }),
      cwd,
      options.initialModel === undefined ? {} : { initialModel: options.initialModel },
    );
    const { session } = active.runtime;
    const created: ClientSession = {
      id: session.sessionId,
      path: session.sessionFile ?? "",
      cwd,
      persisted: sessionFileExists(session.sessionFile),
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
      messageCount: session.messages.length,
      firstMessage: "",
      // Include the parent so listeners can nest the new session in the tree
      // immediately, instead of showing it flat until the next reload.
      ...(options.parentSession === undefined ? {} : { parentSessionPath: options.parentSession }),
    };
    // Broadcast so other clients (and the spawning agent's UI) can add the new
    // session to their list without a manual reload.
    this.events.publishGlobal({ type: "session.created", session: created });
    return created;
  }

  /**
   * Start a new session on behalf of a LLM and deliver an initial prompt to it.
   * The target cwd is constrained to a workspace of the same registered project
   * as the spawning session so the new session is visible in the web UI.
   */
  async spawnSession(input: SpawnSessionInvocation): Promise<SpawnSessionResult> {
    if (this.spawnTargets === undefined) throw new Error("Spawning sessions is disabled");
    const decision = await this.spawnTargets.resolveSpawnTarget(input.spawningCwd, input.cwd);
    if (!decision.allowed) throw spawnTargetError(decision);
    const created = await this.start(decision.cwd, input.model === undefined ? {} : { initialModel: input.model });
    await this.prompt(created.id, input.prompt);
    this.logger.info(
      { spawningCwd: input.spawningCwd, sessionId: created.id, cwd: decision.cwd, promptLength: input.prompt.length },
      "spawn_session started a new session",
    );
    return { sessionId: created.id, cwd: decision.cwd };
  }

  /**
   * Start a *tracked* child session on behalf of a LLM. Identical to
   * {@link spawnSession} in how the target cwd is resolved, but the child
   * records its parent (so it shows in the session tree) and is registered so
   * the parent is notified when it stops working and can inspect it later.
   */
  async spawnSubsession(input: SpawnSubsessionInvocation): Promise<SpawnSubsessionResult> {
    if (this.spawnTargets === undefined) throw new Error("Spawning sessions is disabled");
    const decision = await this.spawnTargets.resolveSpawnTarget(input.spawningCwd, input.cwd);
    if (!decision.allowed) throw spawnTargetError(decision);
    const created = await this.start(decision.cwd, {
      ...(input.parentSessionFile === undefined ? {} : { parentSession: input.parentSessionFile }),
      ...(input.model === undefined ? {} : { initialModel: input.model }),
    });
    const parentSessionFile = nonEmptyString(input.parentSessionFile);
    const link: TrackedSubsessionLink = {
      parentSessionId: input.parentSessionId,
      childSessionId: created.id,
      ...(created.path === "" ? {} : { childSessionFile: created.path }),
      ...(parentSessionFile === undefined ? {} : { parentSessionFile }),
      cwd: decision.cwd,
    };
    this.registerVerifiedSubsession(link);
    this.persistSubsessionLink(link);
    this.persistSubsessionChildMarker(input.parentSessionId, created.id);
    await this.prompt(created.id, input.prompt);
    this.logger.info(
      { parentSessionId: input.parentSessionId, sessionId: created.id, cwd: decision.cwd, promptLength: input.prompt.length },
      "spawn_subsession started a tracked child session",
    );
    return { sessionId: created.id, cwd: decision.cwd };
  }

  /** Summaries of the tracked subsessions spawned by `parentSessionId`. */
  async listSubsessions(parentSessionId: string, parentSessionFile?: string): Promise<SubsessionSummary[]> {
    const parentFile = nonEmptyString(parentSessionFile);
    await this.hydrateSubsessionsForParent(parentSessionId, parentFile);
    const childIds = this.subsessionChildren.get(parentSessionId);
    if (childIds === undefined) return [];
    const authorizedChildIds = [...childIds].filter((childId) => this.subsessionLinkBelongsToParent(parentSessionId, parentFile, childId));
    return Promise.all(authorizedChildIds.map(async (childId) => ({ sessionId: childId, ...(await this.subsessionSummaryFields(childId)) })));
  }

  /** Status and final result of a subsession, scoped to the caller's children. */
  async checkSubsession(parentSessionId: string, sessionId: string, parentSessionFile?: string): Promise<SubsessionCheckResult> {
    const session = await this.openSubsession(parentSessionId, sessionId, parentSessionFile);
    const messages = historyMessages(session);
    return {
      sessionId,
      cwd: session.sessionManager.getCwd(),
      status: this.subsessionStatus(session),
      finalText: finalAssistantText(messages),
      messageCount: messages.length,
    };
  }

  /** Filtered, paginated transcript of a subsession, scoped to the caller's children. */
  async readSubsession(parentSessionId: string, sessionId: string, query: SubsessionReadQuery, parentSessionFile?: string): Promise<SubsessionReadResult> {
    const session = await this.openSubsession(parentSessionId, sessionId, parentSessionFile);
    const view = buildTranscriptView(historyMessages(session), query);
    return {
      sessionId,
      cwd: session.sessionManager.getCwd(),
      status: this.subsessionStatus(session),
      ...view,
    };
  }

  /** Open a session after verifying it is one of the caller's tracked children. */
  private async openSubsession(parentSessionId: string, sessionId: string, parentSessionFile?: string): Promise<PiAgentSession> {
    const parentFile = nonEmptyString(parentSessionFile);
    await this.hydrateSubsessionsForParent(parentSessionId, parentFile);
    if (this.subsessionParents.get(sessionId) !== parentSessionId || !this.subsessionLinkBelongsToParent(parentSessionId, parentFile, sessionId)) {
      throw new Error(`Session ${sessionId} is not one of your subsessions`);
    }
    return this.getOrOpenTrackedSubsession(sessionId);
  }

  private subsessionLinkBelongsToParent(parentSessionId: string, parentSessionFile: string | undefined, childSessionId: string): boolean {
    const link = this.subsessionLinks.get(childSessionId);
    if (link?.parentSessionId !== parentSessionId) return false;
    return parentSessionFile === undefined || trackedLinkParentFileMatches(link, parentSessionFile);
  }

  private activeChildForSubsessionLink(link: TrackedSubsessionLink): ActiveSession<PiSessionRuntime> | undefined {
    const active = this.active.get(link.childSessionId);
    if (active === undefined) return undefined;
    return activeSessionFileMatches(active, link.childSessionFile) ? active : undefined;
  }

  private activeParentForSubsessionLink(link: TrackedSubsessionLink): ActiveSession<PiSessionRuntime> | undefined {
    const active = this.active.get(link.parentSessionId);
    if (active === undefined) return undefined;
    return activeSessionFileMatches(active, link.parentSessionFile) ? active : undefined;
  }

  private subsessionLinkForActiveChild(session: PiAgentSession): TrackedSubsessionLink | undefined {
    const childId = session.sessionId;
    const parentId = this.subsessionParents.get(childId);
    const link = this.subsessionLinks.get(childId);
    if (parentId === undefined || link?.parentSessionId !== parentId) return undefined;
    return sessionFileMatches(session, link.childSessionFile) ? link : undefined;
  }

  private registerVerifiedSubsession(link: TrackedSubsessionLink): void {
    const { childSessionId, parentSessionId } = link;
    const previousParentId = this.subsessionParents.get(childSessionId);
    if (previousParentId !== undefined && previousParentId !== parentSessionId) {
      const previousChildren = this.subsessionChildren.get(previousParentId);
      previousChildren?.delete(childSessionId);
      if (previousChildren?.size === 0) this.subsessionChildren.delete(previousParentId);
    }

    this.subsessionParents.set(childSessionId, parentSessionId);
    const children = this.subsessionChildren.get(parentSessionId) ?? new Set<string>();
    children.add(childSessionId);
    this.subsessionChildren.set(parentSessionId, children);

    this.subsessionLinks.set(childSessionId, link);
    if (!this.subsessionNotifyArmed.has(childSessionId)) this.subsessionNotifyArmed.set(childSessionId, false);
  }

  private unregisterSubsession(childSessionId: string): void {
    const parentSessionId = this.subsessionParents.get(childSessionId);
    this.subsessionParents.delete(childSessionId);
    this.subsessionLinks.delete(childSessionId);
    this.subsessionNotifyArmed.delete(childSessionId);
    if (parentSessionId === undefined) return;
    const children = this.subsessionChildren.get(parentSessionId);
    children?.delete(childSessionId);
    if (children?.size === 0) this.subsessionChildren.delete(parentSessionId);
  }

  private persistSubsessionLink(link: TrackedSubsessionLink): void {
    const parent = this.activeParentForSubsessionLink(link)?.runtime.session;
    if (parent === undefined) return;
    if (parent.sessionManager.appendCustomEntry === undefined) return;
    try {
      parent.sessionManager.appendCustomEntry(SUBSESSION_LINK_CUSTOM_TYPE, persistedParentSubsessionLinkData(link));
    } catch (error: unknown) {
      this.logger.info(
        { parentSessionId: link.parentSessionId, sessionId: link.childSessionId, error: error instanceof Error ? error.message : String(error) },
        "failed to persist subsession link",
      );
    }
  }

  private persistSubsessionChildMarker(parentSessionId: string, childSessionId: string): void {
    const child = this.active.get(childSessionId)?.runtime.session;
    if (child === undefined) return;
    if (child.sessionManager.appendCustomEntry === undefined) return;
    try {
      child.sessionManager.appendCustomEntry(SUBSESSION_CHILD_LINK_CUSTOM_TYPE, persistedChildSubsessionLinkData(parentSessionId, childSessionId));
    } catch (error: unknown) {
      this.logger.info(
        { parentSessionId, sessionId: childSessionId, error: error instanceof Error ? error.message : String(error) },
        "failed to persist subsession child marker",
      );
    }
  }

  private async hydrateSubsessionsForParent(parentSessionId: string, parentSessionFile?: string): Promise<void> {
    const hydrationKey = subsessionHydratedParentKey(parentSessionId, parentSessionFile);
    if (this.subsessionHydratedParents.has(hydrationKey)) return;

    const activeParent = this.active.get(parentSessionId);
    if (activeParent !== undefined && (parentSessionFile === undefined || activeSessionFileMatches(activeParent, parentSessionFile))) {
      const activeParentFile = nonEmptyString(activeParent.runtime.session.sessionFile);
      await this.registerPersistedSubsessionLinks(parentSessionId, activeParent.runtime.session.sessionManager, activeParentFile);
      this.subsessionHydratedParents.add(hydrationKey);
      return;
    }

    if (parentSessionFile === undefined) return;
    if ((await readSessionHeaderSummary(parentSessionFile))?.id !== parentSessionId) {
      this.subsessionHydratedParents.add(hydrationKey);
      return;
    }

    let parentManager: PiSessionManager;
    try {
      parentManager = this.sessionManager.open(parentSessionFile);
    } catch {
      this.subsessionHydratedParents.add(hydrationKey);
      return;
    }
    await this.registerPersistedSubsessionLinks(parentSessionId, parentManager, parentSessionFile);
    this.subsessionHydratedParents.add(hydrationKey);
  }

  private async registerPersistedSubsessionLinks(parentSessionId: string, parentManager: PiSessionManager, parentSessionFile: string | undefined): Promise<void> {
    // Parent custom links are the authoritative recovery record: verify the
    // exact live child file/header before tracking.
    const entries = parentManager.getEntries?.() ?? parentManager.getBranch();
    for (const entry of entries) {
      const link = parsePersistedParentSubsessionLink(entry);
      if (link === undefined) continue;
      const verified = await this.verifiedSubsessionLinkFromParentLink(parentSessionId, parentSessionFile, link);
      if (verified === undefined) continue;
      this.registerVerifiedSubsession(verified);
    }
  }

  private async verifiedSubsessionLinkFromParentLink(parentSessionId: string, parentSessionFile: string | undefined, link: PersistedParentSubsessionLink): Promise<TrackedSubsessionLink | undefined> {
    if (parentSessionFile === undefined) return undefined;
    if (link.spawnedBySessionId !== parentSessionId) return undefined;
    if (!(await this.parentLinkHasValidChildTarget(parentSessionFile, link))) return undefined;
    return trackedSubsessionLinkFromParentLink(parentSessionId, link, parentSessionFile);
  }

  private async parentLinkHasValidChildTarget(parentSessionFile: string, link: PersistedParentSubsessionLink): Promise<boolean> {
    return link.spawnedSessionFile !== undefined
      && await sessionFileHeaderMatches(link.spawnedSessionFile, { sessionId: link.spawnedSessionId, parentSessionFile });
  }

  private async recoverSubsessionTrackingForOpenedSession(session: PiAgentSession): Promise<void> {
    const link = await this.verifiedSubsessionLinkFromOpenedChild(session);
    if (link === undefined) return;
    this.registerVerifiedSubsession(link);
  }

  private async verifiedSubsessionLinkFromOpenedChild(session: PiAgentSession): Promise<TrackedSubsessionLink | undefined> {
    // Child markers are only hints; the current child header and reciprocal
    // parent custom link must agree on the exact ids and files before relinking.
    const entries = session.sessionManager.getEntries?.() ?? session.sessionManager.getBranch();
    let marker: PersistedChildSubsessionLink | undefined;
    for (const entry of entries) {
      const parsed = parsePersistedChildSubsessionLink(entry);
      if (parsed?.spawnedSessionId === session.sessionId) marker = parsed;
    }
    if (marker === undefined) return undefined;

    const childSessionFile = nonEmptyString(session.sessionFile);
    if (childSessionFile === undefined) return undefined;
    const childHeader = await readSessionHeaderSummary(childSessionFile);
    if (childHeader?.id !== session.sessionId) return undefined;
    const parentSessionFile = nonEmptyString(childHeader.parentSession);
    if (parentSessionFile === undefined) return undefined;
    const parentHeader = await readSessionHeaderSummary(parentSessionFile);
    if (parentHeader?.id !== marker.spawnedBySessionId) return undefined;

    const parentLink = this.findReciprocalParentSubsessionLink(parentSessionFile, marker.spawnedBySessionId, session.sessionId, childSessionFile);
    if (parentLink === undefined) return undefined;
    return {
      parentSessionId: marker.spawnedBySessionId,
      childSessionId: session.sessionId,
      childSessionFile,
      parentSessionFile,
      cwd: parentLink.cwd ?? session.sessionManager.getCwd(),
    };
  }

  private findReciprocalParentSubsessionLink(parentSessionFile: string, parentSessionId: string, childSessionId: string, childSessionFile: string): PersistedParentSubsessionLink | undefined {
    let parentManager: PiSessionManager;
    try {
      parentManager = this.sessionManager.open(parentSessionFile);
    } catch {
      return undefined;
    }
    const entries = parentManager.getEntries?.() ?? parentManager.getBranch();
    for (const entry of entries) {
      const link = parsePersistedParentSubsessionLink(entry);
      if (link === undefined) continue;
      if (link.spawnedBySessionId !== parentSessionId || link.spawnedSessionId !== childSessionId) continue;
      if (link.spawnedSessionFile === undefined || !sessionPathsEqual(link.spawnedSessionFile, childSessionFile)) continue;
      return link;
    }
    return undefined;
  }

  private async getOrOpenTrackedSubsession(sessionId: string): Promise<PiAgentSession> {
    const link = this.subsessionLinks.get(sessionId);
    if (link === undefined) throw new Error("Session not found");

    const active = this.activeChildForSubsessionLink(link);
    if (active !== undefined) return active.runtime.session;

    if (link.childSessionFile !== undefined) {
      if (!(await sessionFileHeaderMatches(link.childSessionFile, { sessionId, parentSessionFile: link.parentSessionFile }))) throw new Error("Session not found");
      const sessionManager = this.sessionManager.open(link.childSessionFile);
      return (await this.create(sessionManager, link.cwd ?? sessionManager.getCwd())).runtime.session;
    }

    throw new Error("Session not found");
  }

  private async subsessionSummaryFields(childSessionId: string): Promise<{ cwd: string; status: SubsessionStatus }> {
    const link = this.subsessionLinks.get(childSessionId);
    const active = link === undefined ? undefined : this.activeChildForSubsessionLink(link);
    if (active !== undefined) {
      return { cwd: active.runtime.cwd, status: this.subsessionStatus(active.runtime.session) };
    }
    if (link?.childSessionFile !== undefined && (await sessionFileHeaderMatches(link.childSessionFile, { sessionId: childSessionId, parentSessionFile: link.parentSessionFile }))) {
      return { cwd: link.cwd ?? "", status: "idle" };
    }
    if (link?.cwd !== undefined) return { cwd: link.cwd, status: "unknown" };
    return { cwd: "", status: "unknown" };
  }

  private subsessionStatus(session: PiAgentSession): SubsessionStatus {
    if (this.hasActiveWork(session)) return "working";
    if (this.activities.get(session.sessionId)?.phase === "error") return "error";
    return "idle";
  }

  /**
   * Drive parent notifications from a tracked child's status. Arms a pending
   * notification while the child is working, and when it stops fires a single
   * follow-up message to the parent via {@link prompt} (which queues if the
   * parent is busy and delivers immediately when it is idle).
   */
  private updateSubsessionTracking(session: PiAgentSession): void {
    const link = this.subsessionLinkForActiveChild(session);
    if (link === undefined) return;
    const childId = link.childSessionId;
    if (this.hasActiveWork(session)) {
      this.subsessionNotifyArmed.set(childId, true);
      return;
    }
    if (this.subsessionNotifyArmed.get(childId) !== true) return;
    this.subsessionNotifyArmed.set(childId, false);
    const status: SubsessionStatus = this.activities.get(childId)?.phase === "error" ? "error" : "idle";
    const finalText = finalAssistantText(historyMessages(session));
    const preview = finalText === "" ? "(no output)" : truncateForNotification(finalText);
    const text = `Subsession ${childId} stopped working (status: ${status}). Latest output:\n\n${preview}\n\nUse check_subsession with sessionId "${childId}" for its status and latest output, or read_subsession to look through its full transcript.`;
    void this.notifyParentOfSubsession(link.parentSessionId, childId, text);
  }

  private async getOrOpenParentForSubsession(parentSessionId: string, childSessionId: string): Promise<PiAgentSession> {
    const link = this.subsessionLinks.get(childSessionId);
    if (link?.parentSessionId !== parentSessionId) throw new Error(`Parent session ${parentSessionId} is not available for subsession notification`);

    const active = this.activeParentForSubsessionLink(link);
    if (active !== undefined) return active.runtime.session;

    const parentSessionFile = link.parentSessionFile;
    if (parentSessionFile === undefined) throw new Error(`Parent session ${parentSessionId} is not available for subsession notification`);
    if ((await readSessionHeaderSummary(parentSessionFile))?.id !== parentSessionId) {
      throw new Error(`Parent session ${parentSessionId} is not available for subsession notification`);
    }
    const sessionManager = this.sessionManager.open(parentSessionFile);
    return (await this.create(sessionManager, sessionManager.getCwd())).runtime.session;
  }

  /**
   * Deliver a subsession-completion notice to the parent as a system-authored
   * custom message rather than a user message, so it is not attributed to the
   * human in the transcript. It still wakes an idle parent (`triggerTurn`) and
   * queues behind in-flight work (`deliverAs: "followUp"`), preserving the
   * established "queue if busy, send and act if idle" behavior.
   */
  private async notifyParentOfSubsession(parentId: string, childId: string, text: string): Promise<void> {
    try {
      const session = await this.getOrOpenParentForSubsession(parentId, childId);
      await session.sendCustomMessage(
        { customType: SUBSESSION_NOTIFICATION_CUSTOM_TYPE, content: text, display: true, details: { sessionId: childId } },
        { triggerTurn: true, deliverAs: "followUp" },
      );
      this.publishStatus(session);
    } catch (error: unknown) {
      this.logger.info(
        { parentSessionId: parentId, sessionId: childId, error: error instanceof Error ? error.message : String(error) },
        "failed to notify parent of subsession completion",
      );
    }
  }

  async messages(ref: PiSessionLookup, page?: { before?: number; limit?: number }): Promise<unknown[] | ClientMessagePage> {
    const session = await this.getOrOpen(ref);
    return pageMessagesAtSafeBoundary(historyMessages(session), page);
  }

  async status(ref: PiSessionLookup): Promise<ClientSessionStatus> {
    return this.statusFromSession(await this.getOrOpen(ref));
  }

  async availableModels(ref: PiSessionLookup): Promise<ClientSessionModel[]> {
    const session = await this.getOrOpen(ref);
    session.modelRegistry.refresh();
    const models = session.scopedModels.length > 0
      ? session.scopedModels.map((scoped) => scoped.model)
      : session.modelRegistry.getAvailable();
    return models.map(modelToClientModel);
  }

  async setModel(ref: PiSessionLookup, provider: string, modelId: string): Promise<ClientSessionStatus> {
    await this.assertWritable(ref);
    const session = await this.getOrOpen(ref);
    session.modelRegistry.refresh();
    const candidates = session.scopedModels.length > 0
      ? session.scopedModels.map((scoped) => scoped.model)
      : session.modelRegistry.getAvailable();
    const model = candidates.find((candidate) => candidate.provider === provider && candidate.id === modelId)
      ?? session.modelRegistry.find(provider, modelId);
    if (model === undefined) throw new Error(`Model not found: ${provider}/${modelId}`);
    await session.setModel(model);
    this.publishActivity(session, `model: ${model.id}`, "idle", model.provider);
    this.publishStatus(session);
    return this.statusFromSession(session);
  }

  async cycleModel(ref: PiSessionLookup, direction: "forward" | "backward"): Promise<ClientSessionStatus> {
    await this.assertWritable(ref);
    const session = await this.getOrOpen(ref);
    const result = await session.cycleModel(direction);
    if (result === undefined) throw new Error(session.scopedModels.length > 0 ? "Only one model in scope" : "Only one model available");
    this.publishActivity(session, `model: ${result.model.id}`, "idle", result.model.provider);
    this.publishStatus(session);
    return this.statusFromSession(session);
  }

  async availableThinkingLevels(ref: PiSessionLookup): Promise<ClientThinkingLevel[]> {
    const session = await this.getOrOpen(ref);
    return session.getAvailableThinkingLevels();
  }

  async setThinkingLevel(ref: PiSessionLookup, level: string): Promise<ClientSessionStatus> {
    await this.assertWritable(ref);
    const session = await this.getOrOpen(ref);
    // pi owns the valid set; validate against the session's live levels rather
    // than a hardcoded union so this stays correct if pi changes the set.
    const available = session.getAvailableThinkingLevels();
    const match = available.find((candidate) => candidate === level);
    if (match === undefined) throw new Error(`Invalid thinking level: ${level}`);
    session.setThinkingLevel(match);
    this.publishActivity(session, `thinking: ${session.thinkingLevel}`, "idle");
    this.publishStatus(session);
    return this.statusFromSession(session);
  }

  async cycleThinkingLevel(ref: PiSessionLookup): Promise<ClientSessionStatus> {
    await this.assertWritable(ref);
    const session = await this.getOrOpen(ref);
    const level = session.cycleThinkingLevel();
    if (level === undefined) throw new Error("Current model does not support thinking");
    this.publishActivity(session, `thinking: ${level}`, "idle");
    this.publishStatus(session);
    return this.statusFromSession(session);
  }

  async commands(ref: PiSessionLookup): Promise<ClientCommand[]> {
    const session = await this.getOrOpen(ref);
    const commands: ClientCommand[] = [...BUILTIN_COMMANDS];
    for (const command of session.extensionRunner.getRegisteredCommands()) {
      commands.push({ name: command.invocationName, ...(command.description === undefined ? {} : { description: command.description }), source: "extension" });
    }
    for (const template of session.promptTemplates) {
      commands.push({ name: template.name, ...(template.description === undefined ? {} : { description: template.description }), source: "prompt" });
    }
    for (const skill of session.resourceLoader.getSkills().skills) {
      commands.push({ name: `skill:${skill.name}`, ...(skill.description === undefined ? {} : { description: skill.description }), source: "skill" });
    }
    return commands.sort((a, b) => a.name.localeCompare(b.name));
  }

  async prompt(ref: PiSessionLookup, text: unknown, streamingBehavior?: unknown, attachments?: unknown, options?: { echoUserMessage?: boolean }): Promise<void> {
    const promptText = requirePromptText(text);
    // Command-forwarded prompts (e.g. /skill:*) are expanded by the agent, which
    // streams the canonical message back. The client doesn't render the raw
    // command text, so the server must not echo it either, or it would show up
    // as a transient line that vanishes on reload.
    const echoUserMessage = options?.echoUserMessage !== false;
    const requestedBehavior = parsePromptStreamingBehavior(streamingBehavior);
    const parsedAttachments = parsePromptAttachments(attachments, { enforceInlineSizeLimit: false });
    const images = (await attachmentsToInlineImages(parsedAttachments)).map((entry) => entry.image);
    await this.assertWritable(ref);
    const session = await this.getOrOpen(ref);
    this.maybeGenerateSessionName(session, promptText);
    const isQueued = session.isStreaming || session.isCompacting;
    const behavior = isQueued ? requestedBehavior ?? "followUp" : undefined;
    if (isQueued && images.length === 0 && this.hasQueuedMessageText(session, promptText)) {
      this.publishActivity(session, "duplicate queued message ignored", "active");
      this.publishStatus(session);
      return;
    }
    if (session.isCompacting) {
      this.enqueuePromptDuringCompaction(session, promptText, behavior ?? "followUp", images, echoUserMessage);
      return;
    }
    void this.submitPrompt(session, promptText, behavior, images, echoUserMessage);
  }

  private submitPrompt(session: PiAgentSession, text: string, behavior: QueuedPromptKind | undefined, images: ImageContent[] = [], echoUserMessage = true): Promise<void> {
    this.publishActivity(session, behavior === "steer" ? "steering queued" : behavior === "followUp" ? "message queued" : "prompt accepted", "active");
    if (behavior === undefined && echoUserMessage) this.events.publish(session.sessionId, { type: "message.append", message: userMessage(text, images) });
    const promptOptions = buildPromptOptions(behavior, images);
    const promptPromise = session.prompt(text, promptOptions).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.publishActivity(session, "error", "error", message);
      this.events.publish(session.sessionId, { type: "session.error", message });
    });
    void promptPromise;
    return promptPromise;
  }

  private enqueuePromptDuringCompaction(session: PiAgentSession, text: string, kind: QueuedPromptKind, images: ImageContent[] = [], echoUserMessage = true): void {
    const queue = this.compactionPromptQueues.get(session.sessionId) ?? [];
    queue.push({ kind, text, ...(images.length > 0 ? { images } : {}), ...(echoUserMessage ? {} : { echoUserMessage: false }) });
    this.compactionPromptQueues.set(session.sessionId, queue);
    this.publishActivity(session, "message queued during compaction", "active");
    this.publishStatus(session);
  }

  async saveAttachments(ref: PiSessionLookup, attachments: unknown, folder?: string): Promise<SavedPromptAttachment[]> {
    const parsed = parsePromptAttachments(attachments, { enforceInlineSizeLimit: false, allowFileAttachments: true });
    if (parsed.length === 0) return [];
    await this.assertWritable(ref);
    const active = await this.getActive(ref);
    return saveAttachmentsToWorkspace(active.runtime.cwd, parsed, folder === undefined ? {} : { folder });
  }

  async shell(ref: PiSessionLookup, text: string): Promise<void> {
    await this.assertWritable(ref);
    const active = await this.getActive(ref);
    const { session } = active.runtime;
    const isExcluded = text.startsWith("!!");
    const command = (isExcluded ? text.slice(2) : text.slice(1)).trim();
    if (!command) throw new Error("Usage: !<shell command>");
    if (session.isBashRunning) throw new Error("A bash command is already running");

    this.publishActivity(session, "running bash", "active", command);
    this.events.publish(session.sessionId, { type: "shell.start", command, excludeFromContext: isExcluded });
    void session.executeBash(command, (chunk) => {
      this.events.publish(session.sessionId, { type: "shell.chunk", chunk });
      this.publishActivity(session, "running bash", "active", command);
      this.publishStatus(session);
    }, { excludeFromContext: isExcluded }).then((result) => {
      this.events.publish(session.sessionId, {
        type: "shell.end",
        output: result.output,
        ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
        cancelled: result.cancelled,
        truncated: result.truncated,
        ...(result.fullOutputPath === undefined ? {} : { fullOutputPath: result.fullOutputPath }),
      });
      this.publishActivity(session, "bash complete", result.exitCode === 0 ? "idle" : "error", command);
      this.publishStatus(session);
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.events.publish(session.sessionId, { type: "shell.end", output: message, isError: true });
      this.events.publish(session.sessionId, { type: "session.error", message });
      this.publishActivity(session, "bash failed", "error", message);
      this.publishStatus(session);
    });
  }

  async runCommand(ref: PiSessionLookup, text: string): Promise<ClientCommandResult> {
    await this.assertWritable(ref);
    const active = await this.getActive(ref);
    return this.commandService.run(active.runtime.session.sessionId, text);
  }

  async respondToCommand(ref: PiSessionLookup, requestId: string, value: string): Promise<ClientCommandResult> {
    await this.assertWritable(ref);
    const active = await this.getActive(ref);
    return this.commandService.respond(active.runtime.session.sessionId, requestId, value);
  }

  private async reloadSessionRuntime(session: PiAgentSession): Promise<void> {
    if (this.hasActiveWork(session)) throw new Error("Stop current session activity before reloading");
    this.publishActivity(session, "reloading resources", "active");
    try {
      await session.reload();
      this.publishActivity(session, "resources reloaded", "idle");
      this.publishStatus(session);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.publishActivity(session, "reload failed", "error", message);
      this.events.publish(session.sessionId, { type: "session.error", message });
      this.publishStatus(session);
      throw error;
    }
  }

  async archive(ref: PiSessionLookup): Promise<void> {
    const session = await this.getOrOpen(ref);
    if (this.hasActiveWork(session)) throw new Error("Stop current session activity before archiving");
    const archiveInput = await this.archiveInputForSession(session);
    await this.closeActive(session.sessionId);
    await this.archiveStore.archive(archiveInput);
  }

  async archiveMany(refs: readonly SessionBulkMutationRef[]): Promise<SessionBulkArchiveResponse> {
    const uniqueRefs = uniqueBulkSessionRefs(refs);
    const [archivedRecords, sessionContext] = await Promise.all([
      this.archiveStore.list(),
      this.bulkSessionLookupContext(uniqueRefs),
    ]);
    const failures: SessionBulkFailure[] = [];
    const alreadyArchivedSessionIds: string[] = [];
    const planItems: BulkArchivePlanItem[] = [];

    for (const ref of uniqueRefs) {
      const archived = findArchivedRecordForBulkRef(archivedRecords, ref);
      if (archived !== undefined) {
        alreadyArchivedSessionIds.push(archived.sessionId);
        continue;
      }

      const active = this.activeForLookup(bulkRefToLookup(ref));
      const listed = findListedSessionForBulkRef(sessionContext, ref);
      const resolvedSessionId = active?.runtime.session.sessionId ?? listed?.id ?? ref.id;
      if (active !== undefined && this.hasActiveWork(active.runtime.session)) {
        failures.push({ sessionId: resolvedSessionId, error: "Stop current session activity before archiving" });
        continue;
      }

      try {
        if (listed !== undefined) {
          planItems.push({ input: archiveInputFromListEntry(listed) });
        } else if (active !== undefined) {
          planItems.push({ input: archiveInputFromActiveSession(active.runtime.session) });
        } else {
          failures.push({ sessionId: ref.id, error: "Session not found" });
        }
      } catch (error: unknown) {
        failures.push({ sessionId: resolvedSessionId, error: errorMessage(error) });
      }
    }

    const readyInputs: ArchiveSessionInput[] = [];
    for (const item of planItems) {
      try {
        await this.closeActive(item.input.sessionId);
        readyInputs.push(item.input);
      } catch (error: unknown) {
        failures.push({ sessionId: item.input.sessionId, error: errorMessage(error) });
      }
    }

    const archivedSessionIds = [...alreadyArchivedSessionIds];
    try {
      const archived = await this.archiveStoreArchiveMany(readyInputs);
      archivedSessionIds.push(...archived.map((record) => record.sessionId));
    } catch (error: unknown) {
      for (const input of readyInputs) failures.push({ sessionId: input.sessionId, error: errorMessage(error) });
    }

    return {
      archived: true,
      archivedSessionIds: uniqueStrings(archivedSessionIds),
      failures,
      generatedAt: new Date().toISOString(),
    };
  }

  async archiveTree(ref: PiSessionLookup): Promise<ClientArchiveSessionsResponse> {
    const session = await this.getOrOpen(ref);
    const catalog = await this.workspaceArchiveCandidates(session.sessionManager.getCwd());
    const root = findArchiveCandidateByIdOrPrefix(catalog, session.sessionId) ?? archiveCandidateFromActiveSession(session, false);
    const plan = planSessionArchiveTree(root, catalog);
    const busy = plan.targets.map((target) => target.activeSession).find((target) => target !== undefined && this.hasActiveWork(target));
    if (busy !== undefined) throw new Error(`Stop current session activity before archiving ${sessionDisplayName(busy)}`);

    const archiveInputs = plan.unarchivedTargets.map((target) => archiveInputFromCandidate(target));
    for (const input of archiveInputs) await this.closeActive(input.sessionId);
    await this.archiveStoreArchiveMany(archiveInputs);

    return {
      archived: true,
      sessionIds: archiveInputs.map((input) => input.sessionId),
      archivedCount: archiveInputs.length,
      skippedAlreadyArchivedCount: plan.skippedAlreadyArchivedCount,
    };
  }

  async restore(ref: PiSessionLookup): Promise<void> {
    const archived = await this.getArchived(ref);
    if (archived === undefined) throw new Error("Session not found");
    await this.closeActive(archived.sessionId);
    await this.archiveStore.restore(archived.sessionId);
  }

  async deleteArchived(ref: PiSessionLookup): Promise<void> {
    const record = await this.getArchived(ref);
    if (record === undefined) throw new Error("Archived session not found");
    if (this.archiveStore.deleteArchived === undefined) throw new Error("Archive store does not support deletion");

    await this.closeActive(record.sessionId);
    if (record.archivePath === undefined) await this.ensureArchivedRecordMoved(record);
    await this.archiveStore.deleteArchived(record.sessionId);
  }

  async deleteArchivedMany(refs: readonly SessionBulkMutationRef[]): Promise<SessionBulkDeleteArchivedResponse> {
    if (this.archiveStore.deleteArchived === undefined && this.archiveStore.deleteArchivedMany === undefined) throw new Error("Archive store does not support deletion");

    const uniqueRefs = uniqueBulkSessionRefs(refs);
    const archivedRecords = await this.archiveStore.list();
    const failures: SessionBulkFailure[] = [];
    const planItems: BulkDeletePlanItem[] = [];

    for (const ref of uniqueRefs) {
      const record = findArchivedRecordForBulkRef(archivedRecords, ref);
      if (record === undefined) {
        failures.push({ sessionId: ref.id, error: "Archived session not found" });
        continue;
      }

      const active = this.activeForLookup({ id: record.sessionId, cwd: record.cwd });
      if (active !== undefined && this.hasActiveWork(active.runtime.session)) {
        failures.push({ sessionId: record.sessionId, error: "Stop current session activity before deleting archived session" });
        continue;
      }
      planItems.push({ record });
    }

    const readyRecords: ArchivedSessionRecord[] = [];
    for (const item of planItems) {
      try {
        await this.closeActive(item.record.sessionId);
        readyRecords.push(item.record);
      } catch (error: unknown) {
        failures.push({ sessionId: item.record.sessionId, error: errorMessage(error) });
      }
    }

    const moveFailures = await this.moveLegacyArchivedRecordsForDelete(readyRecords);
    failures.push(...moveFailures);
    const moveFailureIds = new Set(moveFailures.map((failure) => failure.sessionId));
    const deleteIds = readyRecords
      .map((record) => record.sessionId)
      .filter((sessionId) => !moveFailureIds.has(sessionId));

    let deletedSessionIds: string[] = [];
    try {
      deletedSessionIds = await this.archiveStoreDeleteArchivedMany(deleteIds);
    } catch (error: unknown) {
      for (const sessionId of deleteIds) failures.push({ sessionId, error: errorMessage(error) });
    }

    return {
      deleted: true,
      deletedSessionIds,
      failures,
      generatedAt: new Date().toISOString(),
    };
  }

  async reload(ref: PiSessionLookup): Promise<void> {
    await this.assertWritable(ref);
    const session = await this.getOrOpen(ref);
    if (this.hasActiveWork(session)) throw new Error("Stop current session activity before reloading");
    await this.closeActive(session.sessionId);
    const reopened = await this.getActive(ref);
    this.publishStatus(reopened.runtime.session);
  }

  async detachParent(ref: PiSessionLookup): Promise<void> {
    const session = await this.getOrOpen(ref);
    const sessionFile = session.sessionFile;
    if (sessionFile === undefined || sessionFile === "") throw new Error("Session is not persisted");
    await clearParentSession(sessionFile);
    clearParentSessionHeader(session.sessionManager);
    this.unregisterSubsession(session.sessionId);
  }

  async abort(ref: PiSessionLookup): Promise<void> {
    const active = this.activeForLookup(ref);
    if (active === undefined) return;
    const sessionId = active.runtime.session.sessionId;
    this.clearCompactionPromptQueue(sessionId);
    clearSessionQueue(active.runtime.session);
    await active.runtime.session.abort();
    this.publishActivity(active.runtime.session, "stopped", "idle");
    this.publishStatus(active.runtime.session);
  }

  stop(ref: PiSessionLookup): void {
    const active = this.activeForLookup(ref);
    if (active === undefined) return;
    void this.closeActive(active.runtime.session.sessionId).catch(() => {
      // Best-effort shutdown; callers that need errors await closeActive directly.
    });
  }

  private async bulkSessionLookupContext(refs: readonly SessionBulkMutationRef[]): Promise<BulkSessionLookupContext> {
    const cwdSet = new Set<string>();
    let needsAllSessions = false;
    for (const ref of refs) {
      if (ref.cwd === undefined) needsAllSessions = true;
      else cwdSet.add(ref.cwd);
    }

    const [sessionsByCwd, allSessions] = await Promise.all([
      this.listSessionsByCwd([...cwdSet]),
      needsAllSessions ? this.sessionManager.listAll?.() ?? Promise.resolve([]) : Promise.resolve(undefined),
    ]);
    return allSessions === undefined ? { sessionsByCwd } : { sessionsByCwd, allSessions };
  }

  private async listSessionsByCwd(cwds: readonly string[]): Promise<Map<string, PiSessionListEntry[]>> {
    const uniqueCwds = uniqueStrings(cwds);
    const entries = await Promise.all(uniqueCwds.map(async (cwd) => [cwd, await this.sessionManager.list(cwd)] as const));
    return new Map(entries);
  }

  private async archiveStoreArchiveMany(inputs: readonly ArchiveSessionInput[]): Promise<ArchivedSessionRecord[]> {
    if (inputs.length === 0) return [];
    if (this.archiveStore.archiveMany !== undefined) return this.archiveStore.archiveMany(inputs);
    const records: ArchivedSessionRecord[] = [];
    for (const input of inputs) records.push(await this.archiveStore.archive(input));
    return records;
  }

  private async archiveStoreDeleteArchivedMany(sessionIds: readonly string[]): Promise<string[]> {
    if (sessionIds.length === 0) return [];
    if (this.archiveStore.deleteArchivedMany !== undefined) return this.archiveStore.deleteArchivedMany(sessionIds);
    if (this.archiveStore.deleteArchived === undefined) throw new Error("Archive store does not support deletion");
    for (const sessionId of sessionIds) await this.archiveStore.deleteArchived(sessionId);
    return [...sessionIds];
  }

  private async moveLegacyArchivedRecordsForDelete(records: readonly ArchivedSessionRecord[]): Promise<SessionBulkFailure[]> {
    const legacyRecords = records.filter((record) => record.archivePath === undefined);
    if (legacyRecords.length === 0) return [];

    let sessionsByCwd: Map<string, PiSessionListEntry[]>;
    try {
      sessionsByCwd = await this.listSessionsByCwd(legacyRecords.map((record) => record.cwd));
    } catch (error: unknown) {
      return legacyRecords.map((record) => ({ sessionId: record.sessionId, error: errorMessage(error) }));
    }

    const moveInputs = legacyRecords
      .map((record) => findSessionByIdOrPrefix(sessionsByCwd.get(record.cwd) ?? [], record.sessionId))
      .filter(isDefined)
      .map(archiveInputFromListEntry);
    if (moveInputs.length === 0) return [];

    try {
      await this.archiveStoreArchiveMany(moveInputs);
      return [];
    } catch (error: unknown) {
      const failedIds = new Set(moveInputs.map((input) => input.sessionId));
      return legacyRecords
        .filter((record) => failedIds.has(record.sessionId))
        .map((record) => ({ sessionId: record.sessionId, error: errorMessage(error) }));
    }
  }

  private async cleanupPlan(request: NormalizedSessionCleanupRequest) {
    const [sessions, archivedRecords] = await Promise.all([this.sessionManager.listAll?.() ?? [], this.archiveStore.list()]);
    return planSessionCleanup({
      sessions,
      archivedRecords,
      activeSessions: this.cleanupActiveSessionStatuses(),
      thresholds: request.thresholds,
      ...(request.projectCwds === undefined ? {} : { projectCwds: request.projectCwds }),
      now: this.now(),
    });
  }

  private cleanupActiveSessionStatuses(): { sessionId: string; hasActiveWork: boolean }[] {
    return [...new Set(this.active.values())].map((active) => ({
      sessionId: active.runtime.session.sessionId,
      hasActiveWork: this.hasActiveWork(active.runtime.session),
    }));
  }

  private activeSessionHasWork(sessionId: string): boolean {
    const active = this.active.get(sessionId);
    return active !== undefined && this.hasActiveWork(active.runtime.session);
  }

  private reconcilableSessionIds(cwd: string, listedSessionIds: string[], archivedById: Map<string, ArchivedSessionRecord>): string[] {
    const sessionIds = new Set(listedSessionIds);
    for (const active of new Set(this.active.values())) {
      const session = active.runtime.session;
      if (session.sessionManager.getCwd() === cwd && !archivedById.has(session.sessionId)) sessionIds.add(session.sessionId);
    }
    return [...sessionIds];
  }

  private async ensureArchivedSessionMoved(record: ArchivedSessionRecord, session: PiSessionListEntry | undefined): Promise<ArchivedSessionRecord> {
    if (session === undefined || this.active.has(record.sessionId)) return record;
    try {
      return await this.archiveStore.archive(archiveInputFromListEntry(session));
    } catch {
      return record;
    }
  }

  private async ensureArchivedRecordMoved(record: ArchivedSessionRecord): Promise<ArchivedSessionRecord> {
    const session = (await this.sessionManager.list(record.cwd)).find((candidate) => candidate.id === record.sessionId);
    if (session === undefined) return record;
    const [moved] = await this.archiveStoreArchiveMany([archiveInputFromListEntry(session)]);
    return moved ?? record;
  }

  private async ensureArchivedRecordsMoved(records: readonly ArchivedSessionRecord[]): Promise<void> {
    const legacyRecords = records.filter((record) => record.archivePath === undefined);
    if (legacyRecords.length === 0) return;

    const sessionsByCwd = await this.listSessionsByCwd(legacyRecords.map((record) => record.cwd));
    const moveInputs = legacyRecords
      .map((record) => sessionsByCwd.get(record.cwd)?.find((candidate) => candidate.id === record.sessionId))
      .filter(isDefined)
      .map(archiveInputFromListEntry);
    await this.archiveStoreArchiveMany(moveInputs);
  }

  private async archiveInputForSession(session: PiAgentSession): Promise<ArchiveSessionInput> {
    const cwd = session.sessionManager.getCwd();
    const sessionFile = session.sessionFile;
    if (sessionFile === undefined || sessionFile === "") throw new Error("Session is not persisted");
    const listed = (await this.sessionManager.list(cwd)).find((candidate) => candidate.id === session.sessionId);
    if (listed !== undefined) return archiveInputFromListEntry(listed);
    return archiveInputFromActiveSession(session);
  }

  private async workspaceArchiveCandidates(cwd: string): Promise<WorkspaceArchiveCandidate[]> {
    const [sessions, archivedRecords] = await Promise.all([this.sessionManager.list(cwd), this.archiveStore.list()]);
    const candidates = new Map<string, WorkspaceArchiveCandidate>();
    const archivedById = new Map<string, ArchivedSessionRecord>();

    for (const record of archivedRecords) {
      if (record.cwd === cwd) archivedById.set(record.sessionId, record);
    }

    for (const session of sessions) {
      const archived = archivedById.get(session.id);
      if (archived === undefined) candidates.set(session.id, archiveCandidateFromListEntry(session));
      else {
        const candidate = archiveCandidateFromArchivedRecord(archived, session);
        if (candidate !== undefined) candidates.set(candidate.id, candidate);
      }
    }

    for (const record of archivedById.values()) {
      if (candidates.has(record.sessionId)) continue;
      const candidate = archiveCandidateFromArchivedRecord(record, undefined);
      if (candidate !== undefined) candidates.set(candidate.id, candidate);
    }

    for (const active of new Set(this.active.values())) {
      const session = active.runtime.session;
      if (session.sessionManager.getCwd() !== cwd || archivedById.has(session.sessionId)) continue;
      const existing = candidates.get(session.sessionId);
      candidates.set(session.sessionId, { ...(existing ?? archiveCandidateFromActiveSession(session, false)), activeSession: session });
    }

    return [...candidates.values()];
  }

  private async listSessionNames(cwd: string): Promise<string[]> {
    const [sessions, archivedRecords] = await Promise.all([this.sessionManager.list(cwd), this.archiveStore.list()]);
    const names = new Set<string>();
    for (const session of sessions) addSessionName(names, session.name);
    for (const record of archivedRecords) {
      if (record.cwd === cwd) addSessionName(names, record.name);
    }
    for (const active of new Set(this.active.values())) {
      const session = active.runtime.session;
      if (session.sessionManager.getCwd() === cwd) addSessionName(names, session.sessionName);
    }
    return [...names];
  }

  private async closeActive(sessionId: string): Promise<void> {
    const active = this.active.get(sessionId);
    if (!active) return;
    this.active.delete(sessionId);
    this.activities.delete(sessionId);
    this.workspaceActivity?.removeSession(sessionId, active.runtime.session.sessionManager.getCwd());
    this.clearAuthLossWarningsForSession(sessionId);
    this.clearCompactionPromptQueue(sessionId);
    // Disarm subsession notification before teardown so the abort below cannot
    // emit a "stopped working" event that notifies the parent (e.g. on archive).
    // The parent/children link is kept so the parent can still see the child.
    if (this.subsessionLinkForActiveChild(active.runtime.session) !== undefined) this.subsessionNotifyArmed.delete(sessionId);
    clearSessionQueue(active.runtime.session);
    active.unsubscribe();
    try {
      await active.runtime.session.abort();
    } finally {
      await active.runtime.dispose();
    }
  }

  private async assertWritable(ref: PiSessionLookup): Promise<void> {
    if (await this.getArchived(ref) !== undefined) throw new Error("Archived sessions are read-only. Restore the session to continue.");
  }

  private async getOrOpen(ref: PiSessionLookup): Promise<PiAgentSession> {
    return (await this.getActive(ref)).runtime.session;
  }

  private async getActive(ref: PiSessionLookup): Promise<ActiveSession<PiSessionRuntime>> {
    const active = this.activeForLookup(ref);
    if (active !== undefined) return active;

    const archived = await this.getArchived(ref);
    if (archived?.archivePath !== undefined) return this.create(this.sessionManager.open(archived.archivePath), archived.cwd);

    const match = isPiSessionRef(ref)
      ? (await this.sessionManager.list(ref.cwd)).find((s) => s.id === ref.id || s.id.startsWith(ref.id))
      : (await this.sessionManager.listAll?.() ?? []).find((s) => s.id === ref || s.id.startsWith(ref));
    if (!match) throw new Error("Session not found");
    return this.create(this.sessionManager.open(match.path), match.cwd);
  }

  private async getArchived(ref: PiSessionLookup): Promise<ArchivedSessionRecord | undefined> {
    const archived = await this.archiveStore.get(sessionIdFromLookup(ref));
    if (archived === undefined) return undefined;
    if (isPiSessionRef(ref) && archived.cwd !== ref.cwd) return undefined;
    return archived;
  }

  private activeForLookup(ref: PiSessionLookup): ActiveSession<PiSessionRuntime> | undefined {
    const sessionId = sessionIdFromLookup(ref);
    const exact = this.active.get(sessionId);
    if (exact !== undefined && lookupMatchesActiveSession(ref, exact)) return exact;
    for (const [candidateId, active] of this.active.entries()) {
      if (candidateId.startsWith(sessionId) && lookupMatchesActiveSession(ref, active)) return active;
    }
    return undefined;
  }

  private async create(sessionManager: PiSessionManager, cwd: string, options: Pick<StartSessionOptions, "initialModel"> = {}): Promise<ActiveSession<PiSessionRuntime>> {
    const runtime = await this.createAgentRuntime(this.createRuntime, {
      cwd,
      agentDir: this.agentDir,
      sessionManager,
      ...(options.initialModel === undefined ? {} : { initialModel: options.initialModel }),
    });
    await this.bindSessionExtensions(runtime.session);
    const active: ActiveSession<PiSessionRuntime> = { runtime, unsubscribe: noop };
    this.bindRuntime(active);
    runtime.setRebindSession(async (session) => {
      await this.bindSessionExtensions(session);
      this.bindRuntime(active);
      await this.recoverSubsessionTrackingForOpenedSession(session);
    });
    this.active.set(runtime.session.sessionId, active);
    await this.recoverSubsessionTrackingForOpenedSession(runtime.session);
    this.publishStatus(runtime.session);
    return active;
  }

  private async bindSessionExtensions(session: PiAgentSession): Promise<void> {
    await session.bindExtensions({
      onError: (error) => {
        const message = `${error.extensionPath}: ${error.error}`;
        this.publishActivity(session, "extension error", "error", message);
        this.events.publish(session.sessionId, { type: "session.error", message });
      },
    });
  }

  private bindRuntime(active: ActiveSession<PiSessionRuntime>): void {
    active.unsubscribe();
    const { session } = active.runtime;
    for (const [sessionId, candidate] of this.active.entries()) {
      if (candidate === active) {
        this.active.delete(sessionId);
        if (sessionId !== session.sessionId) this.clearCompactionPromptQueue(sessionId);
      }
    }
    active.unsubscribe = session.subscribe((event) => {
      this.events.publish(session.sessionId, toClientEvent(event));
      this.publishActivityForEvent(session, event);
      const eventType = getString(event, "type");
      if (eventType === "compaction_end") this.scheduleCompactionQueueDrain(session.sessionId);
      if (eventType === "agent_start" || eventType === "agent_end") this.scheduleCompactionQueueDrain(session.sessionId);
      this.publishStatus(session);
      this.updateSubsessionTracking(session);
    });
    this.active.set(session.sessionId, active);
  }

  private scheduleCompactionQueueDrain(sessionId: string, delayMs = 0): void {
    if (!this.compactionPromptQueues.has(sessionId) || this.compactionDrainTimers.has(sessionId)) return;
    const timer = setTimeout(() => {
      this.compactionDrainTimers.delete(sessionId);
      this.drainCompactionPromptQueue(sessionId);
    }, delayMs);
    this.compactionDrainTimers.set(sessionId, timer);
  }

  private drainCompactionPromptQueue(sessionId: string): void {
    const active = this.active.get(sessionId);
    if (active === undefined) return;
    const { session } = active.runtime;
    if (session.isCompacting) {
      this.scheduleCompactionQueueDrain(sessionId, 100);
      return;
    }

    if (session.isStreaming) {
      const queued = this.takeCompactionPromptQueue(sessionId);
      if (queued.length === 0) return;
      this.publishStatus(session);
      for (const prompt of queued) void this.submitPrompt(session, prompt.text, prompt.kind, prompt.images, prompt.echoUserMessage ?? true);
      return;
    }

    const prompt = this.shiftCompactionPrompt(sessionId);
    if (prompt === undefined) return;
    this.publishStatus(session);
    const submitted = this.submitPrompt(session, prompt.text, undefined, prompt.images, prompt.echoUserMessage ?? true);
    void submitted.finally(() => { this.scheduleCompactionQueueDrain(sessionId); });
  }

  private takeCompactionPromptQueue(sessionId: string): QueuedPrompt[] {
    const queued = this.compactionPromptQueues.get(sessionId) ?? [];
    this.compactionPromptQueues.delete(sessionId);
    return queued;
  }

  private shiftCompactionPrompt(sessionId: string): QueuedPrompt | undefined {
    const queue = this.compactionPromptQueues.get(sessionId);
    const prompt = queue?.shift();
    if (queue === undefined || queue.length === 0) this.compactionPromptQueues.delete(sessionId);
    return prompt;
  }

  private clearCompactionPromptQueue(sessionId: string): void {
    this.compactionPromptQueues.delete(sessionId);
    const timer = this.compactionDrainTimers.get(sessionId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.compactionDrainTimers.delete(sessionId);
    }
  }

  private clearCompactionDrainTimers(): void {
    for (const timer of this.compactionDrainTimers.values()) clearTimeout(timer);
    this.compactionDrainTimers.clear();
  }

  private maybeGenerateSessionName(session: PiAgentSession, firstMessage: string): void {
    if (session.sessionName !== undefined || session.messages.length !== 0 || session.isStreaming || session.isCompacting) return;

    const deterministicName = deterministicSessionName(firstMessage);
    if (deterministicName !== undefined) {
      this.applyGeneratedSessionName(session, deterministicName);
      return;
    }

    const model = session.model;
    if (model === undefined) return;

    void generateShortSessionName(session.agent.streamFn, model, firstMessage).then((name) => {
      this.applyGeneratedSessionName(session, name ?? fallbackSessionName(firstMessage));
    }).catch(() => {
      this.applyGeneratedSessionName(session, fallbackSessionName(firstMessage));
    });
  }

  private applyGeneratedSessionName(session: PiAgentSession, name: string | undefined): void {
    if (name === undefined || session.sessionName !== undefined) return;
    session.setSessionName(name);
    this.publishSessionName(session);
  }

  applyAuthChange(change: AuthChange = {}): void {
    this.modelRegistry.refresh();
    for (const active of this.active.values()) {
      const { session } = active.runtime;
      session.modelRegistry.refresh();
      this.syncCurrentModelAuthWarning(session, change.removedProviderId);
      this.publishStatus(session);
    }
  }

  private syncCurrentModelAuthWarning(session: PiAgentSession, removedProviderId: string | undefined): void {
    const model = session.model;
    if (model === undefined) return;
    if (model.provider === "unknown" && model.id === "unknown") return;
    const warningKey = authLossWarningKey(session.sessionId, model.provider, model.id);
    const registered = session.modelRegistry.find(model.provider, model.id);
    if (registered === undefined) return;
    if (session.modelRegistry.hasConfiguredAuth(registered)) {
      this.authLossWarnings.delete(warningKey);
      return;
    }
    if (removedProviderId === undefined || model.provider !== removedProviderId || this.authLossWarnings.has(warningKey)) return;
    this.authLossWarnings.add(warningKey);
    this.events.publish(session.sessionId, {
      type: "command.output",
      level: "error",
      message: `Authentication for ${model.provider}/${model.id} was removed. Use /model to select another model.`,
    });
  }

  private clearAuthLossWarningsForSession(sessionId: string): void {
    const prefix = `${sessionId}:`;
    for (const key of this.authLossWarnings) {
      if (key.startsWith(prefix)) this.authLossWarnings.delete(key);
    }
  }

  private publishSessionName(session: PiAgentSession): void {
    const event = session.sessionName === undefined
      ? { type: "session.name", sessionId: session.sessionId } as const
      : { type: "session.name", sessionId: session.sessionId, name: session.sessionName } as const;
    this.events.publish(session.sessionId, event);
    this.events.publishGlobal(event);
  }

  private publishHeartbeats(): void {
    for (const active of this.active.values()) {
      const { session } = active.runtime;
      // Re-evaluate subsession completion here too: agent_end can arrive while
      // the session still reports active work transiently, so the event-driven
      // latch may not fire. The heartbeat re-checks once the session settles.
      this.updateSubsessionTracking(session);
      const activity = this.activities.get(session.sessionId);
      if (!this.hasActiveWork(session)) {
        if (activity?.phase === "active") this.publishStatus(session);
        continue;
      }
      this.publishStatus(session);
      if (activity?.phase === "active") this.publishActivity(session, activity.label, "active", activity.detail);
      else this.publishActivity(session, this.activityLabelFromStatus(session), "active");
    }
  }

  private activityLabelFromStatus(session: PiAgentSession): string {
    if (session.isCompacting) return "compacting";
    if (session.isBashRunning) return "running bash";
    if (session.isStreaming) return "agent running";
    if (this.pendingMessageCount(session) > 0) return "queued";
    return "active";
  }

  private hasActiveWork(session: PiAgentSession): boolean {
    return sessionHasActiveWork(session, this.compactionQueuedMessages(session.sessionId).length);
  }

  private publishActivityForEvent(session: PiAgentSession, event: unknown): void {
    const eventType = getString(event, "type");
    if (eventType === undefined) return;
    if (eventType === "agent_start") { this.publishActivity(session, "agent running", "active"); return; }
    if (eventType === "agent_end") {
      this.publishActivity(session, "idle", "idle");
      setTimeout(() => {
        this.publishActivity(session, "idle", "idle");
        this.publishStatus(session);
      }, 250);
      this.notifyPushOnAgentEnd(session);
      return;
    }
    if (eventType === "turn_end") { this.publishActivity(session, "turn complete", "idle"); return; }
    if (eventType === "message_start") { this.publishActivity(session, "message started", "active"); return; }
    if (eventType === "message_end") { this.publishActivity(session, "message complete", "idle"); return; }
    if (eventType === "message_update") { this.publishActivity(session, "receiving response", "active"); return; }
    if (eventType === "tool_execution_start") { this.publishActivity(session, "running tool", "active", getString(event, "toolName")); return; }
    if (eventType === "tool_execution_end") {
      const isError = getBoolean(event, "isError") === true;
      this.publishActivity(session, isError ? "tool failed" : "tool complete", isError ? "error" : "idle", getString(event, "toolName"));
      return;
    }
    if (eventType === "bash_execution_start") { this.publishActivity(session, "running bash", "active"); return; }
    if (eventType === "bash_execution_end") { this.publishActivity(session, "bash complete", "idle"); return; }
    if (this.hasActiveWork(session)) this.publishActivity(session, eventType.replaceAll("_", " "), "active");
  }

  private notifyPushOnAgentEnd(session: PiAgentSession): void {
    if (this.pushNotifier?.isEnabled() !== true) return;
    // Tracked subsessions are internal subagent runs, not user-facing work —
    // don't spam a push for every spawn_subsession completion.
    if (this.subsessionParents.has(session.sessionId)) return;

    const name = session.sessionName;
    void this.pushNotifier.send({
      title: name !== undefined ? `"${name}" finished` : "Agent finished",
      body: "The agent has completed its work.",
      tag: `agent-end:${session.sessionId}`,
      url: "/",
      sessionId: session.sessionId,
      machineId: "local",
    });
  }

  private publishActivity(session: PiAgentSession, label: string, phase: "active" | "idle" | "error", detail?: string): void {
    const at = new Date().toISOString();
    const stored = detail === undefined ? { phase, label, at } : { phase, label, detail, at };
    this.activities.set(session.sessionId, stored);
    const activity = detail === undefined ? { sessionId: session.sessionId, phase, label, at } : { sessionId: session.sessionId, phase, label, detail, at };
    this.workspaceActivity?.applySessionActivity(session.sessionManager.getCwd(), activity);
    this.events.publish(session.sessionId, { type: "activity.update", activity });
    this.events.publishGlobal({ type: "activity.update", activity });
  }

  private publishStatus(session: PiAgentSession): void {
    const status = this.statusFromSession(session);
    this.clearStaleActiveActivity(session);
    this.workspaceActivity?.applySessionStatus(session.sessionManager.getCwd(), status);
    this.events.publish(session.sessionId, { type: "status.update", status });
    this.events.publishGlobal({ type: "status.update", status });
  }

  private clearStaleActiveActivity(session: PiAgentSession): void {
    const current = this.activities.get(session.sessionId);
    if (current?.phase !== "active" || this.hasActiveWork(session)) return;
    const at = new Date().toISOString();
    const stored = { phase: "idle" as const, label: "idle", at };
    this.activities.set(session.sessionId, stored);
    const activity = { sessionId: session.sessionId, ...stored };
    this.events.publish(session.sessionId, { type: "activity.update", activity });
    this.events.publishGlobal({ type: "activity.update", activity });
  }

  private statusFromSession(session: PiAgentSession): ClientSessionStatus {
    const stats = session.getSessionStats();
    const model = session.model === undefined ? undefined : modelToClientModel(session.model);
    const contextUsage = session.getContextUsage();
    return {
      sessionId: session.sessionId,
      persisted: sessionFileExists(session.sessionFile),
      ...(model === undefined ? {} : { model }),
      thinkingLevel: session.thinkingLevel,
      isStreaming: session.isStreaming,
      isCompacting: session.isCompacting,
      isBashRunning: session.isBashRunning,
      pendingMessageCount: this.pendingMessageCount(session),
      queuedMessages: queuedMessagesFromSession(session, this.compactionQueuedMessages(session.sessionId)),
      messageCount: session.messages.length,
      tokens: stats.tokens,
      cost: stats.cost,
      ...(contextUsage === undefined ? {} : { contextUsage }),
    };
  }

  private pendingMessageCount(session: PiAgentSession): number {
    return session.pendingMessageCount + this.compactionQueuedMessages(session.sessionId).length;
  }

  private compactionQueuedMessages(sessionId: string): readonly QueuedPrompt[] {
    return this.compactionPromptQueues.get(sessionId) ?? [];
  }

  private hasQueuedMessageText(session: PiAgentSession, text: string): boolean {
    return queuedMessagesFromSession(session, this.compactionQueuedMessages(session.sessionId)).some((message) => message.text === text);
  }
}

function previewResponseFromPlan(plan: SessionCleanupPlan): ClientSessionCleanupPreviewResponse {
  return {
    generatedAt: plan.generatedAt,
    thresholds: plan.thresholds,
    projects: plan.projects,
    totals: plan.totals,
    ...(plan.skippedBusySessionIds.length === 0 ? {} : { skippedBusySessionIds: plan.skippedBusySessionIds }),
  };
}

function uniqueBulkSessionRefs(refs: readonly SessionBulkMutationRef[]): SessionBulkMutationRef[] {
  const seen = new Set<string>();
  const unique: SessionBulkMutationRef[] = [];
  for (const ref of refs) {
    const key = `${ref.cwd ?? ""}\0${ref.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(ref);
  }
  return unique;
}

function bulkRefToLookup(ref: SessionBulkMutationRef): PiSessionLookup {
  return ref.cwd === undefined ? ref.id : { id: ref.id, cwd: ref.cwd };
}

function findArchivedRecordForBulkRef(records: readonly ArchivedSessionRecord[], ref: SessionBulkMutationRef): ArchivedSessionRecord | undefined {
  return records.find((record) => (ref.cwd === undefined || record.cwd === ref.cwd) && (record.sessionId === ref.id || record.sessionId.startsWith(ref.id)));
}

function findListedSessionForBulkRef(context: BulkSessionLookupContext, ref: SessionBulkMutationRef): PiSessionListEntry | undefined {
  if (ref.cwd !== undefined) return findSessionByIdOrPrefix(context.sessionsByCwd.get(ref.cwd) ?? [], ref.id);
  return context.allSessions === undefined ? undefined : findSessionByIdOrPrefix(context.allSessions, ref.id);
}

function findSessionByIdOrPrefix(sessions: readonly PiSessionListEntry[], sessionId: string): PiSessionListEntry | undefined {
  return sessions.find((session) => session.id === sessionId) ?? sessions.find((session) => session.id.startsWith(sessionId));
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function modelToClientModel(model: PiAgentSession["model"]): ClientSessionModel {
  if (model === undefined) return {};
  const name = getString(model, "name");
  const reasoning = getProperty(model, "reasoning");
  return {
    provider: model.provider,
    id: model.id,
    ...(name === undefined ? {} : { name }),
    contextWindow: model.contextWindow,
    ...(reasoning === undefined ? {} : { reasoning }),
  };
}

function clientSessionFromListEntry(session: PiSessionListEntry): ClientSession {
  return {
    id: session.id,
    path: session.path,
    cwd: session.cwd,
    persisted: true,
    ...(session.name === undefined ? {} : { name: session.name }),
    created: session.created.toISOString(),
    modified: session.modified.toISOString(),
    messageCount: session.messageCount,
    firstMessage: session.firstMessage,
    ...(session.parentSessionPath === undefined ? {} : { parentSessionPath: session.parentSessionPath }),
  };
}

function archiveInputFromListEntry(session: PiSessionListEntry): ArchiveSessionInput {
  return {
    sessionId: session.id,
    cwd: session.cwd,
    path: session.path,
    created: session.created.toISOString(),
    modified: session.modified.toISOString(),
    messageCount: session.messageCount,
    firstMessage: session.firstMessage,
    ...(session.name === undefined ? {} : { name: session.name }),
    ...(session.parentSessionPath === undefined ? {} : { parentSessionPath: session.parentSessionPath }),
  };
}

function archiveInputFromActiveSession(session: PiAgentSession): ArchiveSessionInput {
  const sessionFile = session.sessionFile;
  if (sessionFile === undefined || sessionFile === "") throw new Error("Session is not persisted");
  const parentSessionPath = session.sessionManager.getHeader?.()?.parentSession;
  return {
    sessionId: session.sessionId,
    cwd: session.sessionManager.getCwd(),
    path: sessionFile,
    created: new Date().toISOString(),
    modified: new Date().toISOString(),
    messageCount: session.messages.length,
    firstMessage: "",
    ...(session.sessionName === undefined ? {} : { name: session.sessionName }),
    ...(parentSessionPath === undefined ? {} : { parentSessionPath }),
  };
}

function archiveCandidateFromListEntry(session: PiSessionListEntry): WorkspaceArchiveCandidate {
  return {
    id: session.id,
    path: session.path,
    cwd: session.cwd,
    archived: false,
    listEntry: session,
    ...(session.parentSessionPath === undefined ? {} : { parentSessionPath: session.parentSessionPath }),
  };
}

function archiveCandidateFromArchivedRecord(record: ArchivedSessionRecord, fallback: PiSessionListEntry | undefined): WorkspaceArchiveCandidate | undefined {
  const path = record.originalPath ?? fallback?.path;
  if (path === undefined) return undefined;
  const parentSessionPath = record.parentSessionPath ?? fallback?.parentSessionPath;
  return {
    id: record.sessionId,
    path,
    cwd: record.cwd,
    archived: true,
    ...(fallback === undefined ? {} : { listEntry: fallback }),
    ...(parentSessionPath === undefined ? {} : { parentSessionPath }),
  };
}

function archiveCandidateFromActiveSession(session: PiAgentSession, archived: boolean): WorkspaceArchiveCandidate {
  const sessionFile = session.sessionFile;
  if (sessionFile === undefined || sessionFile === "") throw new Error("Session is not persisted");
  const parentSessionPath = session.sessionManager.getHeader?.()?.parentSession;
  return {
    id: session.sessionId,
    path: sessionFile,
    cwd: session.sessionManager.getCwd(),
    archived,
    activeSession: session,
    ...(parentSessionPath === undefined ? {} : { parentSessionPath }),
  };
}

function archiveInputFromCandidate(candidate: WorkspaceArchiveCandidate): ArchiveSessionInput {
  if (candidate.listEntry !== undefined) return archiveInputFromListEntry(candidate.listEntry);
  if (candidate.activeSession !== undefined) return archiveInputFromActiveSession(candidate.activeSession);
  throw new Error(`Session is not available for archiving: ${candidate.id}`);
}

function sessionHasActiveWork(session: PiAgentSession, extraQueuedMessageCount = 0): boolean {
  return session.isStreaming || session.isCompacting || session.isBashRunning || session.pendingMessageCount + extraQueuedMessageCount > 0;
}

function sessionDisplayName(session: PiAgentSession): string {
  return session.sessionName ?? session.sessionId;
}

function clientSessionFromArchivedRecord(record: ArchivedSessionRecord, fallback: PiSessionListEntry | undefined): ClientSession | undefined {
  const path = record.originalPath ?? fallback?.path;
  const created = record.created ?? fallback?.created.toISOString();
  const modified = record.modified ?? fallback?.modified.toISOString();
  const messageCount = record.messageCount ?? fallback?.messageCount;
  const firstMessage = record.firstMessage ?? fallback?.firstMessage;
  if (path === undefined || created === undefined || modified === undefined || messageCount === undefined || firstMessage === undefined) return undefined;
  const name = record.name ?? fallback?.name;
  const parentSessionPath = record.parentSessionPath ?? fallback?.parentSessionPath;
  return {
    id: record.sessionId,
    path,
    cwd: record.cwd,
    ...(name === undefined ? {} : { name }),
    created,
    modified,
    messageCount,
    firstMessage,
    ...(parentSessionPath === undefined ? {} : { parentSessionPath }),
    archived: true,
    archivedAt: record.archivedAt,
  };
}

function addSessionName(names: Set<string>, name: string | undefined): void {
  const trimmed = name?.replace(/\s+/g, " ").trim();
  if (trimmed !== undefined && trimmed !== "") names.add(trimmed);
}

function compareArchivedRecords(a: ArchivedSessionRecord, b: ArchivedSessionRecord): number {
  return archivedTimestamp(b) - archivedTimestamp(a);
}

function archivedTimestamp(record: ArchivedSessionRecord): number {
  const time = Date.parse(record.archivedAt);
  return Number.isNaN(time) ? 0 : time;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function trackedSubsessionLinkFromParentLink(parentSessionId: string, link: PersistedParentSubsessionLink, parentSessionFile: string): TrackedSubsessionLink {
  return {
    parentSessionId,
    childSessionId: link.spawnedSessionId,
    ...(link.spawnedSessionFile === undefined ? {} : { childSessionFile: link.spawnedSessionFile }),
    parentSessionFile,
    ...(link.cwd === undefined ? {} : { cwd: link.cwd }),
  };
}

function persistedParentSubsessionLinkData(link: TrackedSubsessionLink): Record<string, unknown> {
  return {
    version: 1,
    spawnedBySessionId: link.parentSessionId,
    spawnedSessionId: link.childSessionId,
    ...(link.childSessionFile === undefined ? {} : { spawnedSessionFile: link.childSessionFile }),
    ...(link.cwd === undefined ? {} : { cwd: link.cwd }),
  };
}

function persistedChildSubsessionLinkData(parentSessionId: string, childSessionId: string): Record<string, unknown> {
  return {
    version: 1,
    spawnedBySessionId: parentSessionId,
    spawnedSessionId: childSessionId,
  };
}

function parsePersistedParentSubsessionLink(entry: unknown): PersistedParentSubsessionLink | undefined {
  if (!isRecord(entry) || entry["type"] !== "custom" || entry["customType"] !== SUBSESSION_LINK_CUSTOM_TYPE) return undefined;
  const data = entry["data"];
  if (!isRecord(data)) return undefined;
  const spawnedBySessionId = getString(data, "spawnedBySessionId");
  const spawnedSessionId = getString(data, "spawnedSessionId");
  if (spawnedBySessionId === undefined || spawnedBySessionId === "" || spawnedSessionId === undefined || spawnedSessionId === "") return undefined;
  const spawnedSessionFile = getString(data, "spawnedSessionFile");
  const cwd = getString(data, "cwd");
  return {
    spawnedBySessionId,
    spawnedSessionId,
    ...(spawnedSessionFile === undefined || spawnedSessionFile === "" ? {} : { spawnedSessionFile }),
    ...(cwd === undefined || cwd === "" ? {} : { cwd }),
  };
}

function parsePersistedChildSubsessionLink(entry: unknown): PersistedChildSubsessionLink | undefined {
  if (!isRecord(entry) || entry["type"] !== "custom" || entry["customType"] !== SUBSESSION_CHILD_LINK_CUSTOM_TYPE) return undefined;
  const data = entry["data"];
  if (!isRecord(data)) return undefined;
  const spawnedBySessionId = getString(data, "spawnedBySessionId");
  const spawnedSessionId = getString(data, "spawnedSessionId");
  if (spawnedBySessionId === undefined || spawnedBySessionId === "" || spawnedSessionId === undefined || spawnedSessionId === "") return undefined;
  return { spawnedBySessionId, spawnedSessionId };
}

function nonEmptyString(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

function subsessionHydratedParentKey(parentSessionId: string, parentSessionFile: string | undefined): string {
  return `${parentSessionId}\0${parentSessionFile ?? ""}`;
}

function sessionPathsEqual(a: string, b: string): boolean {
  return cwdPathsEqual(a, b);
}

function sessionFileExists(sessionFile: string | undefined): sessionFile is string {
  if (sessionFile === undefined || sessionFile === "") return false;
  try {
    return statSync(sessionFile).isFile();
  } catch {
    return false;
  }
}

function sessionFileMatches(session: PiAgentSession, expectedSessionFile: string | undefined): boolean {
  const sessionFile = nonEmptyString(session.sessionFile);
  return sessionFile !== undefined && expectedSessionFile !== undefined && sessionPathsEqual(sessionFile, expectedSessionFile);
}

function activeSessionFileMatches(active: ActiveSession<PiSessionRuntime>, expectedSessionFile: string | undefined): boolean {
  return sessionFileMatches(active.runtime.session, expectedSessionFile);
}

function trackedLinkParentFileMatches(link: TrackedSubsessionLink, parentSessionFile: string): boolean {
  return link.parentSessionFile !== undefined && sessionPathsEqual(link.parentSessionFile, parentSessionFile);
}

interface SessionHeaderSummary {
  id: string;
  parentSession?: string;
}

async function readSessionHeaderSummary(sessionFile: string): Promise<SessionHeaderSummary | undefined> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(sessionFile, "r");
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const firstLine = buffer.toString("utf8", 0, bytesRead).split("\n", 1)[0];
    if (firstLine === undefined || firstLine === "") return undefined;
    const header: unknown = JSON.parse(firstLine);
    if (!isRecord(header) || header["type"] !== "session" || typeof header["id"] !== "string") return undefined;
    const parentSession = getString(header, "parentSession");
    return { id: header["id"], ...(parentSession === undefined ? {} : { parentSession }) };
  } catch {
    return undefined;
  } finally {
    await file?.close().catch(() => undefined);
  }
}

async function sessionFileHeaderMatches(sessionFile: string, expected: { sessionId: string; parentSessionFile?: string | undefined }): Promise<boolean> {
  const header = await readSessionHeaderSummary(sessionFile);
  if (header?.id !== expected.sessionId) return false;
  if (expected.parentSessionFile === undefined) return true;
  return header.parentSession !== undefined && sessionPathsEqual(header.parentSession, expected.parentSessionFile);
}

async function clearParentSession(sessionFile: string): Promise<void> {
  const content = await readFile(sessionFile, "utf8");
  const newlineIndex = content.indexOf("\n");
  const firstLine = newlineIndex === -1 ? content : content.slice(0, newlineIndex);
  const rest = newlineIndex === -1 ? "" : content.slice(newlineIndex);
  const header: unknown = JSON.parse(firstLine);
  if (!isRecord(header) || header["type"] !== "session") throw new Error("Invalid session file header");
  if (header["parentSession"] === undefined) return;
  delete header["parentSession"];
  await writeFile(sessionFile, `${JSON.stringify(header)}${rest}`, "utf8");
}

function clearParentSessionHeader(sessionManager: PiSessionManager): void {
  const header = sessionManager.getHeader?.();
  if (header !== undefined && header !== null) delete header.parentSession;
}

function clearSessionQueue(session: PiAgentSession): void {
  session.clearQueue();
}

function queuedMessagesFromSession(session: PiAgentSession, extraQueuedMessages: readonly QueuedPrompt[] = []): { kind: "steer" | "followUp"; text: string }[] {
  return [
    ...session.getSteeringMessages().map((text) => ({ kind: "steer" as const, text })),
    ...session.getFollowUpMessages().map((text) => ({ kind: "followUp" as const, text })),
    ...extraQueuedMessages,
  ];
}

function userTextMessage(text: string): { role: "user"; content: string } {
  return { role: "user", content: text };
}

/**
 * Build the optimistic user message echoed to clients. When images are present
 * we mirror pi's content-array shape (`[{type:"text"}, {type:"image"}, ...]`) so
 * the local echo matches what pi persists in the session branch.
 */
function userMessage(text: string, images: ImageContent[]): { role: "user"; content: string | (ImageContent | { type: "text"; text: string })[] } {
  if (images.length === 0) return userTextMessage(text);
  const content: (ImageContent | { type: "text"; text: string })[] = [];
  if (text !== "") content.push({ type: "text", text });
  content.push(...images);
  return { role: "user", content };
}

function buildPromptOptions(behavior: QueuedPromptKind | undefined, images: ImageContent[]): { streamingBehavior?: "steer" | "followUp"; images?: ImageContent[] } | undefined {
  const options: { streamingBehavior?: "steer" | "followUp"; images?: ImageContent[] } = {};
  if (behavior !== undefined) options.streamingBehavior = behavior;
  if (images.length > 0) options.images = images;
  return Object.keys(options).length > 0 ? options : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function historyMessages(session: PiAgentSession): unknown[] {
  const messages: unknown[] = [];
  for (const entry of session.sessionManager.getBranch()) {
    if (!isRecord(entry)) continue;
    if (entry["type"] === "message") messages.push(entry["message"]);
    else if (entry["type"] === "custom_message" && entry["display"] === true) messages.push({ role: "custom", content: entry["content"], customType: entry["customType"], details: entry["details"] });
    else if (entry["type"] === "compaction") messages.push({ role: "system", source: "compaction", content: `Compacted history:\n\n${stringValue(entry["summary"])}` });
    else if (entry["type"] === "branch_summary") messages.push({ role: "system", source: "branch_summary", content: `Branch summary:\n\n${stringValue(entry["summary"])}` });
  }
  return messages;
}

/** custom entry type used to persist parent -> child subsession links outside LLM context. */
const SUBSESSION_LINK_CUSTOM_TYPE = "pi-web.subsession.link";

/** custom entry type used to mark a child as created by spawn_subsession. */
const SUBSESSION_CHILD_LINK_CUSTOM_TYPE = "pi-web.subsession.spawned";

/** customType marking a parent-facing subsession-completion notice. */
const SUBSESSION_NOTIFICATION_CUSTOM_TYPE = "subsession.completion";

const SUBSESSION_NOTIFICATION_PREVIEW_CHARS = 2000;

function truncateForNotification(text: string): string {
  if (text.length <= SUBSESSION_NOTIFICATION_PREVIEW_CHARS) return text;
  return `${text.slice(0, SUBSESSION_NOTIFICATION_PREVIEW_CHARS)}…`;
}

/** Most recent assistant text from a history message list, or "" if none. */
function finalAssistantText(messages: readonly unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!isRecord(message) || message["role"] !== "assistant") continue;
    const content = message["content"];
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) continue;
    const texts: string[] = [];
    for (const part of content) {
      if (isRecord(part) && part["type"] === "text" && typeof part["text"] === "string") texts.push(part["text"]);
    }
    if (texts.length > 0) return texts.join("\n").trim();
  }
  return "";
}

function toClientEvent(event: unknown): SessionUiEvent {
  const eventType = getString(event, "type");
  const assistantMessageEvent = getProperty(event, "assistantMessageEvent");
  if (eventType === "message_update" && getString(assistantMessageEvent, "type") === "text_delta") {
    return { type: "assistant.delta", text: getString(assistantMessageEvent, "delta") ?? "" };
  }
  if (eventType === "message_update" && getString(assistantMessageEvent, "type") === "thinking_delta") {
    return { type: "assistant.thinking.delta", text: getString(assistantMessageEvent, "delta") ?? "" };
  }
  if (eventType === "tool_execution_start") {
    const args = getProperty(event, "args");
    return { type: "tool.start", toolName: getString(event, "toolName") ?? "", toolCallId: getString(event, "toolCallId") ?? "", summary: summarizeToolArgs(args), args };
  }
  if (eventType === "tool_execution_update") {
    const partialResult = getProperty(event, "partialResult");
    return { type: "tool.update", toolName: getString(event, "toolName") ?? "", toolCallId: getString(event, "toolCallId") ?? "", text: stringifyToolResult(partialResult), content: toolResultContent(partialResult), details: toolResultDetails(partialResult) };
  }
  if (eventType === "tool_execution_end") {
    const result = getProperty(event, "result");
    return { type: "tool.end", toolName: getString(event, "toolName") ?? "", toolCallId: getString(event, "toolCallId") ?? "", text: stringifyToolResult(result), content: toolResultContent(result), details: toolResultDetails(result), isError: getBoolean(event, "isError") === true };
  }
  if (eventType === "agent_start") return { type: "agent.start" };
  if (eventType === "agent_end") return { type: "agent.end" };
  if (eventType === "message_end") {
    const message = getProperty(event, "message");
    return message === undefined ? { type: "message.end" } : { type: "message.end", message };
  }
  return { type: "pi.event", eventType: eventType ?? "unknown" };
}

function summarizeToolArgs(args: unknown): string {
  if (!isRecord(args)) return stringifyPrimitive(args);
  const command = getString(args, "command");
  if (command !== undefined) return command;
  const path = getString(args, "path");
  if (path !== undefined) return path;
  if (typeof args["oldText"] === "string" && typeof args["newText"] === "string") return "edit text replacement";
  const edits = args["edits"];
  if (Array.isArray(edits)) return `${String(edits.length)} edit${edits.length === 1 ? "" : "s"}`;
  const entries = Object.entries(args).filter(([, value]) => value != null).slice(0, 3);
  return entries.map(([key, value]) => `${key}: ${shortToolValue(value)}`).join(" · ");
}

function shortToolValue(value: unknown): string {
  if (typeof value === "string") return value.length > 80 ? `${value.slice(0, 77)}…` : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `${String(value.length)} item${value.length === 1 ? "" : "s"}`;
  if (typeof value === "object" && value !== null) return "object";
  return "";
}

function toolResultContent(result: unknown): unknown {
  if (isRecord(result)) {
    const content = getProperty(result, "content");
    if (content !== undefined) return content;
    const text = getString(result, "text") ?? getString(result, "output");
    if (text !== undefined) return [{ type: "text", text }];
  }
  if (typeof result === "string") return [{ type: "text", text: result }];
  return result;
}

function toolResultDetails(result: unknown): unknown {
  return isRecord(result) ? getProperty(result, "details") : undefined;
}

function stringifyToolResult(result: unknown): string {
  if (typeof result === "string") return result;
  if (Array.isArray(result)) return result.map(stringifyToolResult).filter((text) => text !== "").join("\n");
  if (isRecord(result)) {
    if (getString(result, "type") === "image") return "[image]";
    const text = getString(result, "text") ?? getString(result, "content") ?? getString(result, "output");
    if (text !== undefined) return text;
    const content = getProperty(result, "content");
    if (Array.isArray(content)) return stringifyToolResult(content);
    return JSON.stringify(result, null, 2);
  }
  return stringifyPrimitive(result);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getProperty(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function getString(value: unknown, key: string): string | undefined {
  const property = getProperty(value, key);
  return typeof property === "string" ? property : undefined;
}

function getBoolean(value: unknown, key: string): boolean | undefined {
  const property = getProperty(value, key);
  return typeof property === "boolean" ? property : undefined;
}

function stringifyPrimitive(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return "";
}
