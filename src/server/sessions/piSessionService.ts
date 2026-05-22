import { readFile, writeFile } from "node:fs/promises";
import type { Api, Model } from "@earendil-works/pi-ai";
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
import type { ClientCommand, ClientCommandResult, ClientMessagePage, ClientSession, ClientSessionModel, ClientSessionStatus, ClientThinkingLevel, SessionUiEvent } from "../types.js";
import { pageMessagesAtSafeBoundary } from "./messagePaging.js";
import type { SessionEventHub } from "../realtime/sessionEventHub.js";
import { BUILTIN_COMMANDS } from "./builtinCommands.js";
import { SessionCommandService } from "./sessionCommandService.js";
import { SessionArchiveStore, type ArchivedSessionRecord, type ArchiveSessionInput } from "./sessionArchiveStore.js";
import type { ActiveSession } from "./sessionRuntimeStore.js";
import type { AuthChange } from "./authService.js";
import { fallbackSessionName, generateShortSessionName } from "./sessionNameGenerator.js";
import { computeEditPreview, type EditPreviewResult } from "./editPreview.js";
import type { WorkspaceActivityService } from "../activity/workspaceActivityService.js";

function noop(): void {
  // Intentionally empty default unsubscribe callback.
}

function authLossWarningKey(sessionId: string, provider: string, modelId: string): string {
  return `${sessionId}:${provider}/${modelId}`;
}

type SessionArchiveRepository = Pick<SessionArchiveStore, "list" | "get" | "archive" | "restore" | "isArchived">;
interface PiSessionListEntry {
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
type AgentModel = Model<Api>;
type ModelRegistryInstance = ReturnType<typeof ModelRegistry.create>;

export interface PiSessionManager {
  getCwd(): string;
  getBranch(): unknown[];
  getLeafId(): string | null;
  getHeader?(): { parentSession?: string } | null | undefined;
}

export interface PiSessionManagerGateway {
  list(cwd: string): Promise<PiSessionListEntry[]>;
  create(cwd: string): PiSessionManager;
  listAll(): Promise<PiSessionListEntry[]>;
  open(path: string): PiSessionManager;
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
  compact(instructions?: string): Promise<{ summary: string; tokensBefore: number }>;
  getUserMessagesForForking(): readonly { entryId: string; text: string }[];
  getSessionStats(): { sessionId: string; totalMessages: number; userMessages: number; assistantMessages: number; toolCalls: number; tokens: ClientSessionStatus["tokens"]; cost: number };
  getContextUsage(): ClientSessionStatus["contextUsage"] | undefined;
  prompt(text: string, options?: { streamingBehavior?: "steer" | "followUp" }): Promise<void>;
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
}

type CreateAgentRuntime = (createRuntime: CreateAgentSessionRuntimeFactory, options: CreateAgentRuntimeOptions) => Promise<PiSessionRuntime>;

function defaultCreateAgentRuntime(createRuntime: CreateAgentSessionRuntimeFactory, options: CreateAgentRuntimeOptions): Promise<PiSessionRuntime> {
  if (!(options.sessionManager instanceof SessionManager)) throw new Error("Default runtime creation requires an SDK SessionManager");
  return createAgentSessionRuntime(createRuntime, { ...options, sessionManager: options.sessionManager });
}

function createDefaultRuntimeFactory(authStorage: AuthStorage, modelRegistry: ModelRegistryInstance): CreateAgentSessionRuntimeFactory {
  return async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({ cwd, agentDir, authStorage, modelRegistry });
    const customTools = [createPiWebEditToolDefinition(cwd)];
    const options = sessionStartEvent === undefined
      ? { services, sessionManager, customTools }
      : { services, sessionManager, sessionStartEvent, customTools };
    const result = await createAgentSessionFromServices(options);
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
  createRuntime?: CreateAgentSessionRuntimeFactory;
  createAgentRuntime?: CreateAgentRuntime;
  modelRegistry?: ModelRegistryInstance;
  heartbeatIntervalMs?: number;
  workspaceActivity?: Pick<WorkspaceActivityService, "applySessionStatus" | "applySessionActivity" | "removeSession" | "reconcileSessionActivity">;
}

export class PiSessionService {
  private readonly active = new Map<string, ActiveSession<PiSessionRuntime>>();
  private readonly activities = new Map<string, { phase: "active" | "idle" | "error"; label: string; detail?: string; at: string }>();
  private readonly heartbeat: NodeJS.Timeout;
  private readonly commandService: SessionCommandService<PiAgentSession>;
  private readonly authLossWarnings = new Set<string>();
  private readonly archiveStore: SessionArchiveRepository;
  private readonly agentDir: string;
  private readonly sessionManager: PiSessionManagerGateway;
  private readonly createRuntime: CreateAgentSessionRuntimeFactory;
  private readonly createAgentRuntime: CreateAgentRuntime;
  private readonly modelRegistry: ModelRegistryInstance;
  private readonly workspaceActivity: Pick<WorkspaceActivityService, "applySessionStatus" | "applySessionActivity" | "removeSession" | "reconcileSessionActivity"> | undefined;

  constructor(private readonly events: SessionEventHub, deps: PiSessionServiceDependencies = {}) {
    this.archiveStore = deps.archiveStore ?? new SessionArchiveStore();
    this.agentDir = deps.agentDir ?? getAgentDir();
    this.sessionManager = deps.sessionManager ?? SessionManager;
    this.modelRegistry = deps.modelRegistry ?? ModelRegistry.create(AuthStorage.create());
    this.createRuntime = deps.createRuntime ?? createDefaultRuntimeFactory(this.modelRegistry.authStorage, this.modelRegistry);
    this.createAgentRuntime = deps.createAgentRuntime ?? defaultCreateAgentRuntime;
    this.workspaceActivity = deps.workspaceActivity;
    this.heartbeat = setInterval(() => { this.publishHeartbeats(); }, deps.heartbeatIntervalMs ?? 2000);
    this.commandService = new SessionCommandService(
      (sessionId) => this.getActive(sessionId),
      (sessionId, text) => this.prompt(sessionId, text),
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
      },
      { listSessionNames: (cwd) => this.listSessionNames(cwd) },
    );
  }

  activeCount(): number {
    return this.active.size;
  }

  async dispose(): Promise<void> {
    clearInterval(this.heartbeat);
    const activeSessions = Array.from(new Set(this.active.values()));
    this.active.clear();
    this.activities.clear();
    this.authLossWarnings.clear();
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

  async start(cwd: string): Promise<ClientSession> {
    const active = await this.create(this.sessionManager.create(cwd), cwd);
    const { session } = active.runtime;
    return {
      id: session.sessionId,
      path: session.sessionFile ?? "",
      cwd,
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
      messageCount: session.messages.length,
      firstMessage: "",
    };
  }

  async messages(sessionId: string, page?: { before?: number; limit?: number }): Promise<unknown[] | ClientMessagePage> {
    const session = await this.getOrOpen(sessionId);
    return pageMessagesAtSafeBoundary(historyMessages(session), page);
  }

  async status(sessionId: string): Promise<ClientSessionStatus> {
    return this.statusFromSession(await this.getOrOpen(sessionId));
  }

  async availableModels(sessionId: string): Promise<ClientSessionModel[]> {
    const session = await this.getOrOpen(sessionId);
    session.modelRegistry.refresh();
    const models = session.scopedModels.length > 0
      ? session.scopedModels.map((scoped) => scoped.model)
      : session.modelRegistry.getAvailable();
    return models.map(modelToClientModel);
  }

  async setModel(sessionId: string, provider: string, modelId: string): Promise<ClientSessionStatus> {
    await this.assertWritable(sessionId);
    const session = await this.getOrOpen(sessionId);
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

  async cycleModel(sessionId: string, direction: "forward" | "backward"): Promise<ClientSessionStatus> {
    await this.assertWritable(sessionId);
    const session = await this.getOrOpen(sessionId);
    const result = await session.cycleModel(direction);
    if (result === undefined) throw new Error(session.scopedModels.length > 0 ? "Only one model in scope" : "Only one model available");
    this.publishActivity(session, `model: ${result.model.id}`, "idle", result.model.provider);
    this.publishStatus(session);
    return this.statusFromSession(session);
  }

  async availableThinkingLevels(sessionId: string): Promise<ClientThinkingLevel[]> {
    const session = await this.getOrOpen(sessionId);
    return session.getAvailableThinkingLevels();
  }

  async setThinkingLevel(sessionId: string, level: ClientThinkingLevel): Promise<ClientSessionStatus> {
    await this.assertWritable(sessionId);
    const session = await this.getOrOpen(sessionId);
    session.setThinkingLevel(level);
    this.publishActivity(session, `thinking: ${session.thinkingLevel}`, "idle");
    this.publishStatus(session);
    return this.statusFromSession(session);
  }

  async cycleThinkingLevel(sessionId: string): Promise<ClientSessionStatus> {
    await this.assertWritable(sessionId);
    const session = await this.getOrOpen(sessionId);
    const level = session.cycleThinkingLevel();
    if (level === undefined) throw new Error("Current model does not support thinking");
    this.publishActivity(session, `thinking: ${level}`, "idle");
    this.publishStatus(session);
    return this.statusFromSession(session);
  }

  async commands(sessionId: string): Promise<ClientCommand[]> {
    const session = await this.getOrOpen(sessionId);
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

  async prompt(sessionId: string, text: string, streamingBehavior?: "steer" | "followUp"): Promise<void> {
    await this.assertWritable(sessionId);
    const session = await this.getOrOpen(sessionId);
    this.maybeGenerateSessionName(session, text);
    const isQueued = session.isStreaming || session.isCompacting;
    const behavior = isQueued ? streamingBehavior ?? "followUp" : undefined;
    if (isQueued && hasQueuedMessageText(session, text)) {
      this.publishActivity(session, "duplicate queued message ignored", "active");
      this.publishStatus(session);
      return;
    }
    this.publishActivity(session, session.isCompacting ? "message queued during compaction" : behavior === "steer" ? "steering queued" : behavior === "followUp" ? "message queued" : "prompt accepted", "active");
    if (!isQueued) this.events.publish(sessionId, { type: "message.append", message: userTextMessage(text) });
    void session.prompt(text, behavior === undefined ? undefined : { streamingBehavior: behavior }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.publishActivity(session, "error", "error", message);
      this.events.publish(sessionId, { type: "session.error", message });
    });
  }

  async shell(sessionId: string, text: string): Promise<void> {
    await this.assertWritable(sessionId);
    const active = await this.getActive(sessionId);
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

  async runCommand(sessionId: string, text: string): Promise<ClientCommandResult> {
    await this.assertWritable(sessionId);
    return this.commandService.run(sessionId, text);
  }

  async respondToCommand(sessionId: string, requestId: string, value: string): Promise<ClientCommandResult> {
    await this.assertWritable(sessionId);
    return this.commandService.respond(sessionId, requestId, value);
  }

  async archive(sessionId: string): Promise<void> {
    const session = await this.getOrOpen(sessionId);
    if (session.isStreaming || session.isCompacting || session.isBashRunning || session.pendingMessageCount > 0) throw new Error("Stop current session activity before archiving");
    const archiveInput = await this.archiveInputForSession(session);
    await this.closeActive(session.sessionId);
    await this.archiveStore.archive(archiveInput);
  }

  async restore(sessionId: string): Promise<void> {
    await this.closeActive(sessionId);
    await this.archiveStore.restore(sessionId);
  }

  async detachParent(sessionId: string): Promise<void> {
    const session = await this.getOrOpen(sessionId);
    const sessionFile = session.sessionFile;
    if (sessionFile === undefined || sessionFile === "") throw new Error("Session is not persisted");
    await clearParentSession(sessionFile);
  }

  async abort(sessionId: string): Promise<void> {
    const active = this.active.get(sessionId);
    if (!active) return;
    clearSessionQueue(active.runtime.session);
    await active.runtime.session.abort();
    this.publishActivity(active.runtime.session, "stopped", "idle");
    this.publishStatus(active.runtime.session);
  }

  stop(sessionId: string): void {
    void this.closeActive(sessionId).catch(() => {
      // Best-effort shutdown; callers that need errors await closeActive directly.
    });
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

  private async archiveInputForSession(session: PiAgentSession): Promise<ArchiveSessionInput> {
    const cwd = session.sessionManager.getCwd();
    const sessionFile = session.sessionFile;
    if (sessionFile === undefined || sessionFile === "") throw new Error("Session is not persisted");
    const listed = (await this.sessionManager.list(cwd)).find((candidate) => candidate.id === session.sessionId);
    if (listed !== undefined) return archiveInputFromListEntry(listed);
    return {
      sessionId: session.sessionId,
      cwd,
      path: sessionFile,
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
      messageCount: session.messages.length,
      firstMessage: "",
      ...(session.sessionName === undefined ? {} : { name: session.sessionName }),
    };
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
    clearSessionQueue(active.runtime.session);
    active.unsubscribe();
    try {
      await active.runtime.session.abort();
    } finally {
      await active.runtime.dispose();
    }
  }

  private async assertWritable(sessionId: string): Promise<void> {
    if (await this.archiveStore.isArchived(sessionId)) throw new Error("Archived sessions are read-only. Restore the session to continue.");
  }

  private async getOrOpen(sessionId: string): Promise<PiAgentSession> {
    return (await this.getActive(sessionId)).runtime.session;
  }

  private async getActive(sessionId: string): Promise<ActiveSession<PiSessionRuntime>> {
    const active = this.active.get(sessionId);
    if (active) return active;

    const archived = await this.archiveStore.get(sessionId);
    if (archived?.archivePath !== undefined) return this.create(this.sessionManager.open(archived.archivePath), archived.cwd);

    const match = (await this.sessionManager.listAll()).find((s) => s.id === sessionId || s.id.startsWith(sessionId));
    if (!match) throw new Error("Session not found");
    return this.create(this.sessionManager.open(match.path), match.cwd);
  }

  private async create(sessionManager: PiSessionManager, cwd: string): Promise<ActiveSession<PiSessionRuntime>> {
    const runtime = await this.createAgentRuntime(this.createRuntime, { cwd, agentDir: this.agentDir, sessionManager });
    const active: ActiveSession<PiSessionRuntime> = { runtime, unsubscribe: noop };
    this.bindRuntime(active);
    runtime.setRebindSession(() => {
      this.bindRuntime(active);
      return Promise.resolve();
    });
    this.active.set(runtime.session.sessionId, active);
    this.publishStatus(runtime.session);
    return active;
  }

  private bindRuntime(active: ActiveSession<PiSessionRuntime>): void {
    active.unsubscribe();
    for (const [sessionId, candidate] of this.active.entries()) {
      if (candidate === active) this.active.delete(sessionId);
    }
    const { session } = active.runtime;
    active.unsubscribe = session.subscribe((event) => {
      this.events.publish(session.sessionId, toClientEvent(event));
      this.publishActivityForEvent(session, event);
      this.publishStatus(session);
    });
    this.active.set(session.sessionId, active);
  }

  private maybeGenerateSessionName(session: PiAgentSession, firstMessage: string): void {
    if (session.sessionName !== undefined || session.messages.length !== 0 || session.isStreaming || session.isCompacting) return;
    const model = session.model;
    if (model === undefined) return;

    void generateShortSessionName(this.modelRegistry, model, firstMessage).then((name) => {
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
      const activity = this.activities.get(session.sessionId);
      const isActive = session.isStreaming || session.isBashRunning || session.isCompacting || session.pendingMessageCount > 0 || activity?.phase === "active";
      if (!isActive) continue;
      this.publishStatus(session);
      if (activity) this.publishActivity(session, activity.label, "active", activity.detail);
      else this.publishActivity(session, this.activityLabelFromStatus(session), "active");
    }
  }

  private activityLabelFromStatus(session: PiAgentSession): string {
    if (session.isCompacting) return "compacting";
    if (session.isBashRunning) return "running bash";
    if (session.isStreaming) return "agent running";
    if (session.pendingMessageCount) return "queued";
    return "active";
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
      return;
    }
    if (eventType === "turn_end") { this.publishActivity(session, "turn complete", "active"); return; }
    if (eventType === "message_start") { this.publishActivity(session, "message started", "active"); return; }
    if (eventType === "message_end") { this.publishActivity(session, "message complete", "idle"); return; }
    if (eventType === "message_update") { this.publishActivity(session, "receiving response", "active"); return; }
    if (eventType === "tool_execution_start") { this.publishActivity(session, "running tool", "active", getString(event, "toolName")); return; }
    if (eventType === "tool_execution_end") {
      const isError = getBoolean(event, "isError") === true;
      this.publishActivity(session, isError ? "tool failed" : "tool complete", isError ? "error" : "active", getString(event, "toolName"));
      return;
    }
    if (eventType === "bash_execution_start") { this.publishActivity(session, "running bash", "active"); return; }
    if (eventType === "bash_execution_end") { this.publishActivity(session, "bash complete", "active"); return; }
    this.publishActivity(session, eventType.replaceAll("_", " "), "active");
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
    this.workspaceActivity?.applySessionStatus(session.sessionManager.getCwd(), status);
    this.events.publish(session.sessionId, { type: "status.update", status });
    this.events.publishGlobal({ type: "status.update", status });
  }

  private statusFromSession(session: PiAgentSession): ClientSessionStatus {
    const stats = session.getSessionStats();
    const model = session.model === undefined ? undefined : modelToClientModel(session.model);
    const contextUsage = session.getContextUsage();
    return {
      sessionId: session.sessionId,
      ...(model === undefined ? {} : { model }),
      thinkingLevel: session.thinkingLevel,
      isStreaming: session.isStreaming,
      isCompacting: session.isCompacting,
      isBashRunning: session.isBashRunning,
      pendingMessageCount: session.pendingMessageCount,
      queuedMessages: queuedMessagesFromSession(session),
      tokens: stats.tokens,
      cost: stats.cost,
      ...(contextUsage === undefined ? {} : { contextUsage }),
    };
  }
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

function clearSessionQueue(session: PiAgentSession): void {
  session.clearQueue();
}

function hasQueuedMessageText(session: PiAgentSession, text: string): boolean {
  return queuedMessagesFromSession(session).some((message) => message.text === text);
}

function queuedMessagesFromSession(session: PiAgentSession): { kind: "steer" | "followUp"; text: string }[] {
  return [
    ...session.getSteeringMessages().map((text) => ({ kind: "steer" as const, text })),
    ...session.getFollowUpMessages().map((text) => ({ kind: "followUp" as const, text })),
  ];
}

function userTextMessage(text: string): { role: "user"; content: string } {
  return { role: "user", content: text };
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
