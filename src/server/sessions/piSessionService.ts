import { statSync } from "node:fs";
import { join } from "node:path";
import { open, readFile, writeFile } from "node:fs/promises";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  createEditToolDefinition,
  defineTool,
  readStoredCredential,
  SessionManager,
  type AgentSessionRuntimeDiagnostic,
  type AgentSessionServices,
  type CreateAgentSessionRuntimeFactory,
  type EditToolDetails,
  type ExtensionUIContext,
  type ModelRuntime,
  type ResourceDiagnostic,
} from "@earendil-works/pi-coding-agent";
import type { ClientArchiveSessionsResponse, ClientCommand, ClientCommandResult, ClientMessagePage, ClientSession, ClientSessionCleanupExecuteResponse, ClientSessionCleanupPreviewResponse, ClientSessionModel, ClientSessionStatus, ClientSessionTreeNavigateRequest, ClientSessionTreeNavigateResult, ClientThinkingLevel, SessionStreamSnapshot, SessionUiEvent } from "../types.js";
import { projectBrowserMessage } from "../browserMessageProjection.js";
import { pageMessagesAtSafeBoundary } from "./messagePaging.js";
import type { SessionEventHub } from "../realtime/sessionEventHub.js";
import { BUILTIN_COMMANDS } from "./builtinCommands.js";
import { SessionCommandService } from "./sessionCommandService.js";
import { projectSessionTree, type ProjectableSessionTreeNode } from "./sessionTreeProjection.js";
import { SessionArchiveStore, type ArchivedSessionRecord, type ArchiveSessionInput } from "./sessionArchiveStore.js";
import { findArchiveCandidateByIdOrPrefix, planSessionArchiveTree, type SessionArchiveTreeCandidate } from "./sessionArchiveTree.js";
import type { ActiveSession } from "./sessionRuntimeStore.js";
import { deterministicSessionName, fallbackSessionName, generateShortSessionName } from "./sessionNameGenerator.js";
import { computeEditPreview, type EditPreviewResult } from "./editPreview.js";
import { attachmentsToInlineImages, saveAttachmentsToWorkspace } from "./attachmentService.js";
import { parsePromptAttachments } from "../../shared/promptAttachments.js";
import { SESSION_TREE_CUSTOM_INSTRUCTIONS_MAX_LENGTH } from "../../shared/apiTypes.js";
import type {
  SavedPromptAttachment,
  SessionBulkArchiveResponse,
  SessionBulkDeleteArchivedResponse,
  SessionBulkFailure,
  SessionBulkMutationRef,
  SessionNotificationCatalogSnapshot,
  SessionNotificationClearReason,
  SessionNotificationDismissAllRequest,
  SessionNotificationDismissRequest,
  SessionNotificationInboxSnapshot,
  SessionWarning,
} from "../../shared/apiTypes.js";
import type { SessionRouteLookup, SessionRouteRef, SessionRouteService } from "./sessionService.js";

import { type AuthChange } from "./authService.js";
import { canonicalizeStoredCwd, cwdPathsEqual } from "../workingDirectory.js";
import type { WorkspaceActivityService } from "../activity/workspaceActivityService.js";
import { createSpawnSessionToolDefinition, type SpawnSessionInvocation, type SpawnSessionResult } from "./spawnSessionTool.js";
import { createSubsessionToolDefinitions, type SpawnSubsessionInvocation, type SpawnSubsessionResult, type SubsessionCheckResult, type SubsessionReadQuery, type SubsessionReadResult, type SubsessionStatus, type SubsessionSummary, type SubsessionToolDeps } from "./spawnSubsessionTool.js";
import { buildTranscriptView } from "./subsessionTranscript.js";
import { planSessionCleanup, summarizeSessionCleanupExecution, type NormalizedSessionCleanupRequest, type SessionCleanupPlan } from "./sessionCleanup.js";
import type { SpawnTargetDecision, SpawnTargetResolver } from "./spawnTargetResolver.js";
import {
  SessionNotificationStore,
  type SessionNotificationGeneration,
  type SessionNotificationMutation,
} from "./sessionNotificationStore.js";
import { plainTextTheme } from "./plainTextTheme.js";

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

interface DeferredSubsessionNotification {
  parentId: string;
  childId: string;
  text: string;
}

interface TreeExclusiveOperationTarget {
  sessionId: string;
  session?: PiAgentSession;
  runtime?: PiSessionRuntime;
}

type PiTreeNavigationOptions =
  | { summarize: false }
  | { summarize: true; customInstructions?: string };

function sessionTreeNavigationOptions(request: ClientSessionTreeNavigateRequest): PiTreeNavigationOptions {
  switch (request.summary.mode) {
    case "none":
      return { summarize: false };
    case "default":
      return { summarize: true };
    case "custom": {
      const customInstructions = request.summary.instructions.trim();
      if (customInstructions === "") throw new Error("Custom branch-summary instructions are required");
      if (customInstructions.length > SESSION_TREE_CUSTOM_INSTRUCTIONS_MAX_LENGTH) {
        throw new Error(`Custom branch-summary instructions must be at most ${String(SESSION_TREE_CUSTOM_INSTRUCTIONS_MAX_LENGTH)} characters`);
      }
      return { summarize: true, customInstructions };
    }
  }
}

function decrementWeakCount<Key extends object>(counts: WeakMap<Key, number>, key: Key): void {
  const remaining = (counts.get(key) ?? 1) - 1;
  if (remaining <= 0) counts.delete(key);
  else counts.set(key, remaining);
}

function decrementMapCount<Key>(counts: Map<Key, number>, key: Key): void {
  const remaining = (counts.get(key) ?? 1) - 1;
  if (remaining <= 0) counts.delete(key);
  else counts.set(key, remaining);
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

type SessionCreationProvenance = "tracked-subsession";

interface StartSessionOptions {
  parentSession?: string;
  initialModel?: AgentModel;
}

interface InternalStartSessionOptions extends StartSessionOptions {
  creationProvenance?: SessionCreationProvenance;
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

export type PiSessionRef = SessionRouteRef;
type PiSessionLookup = SessionRouteLookup;

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

export interface PiSessionManager {
  getCwd(): string;
  getSessionId(): string;
  getSessionFile(): string | undefined;
  getBranch(): unknown[];
  getEntries?(): readonly unknown[];
  getTree?(): readonly ProjectableSessionTreeNode[];
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
  uiContext?: ExtensionUIContext;
  mode?: "rpc";
  onError?: (error: PiExtensionError) => void;
}

export interface PiAgentSession {
  modelRuntime: ModelRuntime;
  /**
   * Narrow read/write of the SDK `SettingsManager`, exposing only the warning
   * suppression flags consumed here (e.g. `anthropicExtraUsage`). Used to gate
   * the Anthropic subscription-auth billing warning the same way the TUI does,
   * and to durably suppress it when the user dismisses the warning.
   */
  settingsManager: {
    getWarnings(): { anthropicExtraUsage?: boolean };
    setWarnings(warnings: { anthropicExtraUsage?: boolean }): void;
  };
  sessionManager: PiSessionManager;
  scopedModels: readonly { model: AgentModel; thinkingLevel?: ClientThinkingLevel }[];
  sessionId: string;
  sessionFile: string | undefined;
  sessionName: string | undefined;
  messages: readonly unknown[];
  /**
   * Narrow read of the SDK `AgentState`. Only the in-flight partial is consumed
   * here: `state.streamingMessage` is the current streamed assistant message
   * (an `AssistantMessage`) while a turn is mid-stream, and `undefined`
   * otherwise (idle, or during post-message tool execution). Used by
   * {@link PiSessionService.streamSnapshot} to seed a joining client.
   */
  readonly state: { readonly streamingMessage?: unknown };
  model: AgentModel | undefined;
  thinkingLevel: ClientThinkingLevel;
  isStreaming: boolean;
  isCompacting: boolean;
  isBashRunning: boolean;
  pendingMessageCount: number;
  extensionRunner: {
    getRegisteredCommands(): readonly { invocationName: string; description?: string }[];
    getUIContext(): ExtensionUIContext;
    setUIContext(uiContext?: ExtensionUIContext, mode?: "rpc"): void;
  };
  promptTemplates: readonly { name: string; description?: string }[];
  resourceLoader: { getSkills(): { skills: readonly { name: string; description?: string }[] } };
  subscribe(listener: (event: unknown) => void): () => void;
  bindExtensions(bindings: PiExtensionBindings): Promise<void>;
  compact(instructions?: string): Promise<{ summary: string; tokensBefore: number }>;
  getUserMessagesForForking(): readonly { entryId: string; text: string }[];
  getSessionStats(): { sessionId: string; totalMessages: number; userMessages: number; assistantMessages: number; toolCalls: number; tokens: ClientSessionStatus["tokens"]; cost: number };
  reload(options?: { beforeSessionStart?: () => void | Promise<void> }): Promise<void>;
  getContextUsage(): ClientSessionStatus["contextUsage"] | undefined;
  prompt(text: string, options?: { streamingBehavior?: "steer" | "followUp"; images?: ImageContent[] }): Promise<void>;
  sendCustomMessage(message: { customType: string; content: string; display: boolean; details?: unknown }, options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }): Promise<void>;
  executeBash(command: string, onChunk?: (chunk: string) => void, options?: { excludeFromContext?: boolean }): Promise<{ output: string; exitCode: number | undefined; cancelled: boolean; truncated: boolean; fullOutputPath?: string }>;
  navigateTree?(targetId: string, options?: { summarize?: boolean; customInstructions?: string }): Promise<{ editorText?: string; cancelled: boolean; aborted?: boolean; summaryEntry?: unknown }>;
  abortBranchSummary?(): void;
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
  /**
   * Live, runtime-scoped diagnostics/services used to compute session warnings.
   *
   * These mirror the SDK runtime and are recomputed whenever the runtime is
   * (re)built. `undefined` on lightweight/test runtimes that do not carry SDK
   * services; callers must treat missing sources as "no warnings".
   */
  readonly diagnostics?: readonly AgentSessionRuntimeDiagnostic[];
  readonly services?: AgentSessionServices;
  setRebindSession(rebindSession?: (session: PiAgentSession) => Promise<void>): void;
  fork(entryId: string, options?: { position?: "before" | "at" }): Promise<{ cancelled: boolean; selectedText?: string }>;
  dispose(): Promise<void>;
}

interface PendingSessionOpen {
  sessionId: string;
  promise: Promise<ActiveSession<PiSessionRuntime>>;
}

interface CreateSessionRuntimeOptions extends Pick<InternalStartSessionOptions, "initialModel" | "creationProvenance"> {
  notificationGeneration?: SessionNotificationGeneration;
  notifications?: "enabled" | "disabled";
}

type NotificationClosePolicy =
  | { kind: "clear"; reason: SessionNotificationClearReason }
  | { kind: "defer" };

const CLEAR_RUNTIME_NOTIFICATIONS: NotificationClosePolicy = { kind: "clear", reason: "runtime-close" };
const DEFER_RUNTIME_NOTIFICATIONS: NotificationClosePolicy = { kind: "defer" };

function resourceDiagnosticToWarning(diagnostic: ResourceDiagnostic, source: string): SessionWarning {
  return {
    severity: diagnostic.type === "error" ? "error" : "warning",
    message: diagnostic.message,
    source,
    ...(diagnostic.path === undefined ? {} : { path: diagnostic.path }),
  };
}

function runtimeDiagnosticToWarning(diagnostic: AgentSessionRuntimeDiagnostic): SessionWarning {
  return { severity: diagnostic.type, message: diagnostic.message, source: "runtime" };
}

/**
 * Minimal structural view of a runtime's warning sources: the runtime setup
 * diagnostics plus the resource loader's per-collection diagnostics and
 * extension load errors. Narrowed to just what {@link collectRuntimeWarnings}
 * reads so the real SDK runtime and lightweight test doubles both satisfy it.
 */
export interface RuntimeWarningSources {
  readonly diagnostics?: readonly AgentSessionRuntimeDiagnostic[];
  readonly services?: {
    resourceLoader: {
      getSkills(): { diagnostics: readonly ResourceDiagnostic[] };
      getPrompts(): { diagnostics: readonly ResourceDiagnostic[] };
      getThemes(): { diagnostics: readonly ResourceDiagnostic[] };
      getExtensions(): { errors: readonly { path: string; error: string }[] };
    };
  };
}

/**
 * Compute the live warnings for a runtime by re-reading its current resource
 * loader diagnostics, extension load errors, and runtime setup diagnostics.
 *
 * This mimics the TUI recomputing warnings on every (re)bind: it reads the
 * runtime's current state rather than a cached snapshot, so a rebuilt runtime
 * yields fresh warnings. Runtimes without SDK services (e.g. test fakes)
 * contribute no warnings.
 */
export function collectRuntimeWarnings(runtime: RuntimeWarningSources): SessionWarning[] {
  const warnings: SessionWarning[] = [];
  for (const diagnostic of runtime.diagnostics ?? []) warnings.push(runtimeDiagnosticToWarning(diagnostic));
  const resourceLoader = runtime.services?.resourceLoader;
  if (resourceLoader !== undefined) {
    for (const diagnostic of resourceLoader.getSkills().diagnostics) warnings.push(resourceDiagnosticToWarning(diagnostic, "skill"));
    for (const diagnostic of resourceLoader.getPrompts().diagnostics) warnings.push(resourceDiagnosticToWarning(diagnostic, "prompt"));
    for (const diagnostic of resourceLoader.getThemes().diagnostics) warnings.push(resourceDiagnosticToWarning(diagnostic, "theme"));
    for (const error of resourceLoader.getExtensions().errors) {
      warnings.push({ severity: "error", message: `${error.path}: ${error.error}`, source: "extension", path: error.path });
    }
  }
  return warnings;
}

/**
 * Verbatim TUI wording for the Anthropic subscription-auth billing notice. Kept
 * character-for-character in sync with `ANTHROPIC_SUBSCRIPTION_AUTH_WARNING` in
 * the SDK's interactive mode so the browser shows the same message the TUI does.
 */
const ANTHROPIC_SUBSCRIPTION_AUTH_WARNING =
  "Anthropic subscription auth is active. Third-party harness usage draws from extra usage and is billed per token, not your Claude plan limits. Manage extra usage at https://claude.ai/settings/usage.";

/** Mirror of the SDK TUI `isAnthropicSubscriptionAuthKey` (subscription API keys start with `sk-ant-oat`). */
function isAnthropicSubscriptionAuthKey(apiKey: string | undefined): boolean {
  return typeof apiKey === "string" && apiKey.startsWith("sk-ant-oat");
}

/**
 * Dismiss id for the Anthropic subscription-auth billing notice. This is `pi`'s
 * own `WarningSettings` key verbatim (`anthropicExtraUsage`): we carry the
 * coupling `pi` already defines rather than inventing a parallel vocabulary, and
 * {@link dismissSessionWarning} maps it back to `setWarnings`.
 */
const ANTHROPIC_EXTRA_USAGE_DISMISS_ID = "anthropicExtraUsage";

/**
 * Port of the TUI `maybeWarnAboutAnthropicSubscriptionAuth` gate/trigger, computed
 * live from the session's current model, stored Anthropic credential, and warning
 * settings. Returns the billing warning when the active provider is `anthropic`
 * and auth is a subscription credential (stored `oauth`, or an `sk-ant-oat` API
 * key), unless suppressed via `getWarnings().anthropicExtraUsage === false`.
 *
 * The stored credential is read synchronously (matching the TUI's `oauth` branch
 * and the documented `sk-ant-oat` key trigger) so warnings stay part of the
 * synchronous live status computation.
 */
export function anthropicSubscriptionWarning(
  session: Pick<PiAgentSession, "model" | "settingsManager">,
  authPath?: string,
): SessionWarning | undefined {
  if (session.settingsManager.getWarnings().anthropicExtraUsage === false) return undefined;
  if (session.model?.provider !== "anthropic") return undefined;
  const credential = readStoredCredential("anthropic", authPath);
  if (credential === undefined) return undefined;
  const isSubscriptionAuth = credential.type === "oauth"
    ? true
    : isAnthropicSubscriptionAuthKey(credential.key);
  if (!isSubscriptionAuth) return undefined;
  return {
    severity: "warning",
    message: ANTHROPIC_SUBSCRIPTION_AUTH_WARNING,
    source: "anthropic",
    dismiss: { id: ANTHROPIC_EXTRA_USAGE_DISMISS_ID },
  };
}

/**
 * Durably suppress a dismissable session warning by mapping its opaque dismiss
 * id back to the concrete `pi` suppression it represents. Only known ids are
 * honored; unknown ids throw so a stale/forged client cannot silently no-op.
 *
 * This is the single place provider-specific suppression lives: the wire type,
 * parser, and UI stay agnostic. Adding a future dismissable warning is a
 * server-only change here plus a `dismiss` id on its producer.
 */
export function dismissSessionWarning(
  session: Pick<PiAgentSession, "settingsManager">,
  dismissId: string,
): void {
  if (dismissId !== ANTHROPIC_EXTRA_USAGE_DISMISS_ID) {
    throw new Error(`Unknown session warning dismiss id: ${dismissId}`);
  }
  session.settingsManager.setWarnings({ ...session.settingsManager.getWarnings(), anthropicExtraUsage: false });
}

interface CreateAgentRuntimeOptions {
  cwd: string;
  agentDir: string;
  sessionManager: PiSessionManager;
  delegationToolsEnabled: boolean;
  initialModel?: AgentModel;
}

type PiWebRuntimeFactoryOptions = Parameters<CreateAgentSessionRuntimeFactory>[0] & {
  delegationToolsEnabled?: boolean;
  initialModel?: AgentModel;
};

type PiWebCreateAgentSessionRuntimeFactory = (
  options: PiWebRuntimeFactoryOptions
) => ReturnType<CreateAgentSessionRuntimeFactory>;

type CreateAgentRuntime = (createRuntime: PiWebCreateAgentSessionRuntimeFactory, options: CreateAgentRuntimeOptions) => Promise<PiSessionRuntime>;

function defaultCreateAgentRuntime(createRuntime: PiWebCreateAgentSessionRuntimeFactory, options: CreateAgentRuntimeOptions): Promise<PiSessionRuntime> {
  if (!(options.sessionManager instanceof SessionManager)) throw new Error("Default runtime creation requires an SDK SessionManager");
  const runtimeFactory = createRuntimeWithOneShotSessionOptions(createRuntime, options.initialModel, options.delegationToolsEnabled);
  return createAgentSessionRuntime(runtimeFactory, {
    cwd: options.cwd,
    agentDir: options.agentDir,
    sessionManager: options.sessionManager,
  });
}

function createRuntimeWithOneShotSessionOptions(
  createRuntime: PiWebCreateAgentSessionRuntimeFactory,
  initialModel: AgentModel | undefined,
  delegationToolsEnabled: boolean,
): CreateAgentSessionRuntimeFactory {
  // These inputs belong only to the session being opened. A later runtime
  // replacement resolves its own model and delegation capability.
  let pendingInitialModel = initialModel;
  let pendingDelegationToolsEnabled: boolean | undefined = delegationToolsEnabled;
  return async (options) => {
    const model = pendingInitialModel;
    const toolsEnabled = pendingDelegationToolsEnabled;
    pendingInitialModel = undefined;
    pendingDelegationToolsEnabled = undefined;
    return createRuntime({
      ...options,
      ...(model === undefined ? {} : { initialModel: model }),
      ...(toolsEnabled === undefined ? {} : { delegationToolsEnabled: toolsEnabled }),
    });
  };
}

type SpawnSessionFn = (input: SpawnSessionInvocation) => Promise<SpawnSessionResult>;

export function createPiWebCustomToolDefinitions(
  cwd: string,
  delegationEnabled: boolean,
  spawn?: SpawnSessionFn,
  subsessions?: SubsessionToolDeps,
) {
  return [
    createPiWebEditToolDefinition(cwd),
    ...(delegationEnabled && spawn !== undefined ? [createSpawnSessionToolDefinition(cwd, { spawn })] : []),
    ...(delegationEnabled && subsessions !== undefined ? createSubsessionToolDefinitions(cwd, subsessions) : []),
  ];
}

function createDefaultRuntimeFactory(
  modelRuntime: ModelRuntime,
  sessionManagers: Pick<PiSessionManagerGateway, "open">,
  spawn?: SpawnSessionFn,
  subsessions?: SubsessionToolDeps,
): PiWebCreateAgentSessionRuntimeFactory {
  return async ({ cwd, agentDir, sessionManager, sessionStartEvent, initialModel, delegationToolsEnabled }) => {
    const services = await createAgentSessionServices({ cwd, agentDir, modelRuntime });
    const resolvedDelegationToolsEnabled = delegationToolsEnabled
      ?? await sessionAllowsDelegationTools(sessionManager, sessionManagers);
    const customTools = createPiWebCustomToolDefinitions(cwd, resolvedDelegationToolsEnabled, spawn, subsessions);
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
  agentDir: string;
  sessionManager: PiSessionManagerGateway;
  archiveStore?: SessionArchiveRepository;
  createRuntime?: PiWebCreateAgentSessionRuntimeFactory;
  createAgentRuntime?: CreateAgentRuntime;
  modelRuntime: ModelRuntime;
  heartbeatIntervalMs?: number;
  workspaceActivity?: Pick<WorkspaceActivityService, "applySessionStatus" | "applySessionActivity" | "removeSession" | "reconcileSessionActivity">;
  /**
   * When provided, `spawn_session` is available to sessions whose creation
   * provenance permits delegation, scoped to the project's workspaces.
   * Omit to keep the capability disabled.
   */
  spawnTargets?: SpawnTargetResolver;
  /**
   * Beta: when true (and `spawnTargets` is provided), the tracked-subsession
   * tools are available to sessions whose creation provenance permits
   * delegation. Off by default so the capability can ship in main without
   * being exposed in releases.
   */
  subsessionsEnabled?: boolean;
  /** Structured logger for notable runtime events (e.g. spawns). */
  logger?: PiSessionLogger;
  /** Clock seam for cleanup planning tests. */
  now?: () => Date;
  /** Daemon-lifetime notification state, injected by sessiond in production. */
  notificationStore?: SessionNotificationStore;
}

export class PiSessionService implements SessionRouteService {
  private readonly active = new Map<string, ActiveSession<PiSessionRuntime>>();
  private readonly pendingSessionOpens = new Map<string, PendingSessionOpen>();
  private readonly activities = new Map<string, { phase: "active" | "idle" | "error"; label: string; detail?: string; at: string }>();
  private readonly heartbeat: NodeJS.Timeout;
  private readonly commandService: SessionCommandService<PiAgentSession>;
  /** Runtime-identity gate held while Pi may await abandoned-branch summarization. */
  private readonly treeNavigations = new WeakSet<PiAgentSession>();
  /** Counts async operations that may append an entry before they settle. */
  private readonly sessionEntryMutationCounts = new WeakMap<PiAgentSession, number>();
  /** Runtime/session-identity reservations for operations that must not overlap tree navigation. */
  private readonly treeExclusiveRuntimeOperationCounts = new WeakMap<PiSessionRuntime, number>();
  private readonly treeExclusiveSessionOperationCounts = new Map<string, number>();
  private readonly deferredSubsessionNotifications = new WeakMap<PiAgentSession, DeferredSubsessionNotification[]>();
  private readonly deferredGeneratedSessionNames = new WeakMap<PiAgentSession, string>();
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
  private readonly modelRuntime: ModelRuntime;
  private readonly workspaceActivity: Pick<WorkspaceActivityService, "applySessionStatus" | "applySessionActivity" | "removeSession" | "reconcileSessionActivity"> | undefined;
  private readonly spawnTargets: SpawnTargetResolver | undefined;
  private readonly logger: PiSessionLogger;
  private readonly now: () => Date;
  private readonly notificationStore: SessionNotificationStore;
  private readonly notificationGenerationBySession = new WeakMap<PiAgentSession, SessionNotificationGeneration>();

  constructor(private readonly events: SessionEventHub, deps: PiSessionServiceDependencies) {
    this.archiveStore = deps.archiveStore ?? new SessionArchiveStore();
    this.agentDir = deps.agentDir;
    this.sessionManager = deps.sessionManager;
    this.modelRuntime = deps.modelRuntime;
    this.spawnTargets = deps.spawnTargets;
    this.logger = deps.logger ?? noopLogger;
    this.now = deps.now ?? (() => new Date());
    this.notificationStore = deps.notificationStore ?? new SessionNotificationStore();
    // Subsessions are a beta capability gated behind their own flag, and they
    // also require the spawn capability (they share its project-scope resolver).
    const subsessionsActive = this.spawnTargets !== undefined && deps.subsessionsEnabled === true;
    this.createRuntime = deps.createRuntime ?? createDefaultRuntimeFactory(
      this.modelRuntime,
      this.sessionManager,
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
          this.beginSessionEntryMutation(session, "compact the session");
          this.publishActivity(session, "compacting", "active");
          this.publishStatus(session);
        },
        onCompactionEnd: (session, result, detail) => {
          this.endSessionEntryMutation(session);
          this.publishActivity(session, result === "success" ? "compaction complete" : "compaction failed", result === "success" ? "idle" : "error", detail);
          this.publishStatus(session);
        },
        reloadSession: (session) => this.reloadSessionRuntime(session),
        getSessionTree: (session) => {
          if (typeof session.sessionManager.getTree !== "function" || typeof session.navigateTree !== "function") return undefined;
          return projectSessionTree(session.sessionManager.getTree(), session.sessionManager.getLeafId());
        },
        hasActiveWork: (session) => this.hasActiveWork(session),
        isTreeNavigationActive: (session) => this.treeNavigations.has(session),
        runSessionReplacement: (session, operation) => this.runTreeExclusiveOperation(
          [{ sessionId: session.sessionId, session }],
          "Stop current session activity before replacing the session",
          operation,
        ),
      },
      { listSessionNames: (cwd) => this.listSessionNames(cwd) },
    );
  }

  activeCount(): number {
    return this.active.size;
  }

  notificationCatalog(): SessionNotificationCatalogSnapshot {
    return this.notificationStore.catalogSnapshot();
  }

  notificationInbox(ref: PiSessionRef): SessionNotificationInboxSnapshot {
    return this.notificationStore.inboxSnapshot(ref.id, canonicalizeStoredCwd(ref.cwd));
  }

  dismissNotification(
    ref: PiSessionRef,
    request: Omit<SessionNotificationDismissRequest, "cwd">,
  ): SessionNotificationInboxSnapshot {
    const result = this.notificationStore.dismissNotification(
      ref.id,
      canonicalizeStoredCwd(ref.cwd),
      request.daemonInstanceId,
      request.notificationId,
    );
    this.publishNotificationMutations(result.mutations);
    return result.snapshot;
  }

  dismissAllNotifications(
    ref: PiSessionRef,
    request: Omit<SessionNotificationDismissAllRequest, "cwd">,
  ): SessionNotificationInboxSnapshot {
    const result = this.notificationStore.dismissAll(
      ref.id,
      canonicalizeStoredCwd(ref.cwd),
      request.daemonInstanceId,
      request.throughOrder,
      request.throughOverflowWatermark,
    );
    this.publishNotificationMutations(result.mutations);
    return result.snapshot;
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
      await this.closeActive(input.sessionId, { kind: "clear", reason: "archive" });
      readyArchiveInputs.push(input);
    }
    await this.archiveStoreArchiveMany(readyArchiveInputs);
    archiveInputs.push(...readyArchiveInputs);

    for (const record of plan.deleteRecords) {
      if (this.activeSessionHasWork(record.sessionId)) {
        skippedBusySessionIds.add(record.sessionId);
        continue;
      }
      await this.closeActive(record.sessionId, { kind: "clear", reason: "delete" });
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
    const pendingOpens = this.pendingSessionOpenPromises();
    if (pendingOpens.length > 0) await Promise.allSettled(pendingOpens);
    const activeSessions = Array.from(new Set(this.active.values()));
    this.active.clear();
    this.pendingSessionOpens.clear();
    this.activities.clear();
    this.compactionPromptQueues.clear();
    this.authLossWarnings.clear();
    this.subsessionParents.clear();
    this.subsessionChildren.clear();
    this.subsessionLinks.clear();
    this.subsessionHydratedParents.clear();
    this.subsessionNotifyArmed.clear();
    this.notificationStore.clearAll("service-dispose");
    await Promise.all(activeSessions.map(async (active) => {
      active.unsubscribe();
      active.runtime.setRebindSession(undefined);
      this.workspaceActivity?.removeSession(active.runtime.session.sessionId, active.runtime.session.sessionManager.getCwd());
      try {
        await this.abortSessionOperations(active.runtime.session);
      } finally {
        await active.runtime.dispose();
      }
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
    for (const record of archivedForCwd) {
      this.publishNotificationMutations(this.notificationStore.clearSession(record.sessionId, "archive-reconcile"));
    }
    const unarchivedSessions = sessions.filter((session) => !archivedById.has(session.id)).map(clientSessionFromListEntry);
    this.workspaceActivity?.reconcileSessionActivity(cwd, this.reconcilableSessionIds(cwd, unarchivedSessions.map((session) => session.id), archivedById));
    const archivedSessions = archivedForCwd
      .sort(compareArchivedRecords)
      .map((record) => clientSessionFromArchivedRecord(record, sessionsById.get(record.sessionId)))
      .filter(isDefined);
    return [...unarchivedSessions, ...archivedSessions];
  }

  async start(cwd: string, options: StartSessionOptions = {}): Promise<ClientSession> {
    return this.startSession(cwd, options);
  }

  private async startSession(cwd: string, options: InternalStartSessionOptions): Promise<ClientSession> {
    const active = await this.create(
      this.sessionManager.create(cwd, options.parentSession === undefined ? undefined : { parentSession: options.parentSession }),
      cwd,
      {
        ...(options.initialModel === undefined ? {} : { initialModel: options.initialModel }),
        ...(options.creationProvenance === undefined ? {} : { creationProvenance: options.creationProvenance }),
      },
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
    const created = await this.startSession(decision.cwd, {
      ...(input.parentSessionFile === undefined ? {} : { parentSession: input.parentSessionFile }),
      ...(input.model === undefined ? {} : { initialModel: input.model }),
      creationProvenance: "tracked-subsession",
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

  private verifiedSubsessionLinkFromOpenedChild(session: PiAgentSession): Promise<TrackedSubsessionLink | undefined> {
    return verifiedTrackedSubsessionLink(this.sessionManager, {
      sessionId: session.sessionId,
      sessionFile: session.sessionFile,
      sessionManager: session.sessionManager,
      cwd: session.sessionManager.getCwd(),
    });
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

  private workingSubsessionIds(parentSessionId: string): string[] {
    const childIds = this.subsessionChildren.get(parentSessionId);
    if (childIds === undefined) return [];
    return [...childIds].filter((childId) => {
      const link = this.subsessionLinks.get(childId);
      const active = link === undefined ? undefined : this.activeChildForSubsessionLink(link);
      return active !== undefined && this.hasActiveWork(active.runtime.session);
    });
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
    const outputSection = formatSubsessionNotificationOutput(childId, finalText);
    const workingIds = this.workingSubsessionIds(link.parentSessionId);
    const next = workingIds.length === 0
      ? "No other tracked subsessions are working."
      : `Still working: ${workingIds.join(", ")}. Continue working, or call yield_to_subsessions alone and last at the next join point. Further completion notices arrive automatically; do not poll.`;
    const text = `Subsession ${childId} stopped working (${status}).\n${next}\n\n${outputSection}`;
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
      if (this.treeNavigations.has(session)) {
        const pending = this.deferredSubsessionNotifications.get(session) ?? [];
        pending.push({ parentId, childId, text });
        this.deferredSubsessionNotifications.set(session, pending);
        return;
      }
      await this.deliverSubsessionNotification(session, { parentId, childId, text });
    } catch (error: unknown) {
      this.logSubsessionNotificationFailure(parentId, childId, error);
    }
  }

  private async deliverSubsessionNotification(session: PiAgentSession, notification: DeferredSubsessionNotification): Promise<void> {
    await this.runSessionEntryMutation(session, "deliver a subsession notification", () => session.sendCustomMessage(
      { customType: SUBSESSION_NOTIFICATION_CUSTOM_TYPE, content: notification.text, display: true, details: { sessionId: notification.childId } },
      { triggerTurn: true, deliverAs: "followUp" },
    ));
    this.publishStatus(session);
  }

  private logSubsessionNotificationFailure(parentId: string, childId: string, error: unknown): void {
    this.logger.info(
      { parentSessionId: parentId, sessionId: childId, error: error instanceof Error ? error.message : String(error) },
      "failed to notify parent of subsession completion",
    );
  }

  async messages(ref: PiSessionLookup, page?: { before?: number; limit?: number }): Promise<unknown[] | ClientMessagePage> {
    const session = await this.getOrOpen(ref);
    return pageMessagesAtSafeBoundary(historyMessages(session), page);
  }

  async status(ref: PiSessionLookup): Promise<ClientSessionStatus> {
    return this.statusFromSession(await this.getOrOpen(ref));
  }

  /**
   * Join-time snapshot of the in-flight assistant stream. The `seq` watermark and
   * the partial are read together in one synchronous tick (no await between the
   * `currentSeq` read and the `state.streamingMessage` read) so a joining client
   * can seed the partial and then apply only buffered live events with
   * `seq > snapshot.seq`. The partial is browser-projected to strip thinking
   * signatures; it is `null` when no assistant message is mid-stream.
   */
  async streamSnapshot(ref: PiSessionLookup): Promise<SessionStreamSnapshot> {
    const session = await this.getOrOpen(ref);
    // Single consistent tick: capture the watermark and the partial together so
    // the seq matches the partial the client seeds against.
    const seq = this.events.currentSeq(session.sessionId);
    const streamingMessage = session.state.streamingMessage;
    const partial = streamingMessage === undefined || streamingMessage === null
      ? null
      : projectBrowserMessage(streamingMessage);
    return { seq, partial };
  }

  async availableModels(ref: PiSessionLookup): Promise<ClientSessionModel[]> {
    const session = await this.getOrOpen(ref);
    await session.modelRuntime.reloadConfig();
    const models = session.scopedModels.length > 0
      ? session.scopedModels.map((scoped) => scoped.model)
      : session.modelRuntime.getAvailableSnapshot();
    return models.map(modelToClientModel);
  }

  async setModel(ref: PiSessionLookup, provider: string, modelId: string): Promise<ClientSessionStatus> {
    await this.assertWritable(ref);
    const session = await this.getOrOpen(ref);
    this.assertTreeNavigationInactive(session, "change models");
    await session.modelRuntime.reloadConfig();
    this.assertTreeNavigationInactive(session, "change models");
    const candidates = session.scopedModels.length > 0
      ? session.scopedModels.map((scoped) => scoped.model)
      : session.modelRuntime.getAvailableSnapshot();
    const model = candidates.find((candidate) => candidate.provider === provider && candidate.id === modelId)
      ?? session.modelRuntime.getModel(provider, modelId);
    if (model === undefined) throw new Error(`Model not found: ${provider}/${modelId}`);
    await this.runSessionEntryMutation(session, "change models", () => session.setModel(model));
    this.publishActivity(session, `model: ${model.id}`, "idle", model.provider);
    this.publishStatus(session);
    return this.statusFromSession(session);
  }

  async cycleModel(ref: PiSessionLookup, direction: "forward" | "backward"): Promise<ClientSessionStatus> {
    await this.assertWritable(ref);
    const session = await this.getOrOpen(ref);
    const result = await this.runSessionEntryMutation(session, "change models", () => session.cycleModel(direction));
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
    this.assertTreeNavigationInactive(session, "change the thinking level");
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
    this.assertTreeNavigationInactive(session, "change the thinking level");
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
    this.assertTreeNavigationInactive(session, "send a prompt");
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
    const promptPromise = this.runSessionEntryMutation(session, "send a prompt", () => session.prompt(text, promptOptions)).catch((error: unknown) => {
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
    this.assertTreeNavigationInactive(session, "run a shell command");
    const isExcluded = text.startsWith("!!");
    const command = (isExcluded ? text.slice(2) : text.slice(1)).trim();
    if (!command) throw new Error("Usage: !<shell command>");
    if (session.isBashRunning) throw new Error("A bash command is already running");

    this.publishActivity(session, "running bash", "active", command);
    this.events.publish(session.sessionId, { type: "shell.start", command, excludeFromContext: isExcluded });
    void this.runSessionEntryMutation(session, "run a shell command", () => session.executeBash(command, (chunk) => {
      this.events.publish(session.sessionId, { type: "shell.chunk", chunk });
      this.publishActivity(session, "running bash", "active", command);
      this.publishStatus(session);
    }, { excludeFromContext: isExcluded })).then((result) => {
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

  async navigateTree(ref: PiSessionLookup, request: ClientSessionTreeNavigateRequest): Promise<ClientSessionTreeNavigateResult> {
    if (request.targetId.trim() === "") throw new Error("Session tree target is required");
    if (this.isTreeExclusiveSessionIdentityActive(sessionIdFromLookup(ref))) {
      throw new Error("Stop current session activity before navigating the session tree");
    }
    await this.assertWritable(ref);
    const options = sessionTreeNavigationOptions(request);
    const session = await this.getOrOpen(ref);
    if (typeof session.navigateTree !== "function") throw new Error("Session tree navigation is not supported by this Pi runtime");
    if (this.hasActiveWork(session)) throw new Error("Stop current session activity before navigating the session tree");

    // Acquire synchronously after the active-work check. No leaf-producing work
    // may enter this runtime until Pi's potentially asynchronous summary settles.
    this.treeNavigations.add(session);
    try {
      if (session.sessionManager.getLeafId() !== request.expectedLeafId) {
        throw new Error("The session changed since /tree was opened. Reopen /tree and try again.");
      }

      this.publishActivity(session, options.summarize ? "summarizing branch" : "navigating session tree", "active");
      this.publishStatus(session);
      const result = await session.navigateTree(request.targetId, options);
      if (result.cancelled) {
        if (this.isCurrentActiveSession(session)) {
          this.publishActivity(session, result.aborted === true ? "branch summary aborted" : "tree navigation cancelled", "idle");
        }
        return { cancelled: true, ...(result.aborted === undefined ? {} : { aborted: result.aborted }) };
      }

      if (this.isCurrentActiveSession(session)) this.publishActivity(session, "session tree navigated", "idle");
      return { cancelled: false, ...(result.editorText === undefined ? {} : { editorText: result.editorText }) };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.isCurrentActiveSession(session)) {
        this.publishActivity(session, "tree navigation failed", "error", message);
        this.events.publish(session.sessionId, { type: "session.error", message });
      }
      throw error;
    } finally {
      this.treeNavigations.delete(session);
      if (this.isCurrentActiveSession(session)) {
        this.flushDeferredTreeNavigationWork(session);
        this.publishStatus(session);
      } else {
        this.deferredGeneratedSessionNames.delete(session);
        this.deferredSubsessionNotifications.delete(session);
      }
    }
  }

  private async reloadSessionRuntime(session: PiAgentSession): Promise<void> {
    if (this.hasActiveWork(session)) throw new Error("Stop current session activity before reloading");
    await this.runTreeExclusiveOperation(
      [{ sessionId: session.sessionId, session }],
      "Stop current session activity before reloading",
      async () => {
        this.publishActivity(session, "reloading resources", "active");
        const priorGeneration = this.notificationGenerationBySession.get(session);
        let candidateGeneration: SessionNotificationGeneration | undefined;
        try {
          await session.reload(priorGeneration === undefined ? undefined : {
            beforeSessionStart: () => {
              candidateGeneration = this.notificationStore.beginReplacement(priorGeneration, notificationIdentityForSession(session));
              this.notificationGenerationBySession.set(session, candidateGeneration);
              this.replaceSessionNotificationContext(session, candidateGeneration);
            },
          });
          if (candidateGeneration !== undefined) {
            this.publishNotificationMutations(this.notificationStore.commitReplacement(candidateGeneration));
          }
          this.publishActivity(session, "resources reloaded", "idle");
          this.publishStatus(session);
        } catch (error: unknown) {
          if (candidateGeneration !== undefined) {
            this.publishNotificationMutations(this.notificationStore.abortReplacement(candidateGeneration, "candidate"));
            this.notificationGenerationBySession.set(session, candidateGeneration);
          }
          const message = error instanceof Error ? error.message : String(error);
          this.publishActivity(session, "reload failed", "error", message);
          this.events.publish(session.sessionId, { type: "session.error", message });
          this.publishStatus(session);
          throw error;
        }
      },
    );
  }

  async archive(ref: PiSessionLookup): Promise<void> {
    const session = await this.getOrOpen(ref);
    if (this.hasActiveWork(session)) throw new Error("Stop current session activity before archiving");
    await this.runTreeExclusiveOperation(
      [{ sessionId: session.sessionId, session }],
      "Stop current session activity before archiving",
      async () => {
        const archiveInput = await this.archiveInputForSession(session);
        await this.closeActive(session.sessionId, { kind: "clear", reason: "archive" });
        await this.archiveStore.archive(archiveInput);
      },
    );
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
        this.publishNotificationMutations(this.notificationStore.clearSession(archived.sessionId, "archive"));
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

    const readyPlanItems: { input: ArchiveSessionInput; active?: ActiveSession<PiSessionRuntime> }[] = [];
    for (const item of planItems) {
      const active = this.activeForLookup({ id: item.input.sessionId, cwd: item.input.cwd });
      if (active !== undefined && this.hasActiveWork(active.runtime.session)) {
        failures.push({ sessionId: item.input.sessionId, error: "Stop current session activity before archiving" });
        continue;
      }
      readyPlanItems.push(active === undefined ? item : { ...item, active });
    }

    const readyInputs: ArchiveSessionInput[] = [];
    const archivedSessionIds = [...alreadyArchivedSessionIds];
    await this.runTreeExclusiveOperation(
      readyPlanItems.map(({ input, active }) => ({
        sessionId: input.sessionId,
        ...(active === undefined ? {} : { session: active.runtime.session, runtime: active.runtime }),
      })),
      "Stop current session activity before archiving",
      async () => {
        for (const item of readyPlanItems) {
          try {
            await this.closeActive(item.input.sessionId, { kind: "clear", reason: "archive" });
            readyInputs.push(item.input);
          } catch (error: unknown) {
            failures.push({ sessionId: item.input.sessionId, error: errorMessage(error) });
          }
        }

        try {
          const archived = await this.archiveStoreArchiveMany(readyInputs);
          archivedSessionIds.push(...archived.map((record) => record.sessionId));
        } catch (error: unknown) {
          for (const input of readyInputs) failures.push({ sessionId: input.sessionId, error: errorMessage(error) });
        }
      },
    );

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
    await this.runTreeExclusiveOperation(
      plan.unarchivedTargets.map((target) => ({
        sessionId: target.id,
        ...(target.activeSession === undefined ? {} : { session: target.activeSession }),
      })),
      `Stop current session activity before archiving ${sessionDisplayName(session)}`,
      async () => {
        for (const target of plan.targets) {
          if (target.archived) this.publishNotificationMutations(this.notificationStore.clearSession(target.id, "archive"));
        }
        for (const input of archiveInputs) await this.closeActive(input.sessionId, { kind: "clear", reason: "archive" });
        await this.archiveStoreArchiveMany(archiveInputs);
      },
    );

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
    await this.closeActive(archived.sessionId, { kind: "clear", reason: "restore" });
    await this.archiveStore.restore(archived.sessionId);
  }

  async deleteArchived(ref: PiSessionLookup): Promise<void> {
    const record = await this.getArchived(ref);
    if (record === undefined) throw new Error("Archived session not found");
    if (this.archiveStore.deleteArchived === undefined) throw new Error("Archive store does not support deletion");

    await this.closeActive(record.sessionId, { kind: "clear", reason: "delete" });
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
        await this.closeActive(item.record.sessionId, { kind: "clear", reason: "delete" });
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

    const reopenedSession = await this.runTreeExclusiveOperation(
      [{ sessionId: session.sessionId, session }],
      "Stop current session activity before reloading",
      async () => {
        const priorGeneration = this.notificationGenerationBySession.get(session);
        const { sessionId, cwd } = notificationIdentityForSession(session);
        let candidateGeneration: SessionNotificationGeneration | undefined;
        try {
          await this.closeActive(
            sessionId,
            priorGeneration === undefined ? CLEAR_RUNTIME_NOTIFICATIONS : DEFER_RUNTIME_NOTIFICATIONS,
          );
          candidateGeneration = priorGeneration === undefined
            ? undefined
            : this.notificationStore.beginReplacement(priorGeneration, { sessionId, cwd });
          const reopened = await this.getActive(ref, candidateGeneration === undefined ? {} : { notificationGeneration: candidateGeneration });
          if (candidateGeneration !== undefined) {
            this.publishNotificationMutations(this.notificationStore.commitReplacement(candidateGeneration));
          }
          return reopened.runtime.session;
        } catch (error: unknown) {
          if (candidateGeneration !== undefined) {
            this.publishNotificationMutations(this.notificationStore.abortReplacement(candidateGeneration));
          }
          throw error;
        }
      },
    );
    this.publishStatus(reopenedSession);
  }

  async detachParent(ref: PiSessionLookup): Promise<void> {
    const session = await this.getOrOpen(ref);
    const sessionFile = session.sessionFile;
    if (sessionFile === undefined || sessionFile === "") throw new Error("Session is not persisted");
    await clearParentSession(sessionFile);
    clearParentSessionHeader(session.sessionManager);
    this.unregisterSubsession(session.sessionId);
  }

  async clearQueue(ref: PiSessionLookup): Promise<ClientSessionStatus> {
    await this.assertWritable(ref);
    const session = await this.getOrOpen(ref);
    this.clearCompactionPromptQueue(session.sessionId);
    clearSessionQueue(session);
    this.publishStatus(session);
    return this.statusFromSession(session);
  }

  async dismissWarning(ref: PiSessionLookup, dismissId: string): Promise<ClientSessionStatus> {
    const session = await this.getOrOpen(ref);
    dismissSessionWarning(session, dismissId);
    this.publishStatus(session);
    return this.statusFromSession(session);
  }

  async abort(ref: PiSessionLookup): Promise<void> {
    const active = this.activeForLookup(ref);
    if (active === undefined) return;
    const sessionId = active.runtime.session.sessionId;
    this.clearCompactionPromptQueue(sessionId);
    clearSessionQueue(active.runtime.session);
    try {
      await this.abortSessionOperations(active.runtime.session);
      this.publishActivity(active.runtime.session, "stopped", "idle");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.publishActivity(active.runtime.session, "stop failed", "error", message);
      throw error;
    } finally {
      this.publishStatus(active.runtime.session);
    }
  }

  async stop(ref: PiSessionLookup): Promise<void> {
    const active = this.activeForLookup(ref);
    if (active !== undefined) {
      await this.closeActive(active.runtime.session.sessionId);
      return;
    }
    if (isPiSessionRef(ref)) {
      this.publishNotificationMutations(this.notificationStore.clearSessionIdentity(ref.id, canonicalizeStoredCwd(ref.cwd), "runtime-close"));
      return;
    }
    await this.closeActive(ref);
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

  private async closeActive(sessionId: string, notificationPolicy: NotificationClosePolicy = CLEAR_RUNTIME_NOTIFICATIONS): Promise<void> {
    const pendingOpens = this.pendingSessionOpenPromises(sessionId);
    if (pendingOpens.length > 0) await Promise.allSettled(pendingOpens);
    const active = this.active.get(sessionId);
    if (notificationPolicy.kind === "clear") {
      const generation = active === undefined ? undefined : this.notificationGenerationBySession.get(active.runtime.session);
      const mutations = generation === undefined
        ? this.notificationStore.clearSession(sessionId, notificationPolicy.reason)
        : this.notificationStore.clearGeneration(generation, notificationPolicy.reason);
      this.publishNotificationMutations(mutations);
    }
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
    active.runtime.setRebindSession(undefined);
    try {
      await this.abortSessionOperations(active.runtime.session);
    } finally {
      await active.runtime.dispose();
    }
  }

  private async abortSessionOperations(session: PiAgentSession): Promise<void> {
    let branchSummaryAbortFailed = false;
    let branchSummaryAbortError: unknown;
    try {
      session.abortBranchSummary?.();
    } catch (error: unknown) {
      branchSummaryAbortFailed = true;
      branchSummaryAbortError = error;
    }

    try {
      await session.abort();
    } catch (abortError: unknown) {
      if (branchSummaryAbortFailed) {
        throw new AggregateError([branchSummaryAbortError, abortError], "Failed to abort session operations", { cause: abortError });
      }
      throw abortError;
    }
    if (branchSummaryAbortFailed) throw branchSummaryAbortError;
  }

  private async assertWritable(ref: PiSessionLookup): Promise<void> {
    if (await this.getArchived(ref) !== undefined) throw new Error("Archived sessions are read-only. Restore the session to continue.");
  }

  private async getOrOpen(ref: PiSessionLookup): Promise<PiAgentSession> {
    return (await this.getActive(ref)).runtime.session;
  }

  private async getActive(ref: PiSessionLookup, options: Pick<CreateSessionRuntimeOptions, "notificationGeneration"> = {}): Promise<ActiveSession<PiSessionRuntime>> {
    const active = this.activeForLookup(ref);
    if (active !== undefined) return active;

    const archived = await this.getArchived(ref);
    if (archived?.archivePath !== undefined) {
      const { archivePath } = archived;
      return this.openExistingSession(
        archived.sessionId,
        archived.cwd,
        () => this.sessionManager.open(archivePath),
        { notifications: "disabled" },
      );
    }

    const match = isPiSessionRef(ref)
      ? (await this.sessionManager.list(ref.cwd)).find((s) => s.id === ref.id || s.id.startsWith(ref.id))
      : (await this.sessionManager.listAll?.() ?? []).find((s) => s.id === ref || s.id.startsWith(ref));
    if (!match) throw new Error("Session not found");
    return this.openExistingSession(match.id, match.cwd, () => this.sessionManager.open(match.path), options);
  }

  private openExistingSession(
    sessionId: string,
    cwd: string,
    openSessionManager: () => PiSessionManager,
    options: Pick<CreateSessionRuntimeOptions, "notificationGeneration" | "notifications"> = {},
  ): Promise<ActiveSession<PiSessionRuntime>> {
    const active = this.activeForLookup({ id: sessionId, cwd });
    if (active !== undefined) return Promise.resolve(active);

    const key = JSON.stringify([canonicalizeStoredCwd(cwd), sessionId]);
    const existing = this.pendingSessionOpens.get(key);
    if (existing !== undefined) return existing.promise;

    const pending: PendingSessionOpen = {
      sessionId,
      promise: this.create(openSessionManager(), cwd, options),
    };
    pending.promise = pending.promise.finally(() => {
      if (this.pendingSessionOpens.get(key) === pending) this.pendingSessionOpens.delete(key);
    });
    this.pendingSessionOpens.set(key, pending);
    return pending.promise;
  }

  private pendingSessionOpenPromises(sessionId?: string): Promise<ActiveSession<PiSessionRuntime>>[] {
    return [...this.pendingSessionOpens.values()]
      .filter((pending) => sessionId === undefined || pending.sessionId === sessionId)
      .map((pending) => pending.promise);
  }

  private async getArchived(ref: PiSessionLookup): Promise<ArchivedSessionRecord | undefined> {
    const archived = await this.archiveStore.get(sessionIdFromLookup(ref));
    if (archived === undefined) return undefined;
    if (isPiSessionRef(ref) && archived.cwd !== ref.cwd) return undefined;
    return archived;
  }

  private isCurrentActiveSession(session: PiAgentSession): boolean {
    return this.active.get(session.sessionId)?.runtime.session === session;
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

  private async create(
    sessionManager: PiSessionManager,
    cwd: string,
    options: CreateSessionRuntimeOptions = {},
  ): Promise<ActiveSession<PiSessionRuntime>> {
    const delegationToolsEnabled = options.creationProvenance !== "tracked-subsession"
      && await sessionAllowsDelegationTools(sessionManager, this.sessionManager);
    const runtime = await this.createAgentRuntime(this.createRuntime, {
      cwd,
      agentDir: this.agentDir,
      sessionManager,
      delegationToolsEnabled,
      ...(options.initialModel === undefined ? {} : { initialModel: options.initialModel }),
    });
    const active: ActiveSession<PiSessionRuntime> = { runtime, unsubscribe: noop };
    let notificationGeneration = options.notificationGeneration;
    let notificationOwnership: "disabled" | "external" | "registered" | "replacement" = options.notifications === "disabled"
      ? "disabled"
      : notificationGeneration === undefined
        ? "registered"
        : "external";

    if (notificationOwnership === "registered") {
      const notificationIdentity = notificationIdentityForSession(runtime.session);
      const existingCandidate = this.notificationStore.beginReplacementForSession(
        notificationIdentity.sessionId,
        notificationIdentity.cwd,
      );
      if (existingCandidate !== undefined) {
        notificationGeneration = existingCandidate;
        notificationOwnership = "replacement";
      } else {
        const registration = this.notificationStore.registerSession(
          notificationIdentity.sessionId,
          notificationIdentity.cwd,
        );
        notificationGeneration = registration.generation;
        this.publishNotificationMutations(registration.mutations);
      }
    }
    if (notificationGeneration !== undefined) this.notificationGenerationBySession.set(runtime.session, notificationGeneration);

    try {
      await this.bindSessionExtensions(runtime.session, notificationGeneration);
      this.bindRuntime(active);
      runtime.setRebindSession(async (session) => {
        const priorGeneration = notificationGeneration;
        let candidateGeneration: SessionNotificationGeneration | undefined;
        try {
          if (priorGeneration !== undefined) {
            candidateGeneration = this.notificationStore.beginReplacement(priorGeneration, notificationIdentityForSession(session));
            this.notificationGenerationBySession.set(session, candidateGeneration);
          }
          this.bindRuntime(active, session);
          await this.bindSessionExtensions(session, candidateGeneration);
          await this.recoverSubsessionTrackingForOpenedSession(session);
          if (candidateGeneration !== undefined) {
            this.publishNotificationMutations(this.notificationStore.commitReplacement(candidateGeneration));
            notificationGeneration = candidateGeneration;
          }
        } catch (error: unknown) {
          if (candidateGeneration !== undefined) {
            this.publishNotificationMutations(this.notificationStore.abortReplacement(candidateGeneration, "candidate"));
            notificationGeneration = candidateGeneration;
            this.notificationGenerationBySession.set(session, candidateGeneration);
          }
          throw error;
        }
      });
      this.active.set(runtime.session.sessionId, active);
      await this.recoverSubsessionTrackingForOpenedSession(runtime.session);
      if (notificationOwnership === "replacement" && notificationGeneration !== undefined) {
        this.publishNotificationMutations(this.notificationStore.commitReplacement(notificationGeneration));
        notificationOwnership = "external";
      }
      this.publishStatus(runtime.session);
      return active;
    } catch (error: unknown) {
      if (notificationGeneration !== undefined) {
        if (notificationOwnership === "registered") {
          this.publishNotificationMutations(this.notificationStore.clearSession(runtime.session.sessionId, "initialization-failed"));
        } else if (notificationOwnership === "replacement") {
          this.publishNotificationMutations(this.notificationStore.abortReplacement(notificationGeneration));
        }
      }
      active.unsubscribe();
      let removedActive = false;
      for (const [sessionId, candidate] of this.active.entries()) {
        if (candidate !== active) continue;
        this.active.delete(sessionId);
        this.activities.delete(sessionId);
        this.clearAuthLossWarningsForSession(sessionId);
        this.clearCompactionPromptQueue(sessionId);
        removedActive = true;
      }
      if (removedActive) {
        this.workspaceActivity?.removeSession(runtime.session.sessionId, runtime.session.sessionManager.getCwd());
      }
      try {
        await runtime.session.abort();
      } finally {
        await runtime.dispose();
      }
      throw error;
    }
  }

  private async bindSessionExtensions(
    session: PiAgentSession,
    generation: SessionNotificationGeneration | undefined,
  ): Promise<void> {
    const uiContext = this.sessionUiContext(session, generation);
    await session.bindExtensions({
      uiContext,
      mode: "rpc",
      onError: (error) => {
        const message = `${error.extensionPath}: ${error.error}`;
        this.publishActivity(session, "extension error", "error", message);
        this.events.publish(session.sessionId, { type: "session.error", message });
      },
    });
  }

  private replaceSessionNotificationContext(session: PiAgentSession, generation: SessionNotificationGeneration): void {
    session.extensionRunner.setUIContext(this.sessionUiContext(session, generation), "rpc");
  }

  private sessionUiContext(
    session: PiAgentSession,
    generation: SessionNotificationGeneration | undefined,
  ): ExtensionUIContext {
    const baseUiContext = session.extensionRunner.getUIContext();
    const notify: ExtensionUIContext["notify"] = (message, type) => {
      if (generation === undefined) {
        this.events.publish(session.sessionId, {
          type: "command.output",
          level: type === "error" ? "error" : "info",
          message,
        });
        return;
      }
      const added = this.notificationStore.addNotification(generation, message, type);
      this.publishNotificationMutations(added.mutations);
      if (added.notification === undefined) return;
      this.events.publish(session.sessionId, {
        type: "command.output",
        level: type === "error" ? "error" : "info",
        message,
        notificationId: added.notification.id,
      });
    };
    // PI WEB owns the browser-facing notification and text-formatting
    // boundaries. Delegate every other UI method to Pi's headless defaults so
    // unsupported dialogs cancel safely instead of hanging.
    return new Proxy(baseUiContext, {
      get(target, property, receiver): unknown {
        if (property === "notify") return notify;
        if (property === "theme") return plainTextTheme;
        const value: unknown = Reflect.get(target, property, receiver);
        return value;
      },
    });
  }

  private publishNotificationMutations(mutations: readonly SessionNotificationMutation[]): void {
    for (const mutation of mutations) {
      this.events.publish(mutation.sessionId, mutation.inboxEvent);
      this.events.publishNotificationSummary(mutation.summaryEvent);
    }
  }

  private bindRuntime(active: ActiveSession<PiSessionRuntime>, session: PiAgentSession = active.runtime.session): void {
    active.unsubscribe();
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
    if (this.treeNavigations.has(session)) {
      this.deferredGeneratedSessionNames.set(session, name);
      return;
    }
    session.setSessionName(name);
    this.publishSessionName(session);
  }

  private flushDeferredTreeNavigationWork(session: PiAgentSession): void {
    const generatedName = this.deferredGeneratedSessionNames.get(session);
    this.deferredGeneratedSessionNames.delete(session);
    if (generatedName !== undefined) {
      try {
        this.applyGeneratedSessionName(session, generatedName);
      } catch (error: unknown) {
        this.logger.info(
          { sessionId: session.sessionId, error: error instanceof Error ? error.message : String(error) },
          "failed to apply deferred session name",
        );
      }
    }

    const notifications = this.deferredSubsessionNotifications.get(session) ?? [];
    this.deferredSubsessionNotifications.delete(session);
    for (const notification of notifications) {
      void this.deliverSubsessionNotification(session, notification).catch((error: unknown) => {
        this.logSubsessionNotificationFailure(notification.parentId, notification.childId, error);
      });
    }
  }

  applyAuthChange(change: AuthChange = {}): void {
    // ModelRuntime.login()/logout() refresh the shared runtime before AuthService
    // emits the change, so no refresh is needed here. Keeping this synchronous
    // also lets every active session observe the same committed auth snapshot.
    for (const active of this.active.values()) {
      const { session } = active.runtime;
      this.syncCurrentModelAuthWarning(session, change.removedProviderId);
      this.publishStatus(session);
    }
  }

  private syncCurrentModelAuthWarning(session: PiAgentSession, removedProviderId: string | undefined): void {
    const model = session.model;
    if (model === undefined) return;
    if (model.provider === "unknown" && model.id === "unknown") return;
    const warningKey = authLossWarningKey(session.sessionId, model.provider, model.id);
    const registered = session.modelRuntime.getModel(model.provider, model.id);
    if (registered === undefined) return;
    if (session.modelRuntime.hasConfiguredAuth(model.provider)) {
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
    if (this.treeNavigations.has(session)) return "navigating session tree";
    if (this.isSessionEntryMutationActive(session)) return "updating session";
    if (session.isCompacting) return "compacting";
    if (session.isBashRunning) return "running bash";
    if (session.isStreaming) return "agent running";
    if (this.pendingMessageCount(session) > 0) return "queued";
    return "active";
  }

  private hasActiveWork(session: PiAgentSession): boolean {
    return this.treeNavigations.has(session)
      || this.isSessionEntryMutationActive(session)
      || this.isTreeExclusiveOperationActive(session)
      || sessionHasActiveWork(session, this.compactionQueuedMessages(session.sessionId).length);
  }

  private async runTreeExclusiveOperation<T>(
    targets: readonly TreeExclusiveOperationTarget[],
    activeError: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const sessionIds = new Set<string>();
    const runtimes = new Set<PiSessionRuntime>();
    for (const target of targets) {
      const runtime = target.runtime ?? (target.session === undefined ? undefined : this.activeRuntimeForSession(target.session));
      const session = target.session ?? runtime?.session;
      if (session !== undefined && this.hasActiveWork(session)) throw new Error(activeError);
      sessionIds.add(target.sessionId);
      if (runtime !== undefined) runtimes.add(runtime);
    }

    for (const sessionId of sessionIds) {
      this.treeExclusiveSessionOperationCounts.set(sessionId, (this.treeExclusiveSessionOperationCounts.get(sessionId) ?? 0) + 1);
    }
    for (const runtime of runtimes) {
      this.treeExclusiveRuntimeOperationCounts.set(runtime, (this.treeExclusiveRuntimeOperationCounts.get(runtime) ?? 0) + 1);
    }

    try {
      return await operation();
    } finally {
      for (const runtime of runtimes) decrementWeakCount(this.treeExclusiveRuntimeOperationCounts, runtime);
      for (const sessionId of sessionIds) decrementMapCount(this.treeExclusiveSessionOperationCounts, sessionId);
    }
  }

  private isTreeExclusiveSessionIdentityActive(sessionId: string): boolean {
    return (this.treeExclusiveSessionOperationCounts.get(sessionId) ?? 0) > 0;
  }

  private isTreeExclusiveOperationActive(session: PiAgentSession): boolean {
    if (this.isTreeExclusiveSessionIdentityActive(session.sessionId)) return true;
    const runtime = this.activeRuntimeForSession(session);
    return runtime !== undefined && (this.treeExclusiveRuntimeOperationCounts.get(runtime) ?? 0) > 0;
  }

  private activeRuntimeForSession(session: PiAgentSession): PiSessionRuntime | undefined {
    for (const active of new Set(this.active.values())) {
      if (active.runtime.session === session) return active.runtime;
    }
    return undefined;
  }

  private assertTreeNavigationInactive(session: PiAgentSession, action: string): void {
    if (this.treeNavigations.has(session)) throw new Error(`Cannot ${action} while session tree navigation is active`);
  }

  private async runSessionEntryMutation<T>(session: PiAgentSession, action: string, operation: () => Promise<T>): Promise<T> {
    this.beginSessionEntryMutation(session, action);
    try {
      return await operation();
    } finally {
      this.endSessionEntryMutation(session);
    }
  }

  private beginSessionEntryMutation(session: PiAgentSession, action: string): void {
    this.assertTreeNavigationInactive(session, action);
    this.sessionEntryMutationCounts.set(session, (this.sessionEntryMutationCounts.get(session) ?? 0) + 1);
  }

  private endSessionEntryMutation(session: PiAgentSession): void {
    const remaining = (this.sessionEntryMutationCounts.get(session) ?? 1) - 1;
    if (remaining <= 0) this.sessionEntryMutationCounts.delete(session);
    else this.sessionEntryMutationCounts.set(session, remaining);
  }

  private isSessionEntryMutationActive(session: PiAgentSession): boolean {
    return (this.sessionEntryMutationCounts.get(session) ?? 0) > 0;
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
    const warnings = this.warningsForSession(session);
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
      ...(warnings.length === 0 ? {} : { warnings }),
    };
  }

  /**
   * Compute the live warning set for a session: runtime/resource diagnostics from
   * the active runtime (if any) plus the Anthropic subscription-auth notice. Read
   * fresh on each status publish so a rebuilt runtime or an auth/model change is
   * reflected without caching a stale snapshot.
   */
  private warningsForSession(session: PiAgentSession): SessionWarning[] {
    const runtime = this.active.get(session.sessionId)?.runtime;
    const warnings = runtime === undefined ? [] : collectRuntimeWarnings(runtime);
    const anthropic = anthropicSubscriptionWarning(session, join(this.agentDir, "auth.json"));
    if (anthropic !== undefined) warnings.push(anthropic);
    return warnings;
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

function notificationIdentityForSession(session: PiAgentSession): { sessionId: string; cwd: string } {
  return {
    sessionId: session.sessionId,
    cwd: canonicalizeStoredCwd(session.sessionManager.getCwd()),
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

interface TrackedSubsessionSessionIdentity {
  sessionId: string;
  sessionFile: string | undefined;
  sessionManager: PiSessionManager;
  cwd: string;
}

/**
 * Resolve the delegation capability from server-owned, persisted session
 * provenance. A copied marker is not enough: the child header and reciprocal
 * parent link must identify the exact same session files.
 */
export async function sessionAllowsDelegationTools(
  sessionManager: PiSessionManager,
  managers: Pick<PiSessionManagerGateway, "open">,
): Promise<boolean> {
  const trackedLink = await verifiedTrackedSubsessionLink(managers, {
    sessionId: sessionManager.getSessionId(),
    sessionFile: sessionManager.getSessionFile(),
    sessionManager,
    cwd: sessionManager.getCwd(),
  });
  return trackedLink === undefined;
}

async function verifiedTrackedSubsessionLink(
  managers: Pick<PiSessionManagerGateway, "open">,
  session: TrackedSubsessionSessionIdentity,
): Promise<TrackedSubsessionLink | undefined> {
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

  const parentLink = findReciprocalParentSubsessionLink(
    managers,
    parentSessionFile,
    marker.spawnedBySessionId,
    session.sessionId,
    childSessionFile,
  );
  if (parentLink === undefined) return undefined;
  return {
    parentSessionId: marker.spawnedBySessionId,
    childSessionId: session.sessionId,
    childSessionFile,
    parentSessionFile,
    cwd: parentLink.cwd ?? session.cwd,
  };
}

function findReciprocalParentSubsessionLink(
  managers: Pick<PiSessionManagerGateway, "open">,
  parentSessionFile: string,
  parentSessionId: string,
  childSessionId: string,
  childSessionFile: string,
): PersistedParentSubsessionLink | undefined {
  let parentManager: PiSessionManager;
  try {
    parentManager = managers.open(parentSessionFile);
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

const SUBSESSION_NOTIFICATION_MAX_OUTPUT_CHARS = 2000;

/** Avoid duplicating a partial result in context when deliberate inspection can return the full output. */
function formatSubsessionNotificationOutput(childSessionId: string, text: string): string {
  if (text.length > SUBSESSION_NOTIFICATION_MAX_OUTPUT_CHARS) {
    return `Output from subsession ${childSessionId} was too long for this completion notice and was omitted. Call check_subsession with sessionId "${childSessionId}" to retrieve the final output.`;
  }
  return `--- SUBSESSION OUTPUT: ${childSessionId} ---\n${text === "" ? "(no output)" : text}`;
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
