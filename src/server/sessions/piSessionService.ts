import { statSync } from "node:fs";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  createEditToolDefinition,
  defineTool,
  hasTrustRequiringProjectResources,
  ProjectTrustStore,
  readStoredCredential,
  SessionManager,
  SettingsManager,
  type AgentSessionRuntimeDiagnostic,
  type AgentSessionServices,
  type CreateAgentSessionRuntimeFactory,
  type CreateAgentSessionServicesOptions,
  type EditToolDetails,
  type ExtensionUIDialogOptions,
  type ExtensionUIContext,
  type ModelRuntime,
  type ProjectTrustContext,
  type ProjectTrustEvent,
  type ProjectTrustEventResult,
  type ResourceDiagnostic,
} from "@earendil-works/pi-coding-agent";
import type { ClientArchiveSessionsResponse, ClientCommand, ClientCommandResult, ClientMessagePage, ClientSession, ClientSessionCleanupExecuteResponse, ClientSessionCleanupPreviewResponse, ClientSessionModel, ClientSessionModelCatalogEntry, ClientSessionStatus, ClientSessionTreeForkRequest, ClientSessionTreeForkResult, ClientSessionTreeNavigateRequest, ClientSessionTreeNavigateResult, ClientThinkingLevel, SessionStreamSnapshot, SessionUiEvent } from "../types.js";
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
import { loadEffectiveProjectAttachmentsConfig } from "../workspaces/projectPiWebConfig.js";
import type { PiWebConfigService } from "../configRoutes.js";
import { parsePromptAttachments } from "../../shared/promptAttachments.js";
import { ASK_USER_ANSWERS_CUSTOM_TYPE, SESSION_TREE_CUSTOM_INSTRUCTIONS_MAX_LENGTH, SESSION_UNREAD_LIMIT } from "../../shared/apiTypes.js";
import type {
  AskUserCloseResponse,
  AskUserOutcome,
  AskUserSubmission,
  ExtensionDialogAnswer,
  ExtensionDialogCloseResponse,
  ExtensionDialogKind,
  ExtensionDialogOutcome,
  PiWebAttachmentsConfig,
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
  SessionModelScopeMode,
  SessionUnreadAcknowledgeRequest,
  SessionUnreadCatalogSnapshot,
  SessionWarning,
} from "../../shared/apiTypes.js";
import type { SessionRouteRef, SessionRouteService } from "./sessionService.js";

import { type AuthChange } from "./authService.js";
import { canonicalizeStoredCwd, cwdPathsEqual } from "../workingDirectory.js";
import { readSessionHeaderSummary } from "./sessionFileHeader.js";
import type { WorkspaceActivityService } from "../activity/workspaceActivityService.js";
import { createAskUserToolDefinition, type AskUserInvocation, type AskUserToolDeps } from "./askUserTool.js";
import { PendingAskStore, renderAskUserAnswersText, type PendingAskCloseResult, type PendingAskOpenResult } from "./pendingAskStore.js";
import { PendingExtensionDialogStore, type ExtensionDialogCancelReason } from "./pendingExtensionDialogStore.js";
import { ExtensionDialogWaiters, effectiveExtensionDialogTimeoutMs, extensionDialogCancelValue } from "./extensionDialogWaiters.js";
import { DEFAULT_EXTENSION_DIALOGS_TIMEOUT_MS } from "../../config.js";
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
import { SessionUnreadStore, type SessionUnreadMutation } from "./sessionUnreadStore.js";
import { applyEnabledModelToggle, catalogWithEnabledFirst, modelScopeId, persistedEnabledModelPatterns, resolveEnabledModelIds, resolveSessionModelOptions, scopedModelsFromEnabledIds, type EnabledModelCatalogEntry } from "./sessionModelScope.js";

/**
 * Minimal structured-logging seam, shaped like Fastify's logger so sessiond can
 * pass `app.log` directly. Defaults to a no-op so the service stays usable
 * without booting a server (e.g. in tests).
 */
export interface PiSessionLogger {
  info(details: Record<string, unknown>, message: string): void;
}

const noopLogger: PiSessionLogger = { info() { /* no-op */ } };
const DEFAULT_UNREAD_PUBLICATION_RETRY_MS = 1_000;
/**
 * User-facing names for the two phases of session startup PI WEB can prove it
 * is inside: it awaits exactly one call for each, so the phase is a fact rather
 * than a guess. Deliberately free of internal symbol names and file paths.
 */
const STARTUP_PHASE_RUNTIME = "Starting the Pi session";
const STARTUP_PHASE_EXTENSIONS = "Loading session extensions";
/**
 * Appended to whichever phase is running when a background provider catalog
 * refresh happens to be in flight. It is stated as a concurrent fact, never as
 * the cause: PI WEB can verify that a refresh is running, but not that this
 * particular startup is waiting on it.
 */
const STARTUP_CONCURRENT_CATALOG_REFRESH = "provider model lists are refreshing";
const MAX_UNREAD_PUBLICATION_RETRY_MS = 30_000;
const MAX_PENDING_UNREAD_MUTATIONS = SESSION_UNREAD_LIMIT + 1;
/**
 * Upper bound on how often one idle runtime re-resolves its transcript file.
 * A runtime created in memory and never persisted has no session file, so
 * every poll would otherwise rescan the session directory; throttling keeps
 * steady-state polling of such a session O(1). The window can only delay
 * noticing a file the runtime did not write itself: once the runtime
 * persists, `getSessionFile()` answers and this throttle is bypassed.
 */
const IDLE_SESSION_FILE_RESOLUTION_THROTTLE_MS = 30_000;

function noop(): void {
  // Intentionally empty default unsubscribe callback.
}

function spawnTargetError(decision: Extract<SpawnTargetDecision, { allowed: false }>): Error {
  if (decision.reason === "not-registered") return new Error("Spawning session is not in a registered project");
  return new Error(`cwd must be a workspace of this project. Allowed: ${decision.allowedCwds.join(", ")}`);
}

/**
 * Tracked subsessions are worktree-scoped, so a requested target other than the
 * parent's own cwd fails closed instead of being silently retargeted. The
 * message names the rule and both supported ways to get work done elsewhere.
 */
function subsessionCwdError(spawningCwd: string, requestedCwd: string): Error {
  return new Error(`A tracked subsession runs in this session's working directory (${spawningCwd}); ${requestedCwd} was requested. Instruct the child to work elsewhere from this workspace, or use spawn_session for an independent session in another workspace.`);
}

function modelSpecOf(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

/**
 * Parse a strict `provider/model-id` spec: split on the first `/` (model ids
 * may themselves contain `/`) and require both parts to be non-empty.
 */
function parseModelSpec(spec: string): { provider: string; modelId: string } | undefined {
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash === spec.length - 1) return undefined;
  return { provider: spec.slice(0, slash), modelId: spec.slice(slash + 1) };
}

/**
 * Error for a spawn-tool model spec that matched nothing. States the facts —
 * the bad spec and the required format — with deliberately no model list
 * (a list would invite guesses). The agent loop turns the throw into an
 * error tool result; how to recover is the agent's call.
 */
function unknownSpawnModelError(modelSpec: string): Error {
  return new Error(`Unknown model "${modelSpec}". Pass an exact "provider/model-id".`);
}

function authLossWarningKey(sessionId: string, provider: string, modelId: string): string {
  return `${sessionId}:${provider}/${modelId}`;
}

function refMatchesActiveSession(ref: PiSessionRef, active: ActiveSession<PiSessionRuntime>): boolean {
  return cwdPathsEqual(active.runtime.cwd, ref.cwd);
}

function refMatchesStartupSession(ref: PiSessionRef, session: PiAgentSession): boolean {
  return cwdPathsEqual(session.sessionManager.getCwd(), ref.cwd);
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
  /**
   * Thinking level for the brand new session; omit to resolve from settings
   * and pi defaults. Pi clamps it to the initial model's capabilities.
   */
  initialThinkingLevel?: ClientThinkingLevel;
  /**
   * Opaque label, echoed on this construction's startup progress so a browser
   * row with no session id yet can recognise its own.
   */
  startupToken?: string;
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

export interface PiSessionListEntry {
  id: string;
  path: string;
  cwd: string;
  created: Date;
  modified: Date;
  /**
   * Number of `message` entries in the transcript. The streaming summary
   * scanner counts message lines by their leading bytes and a trailing `}`
   * without validating the JSON, so a final write read mid-flight can add a
   * transient +1; the count self-heals on the next listing once the line
   * completes.
   */
  messageCount: number;
  firstMessage: string;
  allMessagesText: string;
  name?: string;
  parentSessionPath?: string;
}

/** A session file located by id without parsing its transcript. */
export interface ResolvedSessionFile {
  id: string;
  cwd: string;
  path: string;
}

interface WorkspaceArchiveCandidate extends SessionArchiveTreeCandidate {
  cwd: string;
  listEntry?: PiSessionListEntry;
  activeSession?: PiAgentSession;
}

interface BulkSessionRefContext {
  sessionsByCwd: Map<string, PiSessionListEntry[]>;
}

interface BulkArchivePlanItem {
  input: ArchiveSessionInput;
}

interface BulkDeletePlanItem {
  record: ArchivedSessionRecord;
}

type AgentModel = NonNullable<SpawnSessionInvocation["model"]>;

type ModelScopeSource = "global" | "workspace";

interface ModelScopeContext {
  key: string;
  source: ModelScopeSource;
  /** Global scope controls are writable through the PI WEB picker. */
  editable: boolean;
}

interface ModelScopeSnapshot {
  /** Effective provider/model ids; null means every catalog model is enabled. */
  enabledIds: readonly string[] | null;
  /** Monotonic revision for this global or workspace scope. */
  revision: number;
}

interface SessionModelScopeCache {
  scopeKey: string;
  revision: number;
  catalogKey: string;
}

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
  /**
   * Locate a session file by id, with an exact header id taking priority over
   * a prefix, without parsing message bodies or building a full workspace
   * transcript listing.
   */
  resolveSessionFile(cwd: string, sessionId: string): Promise<ResolvedSessionFile | undefined>;
  /**
   * Drop any cached listing summary for a session file that was rewritten in
   * place (detach clears the header while keeping the inode): file identity
   * and size checks cannot detect such rewrites, so the scanner memo must be
   * told explicitly.
   */
  invalidateSessionFile(sessionFile: string): void;
  /**
   * Read the active transcript branch without creating a runtime or writing the file.
   * Resolves `undefined` when the transcript file is absent (never persisted or
   * externally removed): there is no disk snapshot, and the runtime branch
   * stays authoritative.
   */
  readBranch?(path: string): Promise<unknown[] | undefined>;
  create(cwd: string, options?: { parentSession?: string }): PiSessionManager;
  /**
   * Cross-project listing of Pi's session stores (the default store plus any
   * env-configured session dir). Session cleanup scans every project at once;
   * cwd-scoped UI listings use `list`, while direct named lookups use
   * `resolveSessionFile`.
   */
  listAll(): Promise<PiSessionListEntry[]>;
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
   * Narrow read/write of the SDK `SettingsManager`, exposing the warning
   * suppression flags consumed here (e.g. `anthropicExtraUsage`) and pi's
   * `enabledModels` model-scope setting. The warnings gate the Anthropic
   * subscription-auth billing warning the same way the TUI does; the enabled
   * models let the model picker read the effective scope and edit the global
   * scope (shared with the pi TUI) the way `showModelsSelector` does. A
   * workspace override is exposed separately and remains read-only.
   */
  settingsManager: {
    getWarnings(): { anthropicExtraUsage?: boolean };
    setWarnings(warnings: { anthropicExtraUsage?: boolean }): void;
    getEnabledModels(): string[] | undefined;
    getProjectSettings?(): object;
    setEnabledModels(patterns: string[] | undefined): void;
  };
  sessionManager: PiSessionManager;
  scopedModels: readonly { model: AgentModel; thinkingLevel?: ClientThinkingLevel }[];
  /** Update the session's cycling scope, mirroring pi's `AgentSession.setScopedModels`. */
  setScopedModels(models: { model: AgentModel; thinkingLevel?: ClientThinkingLevel }[]): void;
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
   * `Agent`), exposing only `streamFunction` — the resolved-auth/headers/retry "call
   * this model" function pi's own compaction/branch-summarization code uses
   * internally. Lets callers (e.g. session title generation) issue one-off model
   * calls without depending on pi-ai's deprecated `/compat` provider registry or
   * leaking the full `Agent`/`AgentSession` surface.
   */
  agent: { streamFunction: StreamFn };
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

interface CreateSessionRuntimeOptions extends Pick<InternalStartSessionOptions, "initialModel" | "initialThinkingLevel" | "creationProvenance" | "startupToken"> {
  notificationGeneration?: SessionNotificationGeneration;
  notifications?: "enabled" | "disabled";
  /**
   * What the user asked for, so startup progress can say "Creating" instead of
   * "Opening". Only `startSession()` creates a brand new session; every other
   * caller opens an existing one, so "open" is the default.
   */
  startupIntent?: "create" | "open";
}

/**
 * Read-only view of the background catalog refresher, so session startup can
 * state what it is concurrent with without being able to influence it.
 */
export interface CatalogRefreshStatus {
  isRefreshInFlight(): boolean;
}

/**
 * Publishes what a session startup is waiting on while it waits. Every call is
 * synchronous and event-only, so reporting never adds an await to session
 * creation and leaves no per-session state to unwind if creation fails.
 */
interface SessionStartupProgressReporter {
  report(phase: string): void;
  end(): void;
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
  initialThinkingLevel?: ClientThinkingLevel;
}

type PiWebRuntimeFactoryOptions = Parameters<CreateAgentSessionRuntimeFactory>[0] & {
  delegationToolsEnabled?: boolean;
  initialModel?: AgentModel;
  initialThinkingLevel?: ClientThinkingLevel;
};

type PiWebCreateAgentSessionRuntimeFactory = (
  options: PiWebRuntimeFactoryOptions
) => ReturnType<CreateAgentSessionRuntimeFactory>;

type CreateAgentRuntime = (createRuntime: PiWebCreateAgentSessionRuntimeFactory, options: CreateAgentRuntimeOptions) => Promise<PiSessionRuntime>;

function defaultCreateAgentRuntime(createRuntime: PiWebCreateAgentSessionRuntimeFactory, options: CreateAgentRuntimeOptions): Promise<PiSessionRuntime> {
  if (!(options.sessionManager instanceof SessionManager)) throw new Error("Default runtime creation requires an SDK SessionManager");
  const runtimeFactory = createRuntimeWithOneShotSessionOptions(createRuntime, options.initialModel, options.initialThinkingLevel, options.delegationToolsEnabled);
  return createAgentSessionRuntime(runtimeFactory, {
    cwd: options.cwd,
    agentDir: options.agentDir,
    sessionManager: options.sessionManager,
  });
}

function createRuntimeWithOneShotSessionOptions(
  createRuntime: PiWebCreateAgentSessionRuntimeFactory,
  initialModel: AgentModel | undefined,
  initialThinkingLevel: ClientThinkingLevel | undefined,
  delegationToolsEnabled: boolean,
): CreateAgentSessionRuntimeFactory {
  // These inputs belong only to the session being opened. A later runtime
  // replacement resolves its own model and delegation capability, and restores
  // the thinking level from the existing session file.
  let pendingInitialModel = initialModel;
  let pendingInitialThinkingLevel = initialThinkingLevel;
  let pendingDelegationToolsEnabled: boolean | undefined = delegationToolsEnabled;
  return async (options) => {
    const model = pendingInitialModel;
    const thinkingLevel = pendingInitialThinkingLevel;
    const toolsEnabled = pendingDelegationToolsEnabled;
    pendingInitialModel = undefined;
    pendingInitialThinkingLevel = undefined;
    pendingDelegationToolsEnabled = undefined;
    return createRuntime({
      ...options,
      ...(model === undefined ? {} : { initialModel: model }),
      ...(thinkingLevel === undefined ? {} : { initialThinkingLevel: thinkingLevel }),
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
  askUser?: AskUserToolDeps,
) {
  return [
    createPiWebEditToolDefinition(cwd),
    ...(delegationEnabled && spawn !== undefined ? [createSpawnSessionToolDefinition(cwd, { spawn })] : []),
    ...(delegationEnabled && subsessions !== undefined ? createSubsessionToolDefinitions(cwd, subsessions) : []),
    // Asking the user is not delegation: the questions land in the session the
    // user is already watching, so tracked children may ask too.
    ...(askUser === undefined ? [] : [createAskUserToolDefinition(askUser)]),
  ];
}

/**
 * Error collected from a `project_trust` handler, mirroring the per-extension
 * errors the SDK's `emitProjectTrustEvent` returns (its `extensionPath` and
 * `error` fields are what the reported message needs).
 */
export interface WebProjectTrustExtensionError {
  extensionPath: string;
  error: string;
}

/**
 * The slice of the SDK's `LoadExtensionsResult` the trust event emitter reads:
 * each pre-trust extension's path and its registered `project_trust` handlers.
 * Narrowing keeps this module free of the SDK's full `Extension` internals; a
 * real `LoadExtensionsResult` (as handed to the resource loader's
 * `resolveProjectTrust` callback) is structurally assignable to it.
 */
export interface WebProjectTrustExtensionSet {
  extensions: {
    path: string;
    handlers: Map<string, readonly ((event: ProjectTrustEvent, ctx: ProjectTrustContext) => unknown)[]>;
  }[];
}

/**
 * Inputs for {@link resolveWebProjectTrusted} — the web mirror of the inputs
 * the SDK's `resolveProjectTrusted` takes.
 */
export interface WebProjectTrustResolution {
  cwd: string;
  /**
   * The pre-trust extension set the SDK loaded for this resolution (user/global
   * extensions; project-local ones are not loaded yet because trust is still
   * unresolved). When present, those extensions may decide trust via the
   * `project_trust` event.
   */
  extensionsResult?: WebProjectTrustExtensionSet;
  /** The agent dir's trust store; `remember`-ed decisions are written here. */
  trustStore: ProjectTrustStore;
  /** Settings manager whose `defaultProjectTrust` applies when nothing decided. */
  settingsManager: SettingsManager;
  /**
   * Reports a `project_trust` handler error, mirroring the SDK's
   * `onExtensionError`.
   */
  onExtensionError?: (message: string) => void;
}

/**
 * Run the `project_trust` event over a pre-trust extension set, mirroring
 * `emitProjectTrustEvent` in the SDK's `dist/core/extensions/runner.js`. That
 * helper is not part of the package's public exports (the main index exports
 * only the `ProjectTrust*` types and `ProjectTrustStore`, and the package's
 * `exports` map blocks subpath imports, so `resolveProjectTrusted`/
 * `emitProjectTrustEvent` are not callable from here), so PI WEB reimplements
 * its documented decision loop over the SDK-provided extension objects: per
 * extension, the registered `project_trust` handlers run in order; the first
 * handler returning `yes`/`no` decides and `undecided` falls through to the
 * next handler/extension; a throwing handler is collected as an error and
 * later handlers still get their chance.
 */
export async function emitWebProjectTrustEvent(
  extensionsResult: WebProjectTrustExtensionSet,
  event: ProjectTrustEvent,
  ctx: ProjectTrustContext,
): Promise<{ result?: ProjectTrustEventResult; errors: WebProjectTrustExtensionError[] }> {
  const errors: WebProjectTrustExtensionError[] = [];
  for (const extension of extensionsResult.extensions) {
    // A single extension may register multiple handlers for the same event.
    // The handlers map is keyed exactly as the extension registered it, so a
    // `project_trust` key guarantees `ProjectTrustHandler` entries — the same
    // assumption the SDK's emitProjectTrustEvent makes.
    const handlers = extension.handlers.get("project_trust");
    if (handlers === undefined || handlers.length === 0) continue;
    for (const handler of handlers) {
      try {
        const handlerResult: unknown = await handler(event, ctx);
        // The SDK reads `trusted` straight off the handler result, so a
        // non-object would throw there; PI WEB reports it as a handler error
        // and lets the next handler/extension try.
        if (typeof handlerResult !== "object" || handlerResult === null) {
          errors.push({ extensionPath: extension.path, error: "project_trust handler returned a non-object result" });
          continue;
        }
        const trusted = "trusted" in handlerResult ? handlerResult.trusted : undefined;
        if (trusted === "undecided") {
          continue;
        }
        // Rebuild the decision so only the documented `trusted`/`remember`
        // fields carry over — the SDK's resolver reads exactly those two.
        const remember = "remember" in handlerResult ? handlerResult.remember : undefined;
        return {
          result: {
            trusted: trusted === "yes" ? "yes" : "no",
            ...(remember === true ? { remember: true } : {}),
          },
          errors,
        };
      } catch (error) {
        errors.push({
          extensionPath: extension.path,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return { errors };
}

/**
 * PI WEB's headless project-trust context. `hasUI` is false because there is
 * no browser trust prompt (chartered behavior: `ask` never loads untrusted
 * resources), so the UI methods are inert — the same no-UI shape the SDK
 * passes when pi runs without a trust UI. The host mode is `rpc`, mirroring
 * how PI WEB binds its session extension contexts.
 */
function webProjectTrustContext(cwd: string): ProjectTrustContext {
  return {
    cwd,
    mode: "rpc",
    hasUI: false,
    ui: {
      select: () => Promise.resolve(undefined),
      confirm: () => Promise.resolve(false),
      input: () => Promise.resolve(undefined),
      notify: () => undefined,
    },
  };
}

/**
 * Resolve whether a workspace's project-local `.pi/` resources may load, the
 * way `pi` resolves it — a faithful mirror of the SDK's `resolveProjectTrusted`
 * (`dist/core/project-trust.js`, also not a public export). PI WEB has no
 * browser trust prompt, so the precedence is, in order:
 *
 * 1. Nothing trust-requiring under `cwd` → trusted.
 * 2. Pre-trust extensions (user/global — project-local ones are not loaded
 *    yet) may decide via the `project_trust` event; `remember: true` persists
 *    the decision to the agent dir's `trust.json`. Handler errors are reported
 *    through {@link WebProjectTrustResolution.onExtensionError} and never
 *    abort resolution.
 * 3. Otherwise the saved `trust.json` decision wins.
 * 4. Otherwise `defaultProjectTrust` decides (`always` trusts; `never`/`ask`
 *    do not — `ask` cannot prompt in the browser, matching `pi` run without a
 *    trust UI).
 */
export async function resolveWebProjectTrusted(resolution: WebProjectTrustResolution): Promise<boolean> {
  const { cwd, trustStore, settingsManager } = resolution;
  if (!hasTrustRequiringProjectResources(cwd)) return true;
  if (resolution.extensionsResult) {
    const { result, errors } = await emitWebProjectTrustEvent(
      resolution.extensionsResult,
      { type: "project_trust", cwd },
      webProjectTrustContext(cwd),
    );
    for (const error of errors) {
      resolution.onExtensionError?.(`Extension "${error.extensionPath}" project_trust error: ${error.error}`);
    }
    if (result) {
      const trusted = result.trusted === "yes";
      if (result.remember === true) {
        trustStore.set(cwd, trusted);
      }
      return trusted;
    }
  }
  const saved = trustStore.get(cwd);
  if (saved !== null) return saved;
  return settingsManager.getDefaultProjectTrust() === "always";
}

/**
 * Resource-loader options that append PI WEB's own system-prompt sections.
 *
 * `appendSystemPromptOverride` composes with what the loader already resolved,
 * so the operator's `SYSTEM.md` / `APPEND_SYSTEM.md` files keep their content
 * and PI WEB's sections land after them. Returns `undefined` when there is
 * nothing to append, leaving the loader exactly as pi configures it.
 */
export function piWebResourceLoaderOptions(
  appendSystemPromptSections: readonly string[],
): CreateAgentSessionServicesOptions["resourceLoaderOptions"] | undefined {
  if (appendSystemPromptSections.length === 0) return undefined;
  return { appendSystemPromptOverride: (base: string[]) => [...base, ...appendSystemPromptSections] };
}

function createDefaultRuntimeFactory(
  modelRuntime: ModelRuntime,
  sessionManagers: Pick<PiSessionManagerGateway, "open">,
  spawn?: SpawnSessionFn,
  subsessions?: SubsessionToolDeps,
  askUser?: AskUserToolDeps,
  appendSystemPromptSections: readonly string[] = [],
): PiWebCreateAgentSessionRuntimeFactory {
  const resourceLoaderOptions = piWebResourceLoaderOptions(appendSystemPromptSections);
  return async ({ cwd, agentDir, sessionManager, sessionStartEvent, initialModel, initialThinkingLevel, delegationToolsEnabled }) => {
    // PI WEB always honors pi's project-trust model. When the workspace ships
    // trust-requiring resources, trust is resolved exactly once, mirroring the
    // SDK's flow: the resource loader first loads the pre-trust extension set
    // (user/global; project-local ones stay out) and calls back with it, so
    // those extensions may decide via the `project_trust` event; the resolved
    // value then lands in the SettingsManager before any project-local
    // resource (extensions, packages, settings, prompts) loads. With no
    // browser trust prompt, an untrusted project's resources are skipped
    // (matching `pi` run without a UI). Projects without trust-requiring
    // resources skip resolution entirely and are trusted, as before.
    const projectTrustRequiring = hasTrustRequiringProjectResources(cwd);
    const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: !projectTrustRequiring });
    // Pre-session-creation trust failures (`project_trust` handler errors)
    // land in the runtime diagnostics next to the services diagnostics,
    // exactly as the CLI appends its project-trust diagnostics.
    const projectTrustDiagnostics: AgentSessionRuntimeDiagnostic[] = [];
    const services: AgentSessionServices = await createAgentSessionServices({
      cwd,
      agentDir,
      modelRuntime,
      settingsManager,
      ...(resourceLoaderOptions === undefined ? {} : { resourceLoaderOptions }),
      ...(projectTrustRequiring
        ? {
            resourceLoaderReloadOptions: {
              resolveProjectTrust: async ({ extensionsResult }) =>
                resolveWebProjectTrusted({
                  cwd,
                  trustStore: new ProjectTrustStore(agentDir),
                  settingsManager,
                  extensionsResult,
                  onExtensionError: (message) => projectTrustDiagnostics.push({ type: "warning", message }),
                }),
            },
          }
        : {}),
    });
    const modelOptions = await resolveSessionModelOptions({
      services,
      hasExistingSession: sessionManager.buildSessionContext().messages.length > 0,
      ...(initialModel === undefined ? {} : { initialModel }),
      ...(initialThinkingLevel === undefined ? {} : { initialThinkingLevel }),
    });
    services.diagnostics.push(...modelOptions.diagnostics);
    const resolvedDelegationToolsEnabled = delegationToolsEnabled
      ?? await sessionAllowsDelegationTools(sessionManager, sessionManagers);
    const customTools = createPiWebCustomToolDefinitions(cwd, resolvedDelegationToolsEnabled, spawn, subsessions, askUser);
    const result = await createAgentSessionFromServices({
      services,
      sessionManager,
      customTools,
      ...(sessionStartEvent === undefined ? {} : { sessionStartEvent }),
      ...(modelOptions.model === undefined ? {} : { model: modelOptions.model }),
      ...(modelOptions.thinkingLevel === undefined ? {} : { thinkingLevel: modelOptions.thinkingLevel }),
      ...(modelOptions.scopedModels.length === 0 ? {} : { scopedModels: modelOptions.scopedModels }),
    });
    return { ...result, services, diagnostics: [...projectTrustDiagnostics, ...services.diagnostics] };
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
   * When true (and `spawnTargets` is provided), the tracked-subsession
   * tools are available to sessions whose creation provenance permits
   * delegation. On by default; the operator opts out via config or environment.
   */
  subsessionsEnabled?: boolean;
  /**
   * When true, `ask_user` is available to every session, so an agent can post a
   * question set to the browser. Independent of the delegation capabilities: the
   * questions reach the user of the asking session, not another session.
   */
  askUserEnabled?: boolean;
  /**
   * Deployment facts appended to every session's system prompt, after the
   * operator's own pi prompt files. Empty in ordinary installs; sessiond fills
   * it with container environment facts in Docker deployments.
   */
  appendSystemPromptSections?: readonly string[];
  /** Daemon-lifetime open-ask state; defaults to an in-memory store in tests. */
  pendingAskStore?: PendingAskStore;
  /** Daemon-lifetime open-dialog state; defaults to an in-memory store in tests. */
  pendingExtensionDialogStore?: PendingExtensionDialogStore;
  /**
   * How long an extension dialog with no extension-set `timeout` waits for an
   * answer before the daemon auto-cancels it; `0` waits forever. A tuning
   * knob, not a gate: extension dialogs are always on.
   */
  extensionDialogsTimeoutMs?: number;
  /** Structured logger for notable runtime events (e.g. spawns). */
  logger?: PiSessionLogger;
  /** Clock seam for cleanup planning tests. */
  now?: () => Date;
  /** Daemon-lifetime notification state, injected by sessiond in production. */
  notificationStore?: SessionNotificationStore;
  /** Durable daemon-owned unread state; defaults to an in-memory store in tests. */
  unreadStore?: SessionUnreadStore;
  /** Initial retry delay for durable unread publication failures. */
  unreadPublicationRetryDelayMs?: number;
  /**
   * Called when unread state changed, so the machine status projection can
   * recompute. The unread catalog itself stays the authority for unread detail.
   */
  onUnreadChanged?: () => void;
  /**
   * Lets session startup report that provider model lists are refreshing while
   * a session is being constructed. Omit to report the startup phase alone.
   */
  catalogRefreshStatus?: CatalogRefreshStatus;
  /**
   * Live global config reader used to resolve workspace-effective request
   * defaults, currently the attachments save folder. Read at request time so
   * Settings edits apply without a daemon restart. When omitted, only the
   * project-local layer applies on top of the built-in defaults.
   */
  config?: Pick<PiWebConfigService, "read">;
}

export class PiSessionService implements SessionRouteService {
  private readonly active = new Map<string, ActiveSession<PiSessionRuntime>>();
  private readonly pendingSessionOpens = new Map<string, PendingSessionOpen>();
  /**
   * Sessions whose extension binding is still in flight. A `session_start`
   * dialog parks that window before the session ever becomes active, so this
   * is the only way the dialog answer/cancel and status paths can reach it;
   * {@link getOrOpen} never consults it, keeping every other operation gated
   * on full readiness.
   */
  private readonly startupSessions = new Map<string, PiAgentSession>();
  private readonly activities = new Map<string, { phase: "active" | "idle" | "error"; label: string; detail?: string; at: string }>();
  private readonly heartbeat: NodeJS.Timeout;
  private readonly commandService: SessionCommandService<PiAgentSession>;
  /** Runtime-identity gate held while Pi may await abandoned-branch summarization. */
  private readonly treeNavigations = new WeakSet<PiAgentSession>();
  /** Counts async operations that may append an entry before they settle. */
  private readonly sessionEntryMutationCounts = new WeakMap<PiAgentSession, number>();
  /** Settings-wide queue preventing enabled-model read/modify/write races across sessions. */
  private modelScopeMutationQueue: Promise<void> = Promise.resolve();
  /** Global and workspace-owned enabled-model states; live session scopes project one entry lazily. */
  private readonly modelScopeStates = new Map<string, ModelScopeSnapshot>();
  /** Coalesces initialization reads independently for the global and each workspace scope. */
  private readonly modelScopeInitializations = new Map<string, Promise<ModelScopeSnapshot>>();
  /** Monotonic revision published for global scope changes and consumed by clients. */
  private modelScopeRevision = 0;
  /** Last scope/catalog revision projected into each runtime, synchronized lazily on use. */
  private readonly modelScopeCache = new WeakMap<PiAgentSession, SessionModelScopeCache>();
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
  /** Last idle-poll transcript file resolution per runtime, throttled; entries die with their runtime. */
  private readonly idleSessionFileResolutions = new WeakMap<PiAgentSession, { at: number; path: string | undefined }>();
  private readonly unreadStore: SessionUnreadStore;
  private readonly pendingAskStore: PendingAskStore;
  private readonly pendingExtensionDialogStore: PendingExtensionDialogStore;
  private readonly extensionDialogsTimeoutMs: number;
  /** The parked extension Promise resolvers behind the store's open dialogs. */
  private readonly dialogWaiters = new ExtensionDialogWaiters();
  private readonly catalogRefreshStatus: CatalogRefreshStatus | undefined;
  private readonly config: Pick<PiWebConfigService, "read"> | undefined;
  private readonly unreadPublicationRetryInitialMs: number;
  private readonly onUnreadChanged: (() => void) | undefined;
  private readonly pendingUnreadMutations: SessionUnreadMutation[] = [];
  private unreadPublication: Promise<void> | undefined;
  private unreadPublicationFailure: unknown;
  private unreadPublicationFlushRequested = false;
  private unreadPublicationRetryTimer: NodeJS.Timeout | undefined;
  private unreadPublicationRetryDelayMs: number;
  private unreadPublicationStopped = false;

  constructor(private readonly events: SessionEventHub, deps: PiSessionServiceDependencies) {
    this.archiveStore = deps.archiveStore ?? new SessionArchiveStore();
    this.agentDir = deps.agentDir;
    this.sessionManager = deps.sessionManager;
    this.modelRuntime = deps.modelRuntime;
    this.spawnTargets = deps.spawnTargets;
    this.logger = deps.logger ?? noopLogger;
    this.now = deps.now ?? (() => new Date());
    this.notificationStore = deps.notificationStore ?? new SessionNotificationStore();
    this.unreadStore = deps.unreadStore ?? new SessionUnreadStore();
    this.onUnreadChanged = deps.onUnreadChanged;
    this.pendingAskStore = deps.pendingAskStore ?? new PendingAskStore();
    this.pendingExtensionDialogStore = deps.pendingExtensionDialogStore ?? new PendingExtensionDialogStore();
    this.extensionDialogsTimeoutMs = deps.extensionDialogsTimeoutMs ?? DEFAULT_EXTENSION_DIALOGS_TIMEOUT_MS;
    this.catalogRefreshStatus = deps.catalogRefreshStatus;
    this.config = deps.config;
    this.unreadPublicationRetryInitialMs = Math.max(
      0,
      deps.unreadPublicationRetryDelayMs ?? DEFAULT_UNREAD_PUBLICATION_RETRY_MS,
    );
    this.unreadPublicationRetryDelayMs = this.unreadPublicationRetryInitialMs;
    // Subsessions are gated behind their own flag, and they
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
      deps.askUserEnabled === true ? { open: (input) => this.openAsk(input) } : undefined,
      deps.appendSystemPromptSections ?? [],
    );
    this.createAgentRuntime = deps.createAgentRuntime ?? defaultCreateAgentRuntime;
    this.workspaceActivity = deps.workspaceActivity;
    this.heartbeat = setInterval(() => { this.publishHeartbeats(); }, deps.heartbeatIntervalMs ?? 2000);
    this.commandService = new SessionCommandService(
      (sessionId) => this.getActive(this.activeSessionRef(sessionId)),
      (sessionId, text) => this.prompt(this.activeSessionRef(sessionId), text, undefined, undefined, { echoUserMessage: false }),
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

  async unreadCatalog(): Promise<SessionUnreadCatalogSnapshot> {
    await this.publishUnreadMutations([]);
    return this.unreadStore.durableCatalogSnapshot();
  }

  async acknowledgeUnread(sessionId: string, request: SessionUnreadAcknowledgeRequest): Promise<SessionUnreadCatalogSnapshot> {
    const result = this.unreadStore.acknowledge(sessionId, {
      ...request,
      cwd: canonicalizeStoredCwd(request.cwd),
    });
    await this.publishUnreadMutations(result.mutations);
    return this.unreadStore.durableCatalogSnapshot();
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
    await this.forgetUnreadSessions(readyArchiveInputs);

    for (const record of plan.deleteRecords) {
      if (this.activeSessionHasWork(record.sessionId)) {
        skippedBusySessionIds.add(record.sessionId);
        continue;
      }
      await this.closeActive(record.sessionId, { kind: "clear", reason: "delete" });
      readyDeleteRecords.push(record);
    }
    const deletedSessionIds = new Set(await this.archiveStoreDeleteArchivedMany(readyDeleteRecords.map((record) => record.sessionId)));
    deleteRecords.push(...readyDeleteRecords.filter((record) => deletedSessionIds.has(record.sessionId)));
    await this.forgetUnreadSessions(deleteRecords);

    return summarizeSessionCleanupExecution({
      archiveInputs,
      deleteRecords,
      thresholds: plan.thresholds,
      generatedAt: plan.generatedAt,
      skippedBusySessionIds: [...skippedBusySessionIds],
    });
  }

  async dispose(): Promise<void> {
    this.unreadPublicationStopped = true;
    this.clearUnreadPublicationRetry();
    clearInterval(this.heartbeat);
    this.clearCompactionDrainTimers();
    // Same startup-park hazard as closeActive(): settle `session_start` dialogs
    // of sessions still binding extensions before awaiting their pending opens.
    for (const sessionId of this.startupSessions.keys()) this.endSessionExtensionDialogs(sessionId);
    const pendingOpens = this.pendingSessionOpenPromises();
    if (pendingOpens.length > 0) await Promise.allSettled(pendingOpens);
    const activeSessions = Array.from(new Set(this.active.values()));
    for (const active of activeSessions) {
      this.forgetUnreadActivity(active.runtime.session);
      this.pendingAskStore.forgetSession(active.runtime.session.sessionId);
      this.endSessionExtensionDialogs(active.runtime.session.sessionId);
    }
    this.active.clear();
    this.pendingSessionOpens.clear();
    this.startupSessions.clear();
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
    await this.publishUnreadMutations([]);
  }

  async list(cwd: string): Promise<ClientSession[]> {
    const [sessions, archivedRecords] = await Promise.all([this.sessionManager.list(cwd), this.archiveStore.list()]);
    const sessionsById = new Map(sessions.map((session) => [session.id, session]));
    const archivedForCwd = archivedRecords.filter((record) => record.cwd === cwd);
    const archivedById = new Map(archivedForCwd.map((record) => [record.sessionId, record]));
    for (const record of archivedForCwd) {
      this.publishNotificationMutations(this.notificationStore.clearSession(record.sessionId, "archive-reconcile"));
    }
    const unarchivedSessions = sessions.filter((session) => !archivedById.has(session.id)).map(clientSessionFromListEntry);
    const reconcilableSessionIds = this.reconcilableSessionIds(cwd, unarchivedSessions.map((session) => session.id), archivedById);
    this.workspaceActivity?.reconcileSessionActivity(cwd, reconcilableSessionIds);
    await this.publishUnreadMutations(this.unreadStore.reconcileCwd(canonicalizeStoredCwd(cwd), reconcilableSessionIds));
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
        startupIntent: "create",
        ...(options.startupToken === undefined ? {} : { startupToken: options.startupToken }),
        ...(options.initialModel === undefined ? {} : { initialModel: options.initialModel }),
        ...(options.initialThinkingLevel === undefined ? {} : { initialThinkingLevel: options.initialThinkingLevel }),
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
    // A model spec overrides the inherited model. Only a spec resolves
    // against the spawning session; the default path must not depend on it.
    const model = input.modelSpec === undefined
      ? input.model
      : await this.resolveSpawnModel({ id: input.spawningSessionId, cwd: input.spawningCwd }, input.modelSpec);
    const created = await this.start(decision.cwd, {
      ...(model === undefined ? {} : { initialModel: model }),
      ...(input.thinkingLevel === undefined ? {} : { initialThinkingLevel: input.thinkingLevel }),
    });
    const modelUsed = this.active.get(created.id)?.runtime.session.model;
    await this.prompt(created, input.prompt);
    this.logger.info(
      { spawningCwd: input.spawningCwd, sessionId: created.id, cwd: decision.cwd, promptLength: input.prompt.length },
      "spawn_session started a new session",
    );
    return {
      sessionId: created.id,
      cwd: decision.cwd,
      ...(modelUsed === undefined ? {} : { model: modelSpecOf(modelUsed) }),
    };
  }

  /**
   * Start a *tracked* child session on behalf of a LLM. Unlike
   * {@link spawnSession}, a tracked child always runs in the parent's own
   * workspace: parent/child trees are worktree-scoped, so a child elsewhere
   * would be invisible to the parent's listing. The child records its parent
   * (so it shows in the session tree) and is registered so the parent is
   * notified when it stops working and can inspect it later.
   */
  async spawnSubsession(input: SpawnSubsessionInvocation): Promise<SpawnSubsessionResult> {
    if (this.spawnTargets === undefined) throw new Error("Spawning sessions is disabled");
    if (input.cwd !== undefined && input.cwd !== "" && !cwdPathsEqual(input.cwd, input.spawningCwd)) {
      throw subsessionCwdError(input.spawningCwd, input.cwd);
    }
    // Resolved against the parent's own cwd only: this still refuses spawning
    // from an unregistered directory, which keeps the child visible in the UI.
    const decision = await this.spawnTargets.resolveSpawnTarget(input.spawningCwd, undefined);
    if (!decision.allowed) throw spawnTargetError(decision);
    // A model spec overrides the inherited model and is resolved against the
    // parent's model runtime; only a spec resolves against the parent.
    const model = input.modelSpec === undefined
      ? input.model
      : await this.resolveSpawnModel({ id: input.parentSessionId, cwd: input.spawningCwd }, input.modelSpec);
    const created = await this.startSession(decision.cwd, {
      ...(input.parentSessionFile === undefined ? {} : { parentSession: input.parentSessionFile }),
      ...(model === undefined ? {} : { initialModel: model }),
      ...(input.thinkingLevel === undefined ? {} : { initialThinkingLevel: input.thinkingLevel }),
      creationProvenance: "tracked-subsession",
    });
    const modelUsed = this.active.get(created.id)?.runtime.session.model;
    const parentSessionFile = nonEmptyString(input.parentSessionFile);
    const link: TrackedSubsessionLink = {
      parentSessionId: input.parentSessionId,
      childSessionId: created.id,
      ...(created.path === "" ? {} : { childSessionFile: created.path }),
      ...(parentSessionFile === undefined ? {} : { parentSessionFile }),
      cwd: decision.cwd,
    };
    await this.registerVerifiedSubsession(link);
    this.persistSubsessionLink(link);
    this.persistSubsessionChildMarker(input.parentSessionId, created.id);
    await this.prompt(created, input.prompt);
    this.logger.info(
      { parentSessionId: input.parentSessionId, sessionId: created.id, cwd: decision.cwd, promptLength: input.prompt.length },
      "spawn_subsession started a tracked child session",
    );
    return {
      sessionId: created.id,
      cwd: decision.cwd,
      ...(modelUsed === undefined ? {} : { model: modelSpecOf(modelUsed) }),
    };
  }

  /**
   * Resolve the settings domain for a session. Pi's settings manager deep-merges
   * objects, but an `enabledModels` array in `.pi/settings.json` replaces the
   * global array, so that workspace gets its own effective scope and is not
   * affected by global picker edits.
   */
  private modelScopeContext(session: PiAgentSession): ModelScopeContext {
    const projectSettings = session.settingsManager.getProjectSettings?.() ?? {};
    if (!Object.hasOwn(projectSettings, "enabledModels")) {
      return { key: "global", source: "global", editable: true };
    }
    const workspace = canonicalizeStoredCwd(session.sessionManager.getCwd());
    return { key: `workspace:${workspace}`, source: "workspace", editable: false };
  }

  /**
   * Read the effective scope for one settings domain. Global sessions share one
   * snapshot; project-overridden sessions share a snapshot keyed by workspace.
   * Neither path enumerates or mutates other active sessions.
   */
  private async modelScopeSnapshot(session: PiAgentSession, context = this.modelScopeContext(session)): Promise<ModelScopeSnapshot> {
    const existing = this.modelScopeStates.get(context.key);
    if (existing !== undefined) return existing;
    const pending = this.modelScopeInitializations.get(context.key);
    if (pending !== undefined) return pending;
    const initialization = (async () => {
      const enabledIds = await resolveEnabledModelIds(sessionScopeSource(session));
      const snapshot: ModelScopeSnapshot = {
        enabledIds: enabledIds === null ? null : [...enabledIds],
        revision: 0,
      };
      this.modelScopeStates.set(context.key, snapshot);
      return snapshot;
    })();
    this.modelScopeInitializations.set(context.key, initialization);
    try {
      return await initialization;
    } finally {
      if (this.modelScopeInitializations.get(context.key) === initialization) this.modelScopeInitializations.delete(context.key);
    }
  }

  /**
   * Project one settings-domain scope into one SDK session only when that
   * session is used. `PiAgentSession` needs an in-memory array for cycling, but
   * that array is a cache; the keyed snapshot above is the source of truth.
   */
  private async synchronizeSessionModelScope(session: PiAgentSession, available: readonly AgentModel[]): Promise<void> {
    const context = this.modelScopeContext(session);
    const snapshot = await this.modelScopeSnapshot(session, context);
    const catalogKey = available.map(modelScopeId).join("\0");
    const cached = this.modelScopeCache.get(session);
    if (cached?.scopeKey === context.key && cached.revision === snapshot.revision && cached.catalogKey === catalogKey) return;
    session.setScopedModels(scopedModelsFromEnabledIds(available, snapshot.enabledIds, session.scopedModels));
    this.modelScopeCache.set(session, { scopeKey: context.key, revision: snapshot.revision, catalogKey });
  }

  /**
   * The models a session may pick from: its synchronized scoped set when
   * model-scoped, otherwise the runtime's available snapshot. Refreshes the
   * shared runtime catalog first so callers see newly configured providers and
   * models. The refresh stays local (`allowNetwork: false`); network refreshes
   * belong to the bounded background catalog refresher, not this request path.
   */
  private async sessionModelCandidates(session: PiAgentSession): Promise<readonly AgentModel[]> {
    await session.modelRuntime.refresh({ allowNetwork: false });
    const available = session.modelRuntime.getAvailableSnapshot();
    await this.synchronizeSessionModelScope(session, available);
    return session.scopedModels.length > 0
      ? session.scopedModels.map((scoped) => scoped.model)
      : available;
  }

  /**
   * The session machine's full available catalog with per-model enabled state,
   * ordered enabled-first for scope semantics while retaining each model's
   * natural catalog index for stable picker placement. The enabled state comes
   * from the keyed scope snapshot rather than a session-local SettingsManager.
   */
  private async enabledModelCatalog(session: PiAgentSession): Promise<EnabledModelCatalogEntry<AgentModel>[]> {
    await session.modelRuntime.refresh({ allowNetwork: false });
    const available = session.modelRuntime.getAvailableSnapshot();
    await this.synchronizeSessionModelScope(session, available);
    const context = this.modelScopeContext(session);
    const enabledIds = (await this.modelScopeSnapshot(session, context)).enabledIds;
    return catalogWithEnabledFirst(available, enabledIds);
  }

  private runModelScopeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.modelScopeMutationQueue.then(operation);
    this.modelScopeMutationQueue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  /** Persist one global enabled-model selection and publish its new revision. */
  private applyEnabledModelScope(
    session: PiAgentSession,
    available: readonly AgentModel[],
    enabledIds: readonly string[] | null,
  ): void {
    const availableIds = available.map(modelScopeId);
    const persisted = persistedEnabledModelPatterns(enabledIds, availableIds);
    const nextState: ModelScopeSnapshot = {
      // Pi normalizes a scope covering the complete current catalog to an
      // omitted setting, which is the global canonical all-enabled state.
      enabledIds: persisted === undefined ? null : enabledIds === null ? [] : [...enabledIds],
      revision: ++this.modelScopeRevision,
    };
    session.settingsManager.setEnabledModels(persisted);
    this.modelScopeStates.set("global", nextState);
    session.setScopedModels(scopedModelsFromEnabledIds(available, nextState.enabledIds, session.scopedModels));
    this.modelScopeCache.set(session, {
      scopeKey: "global",
      revision: nextState.revision,
      catalogKey: available.map(modelScopeId).join("\0"),
    });
    this.events.publishGlobal({ type: "models.changed", revision: nextState.revision });
  }

  /**
   * Resolve a strict `provider/model-id` spec from a spawn tool against the
   * *spawning* session's model runtime, using the same candidates
   * {@link setModel} offers plus a direct runtime lookup as fallback. Unknown
   * or malformed specs throw; the agent loop turns that into an error tool
   * result the spawning agent can retry from.
   */
  private async resolveSpawnModel(spawningRef: PiSessionRef, modelSpec: string): Promise<AgentModel> {
    const session = await this.getOrOpen(spawningRef);
    const parsed = parseModelSpec(modelSpec);
    const candidates = await this.sessionModelCandidates(session);
    const model = parsed === undefined
      ? undefined
      : candidates.find((candidate) => candidate.provider === parsed.provider && candidate.id === parsed.modelId)
        ?? session.modelRuntime.getModel(parsed.provider, parsed.modelId);
    if (model === undefined) throw unknownSpawnModelError(modelSpec);
    return model;
  }

  /**
   * Register the question set an agent wants the user to answer as the session's
   * open ask. Deliberately does not wait for the user: `ask_user` terminates the
   * run and the submitted answers come back later as a follow-up message.
   *
   * Rejected question sets throw {@link PendingAskValidationError}, which the
   * agent loop reports to the model as an error tool result.
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- async so a rejected question set becomes a rejection rather than a synchronous throw from a promise-returning method.
  async openAsk(input: AskUserInvocation): Promise<PendingAskOpenResult> {
    const result = this.pendingAskStore.open(input);
    // A supersede closes the earlier ask, so the browsers watching it must hear
    // that before they hear about its replacement.
    if (result.superseded !== undefined) this.publishAskClosed(input.sessionId, result.superseded);
    this.events.publish(input.sessionId, { type: "ask.opened", ask: result.ask });
    this.publishStatusForSessionId(input.sessionId);
    return result;
  }

  /**
   * Record the user's answers to the session's open ask and hand them to the
   * model. The answers travel as a system-authored custom message rather than a
   * user message, so they are not attributed to the human in the transcript;
   * they still wake an idle session (`triggerTurn`) and queue behind in-flight
   * work (`deliverAs: "followUp"`), which is how the run that `ask_user`
   * terminated continues.
   */
  async submitAsk(ref: PiSessionRef, askId: string, submission: AskUserSubmission): Promise<AskUserCloseResponse> {
    await this.assertWritable(ref);
    const session = await this.getOrOpen(ref);
    // Checked before the store closes the ask so a refused delivery cannot
    // discard answers the user already submitted.
    this.assertTreeNavigationInactive(session, "answer questions");
    return this.closeAsk(session, this.pendingAskStore.submit(session.sessionId, askId, submission));
  }

  /**
   * Close the open ask without answers. The model is still told, naming every
   * question as unanswered: it was promised a follow-up message and would
   * otherwise wait for one that never comes.
   */
  async cancelAsk(ref: PiSessionRef, askId: string): Promise<AskUserCloseResponse> {
    await this.assertWritable(ref);
    const session = await this.getOrOpen(ref);
    this.assertTreeNavigationInactive(session, "dismiss questions");
    return this.closeAsk(session, this.pendingAskStore.cancel(session.sessionId, askId));
  }

  /**
   * Publish and deliver a closed ask. A stale close is reported rather than
   * thrown: losing the race against a supersede, another browser, or a session
   * that went away is ordinary, and the returned status tells the browser what
   * the session's open ask is now.
   */
  private async closeAsk(session: PiAgentSession, result: PendingAskCloseResult): Promise<AskUserCloseResponse> {
    if (result.status === "stale") return { result: "stale", sessionStatus: this.statusFromSession(session) };
    const { outcome } = result;
    this.publishAskClosed(session.sessionId, outcome);
    await this.runSessionEntryMutation(session, "deliver answers to your questions", () => session.sendCustomMessage(
      { customType: ASK_USER_ANSWERS_CUSTOM_TYPE, content: renderAskUserAnswersText(outcome), display: true, details: outcome },
      { triggerTurn: true, deliverAs: "followUp" },
    ));
    this.publishStatus(session);
    return { result: "closed", outcome, sessionStatus: this.statusFromSession(session) };
  }

  private publishAskClosed(sessionId: string, outcome: AskUserOutcome): void {
    this.events.publish(sessionId, { type: "ask.closed", askId: outcome.askId, reason: outcome.reason });
  }

  /**
   * Void the session's open ask because the user sent a chat message instead of
   * answering it. Every browser closes the card as cancelled, and the model is
   * told — without being woken — so the notice rides into the turn the message
   * itself triggers rather than becoming a turn of its own.
   */
  private async voidOpenAskForUserMessage(session: PiAgentSession): Promise<void> {
    const outcome = this.pendingAskStore.cancelOpen(session.sessionId);
    if (outcome === undefined) return;
    this.publishAskClosed(session.sessionId, outcome);
    await this.runSessionEntryMutation(session, "void the open questions", () => session.sendCustomMessage(
      { customType: ASK_USER_ANSWERS_CUSTOM_TYPE, content: renderAskUserAnswersText(outcome), display: true, details: outcome },
      { triggerTurn: false, deliverAs: "followUp" },
    ));
    this.publishStatus(session);
  }

  /**
   * Record the user's answer to an open extension dialog and resolve the
   * extension's parked Promise with it. Unlike an ask, nothing is delivered to
   * the model: the waiter is extension code inside an already in-flight run
   * (or an idle handler), so no custom message and no turn are triggered.
   */
  async answerDialog(ref: PiSessionRef, dialogId: string, value: ExtensionDialogAnswer): Promise<ExtensionDialogCloseResponse> {
    await this.assertWritable(ref);
    const session = await this.sessionForStatusOrDialogClose(ref);
    const result = this.pendingExtensionDialogStore.answer(session.sessionId, dialogId, value);
    if (result.status === "stale") return { result: "stale", sessionStatus: this.statusFromSession(session) };
    const { outcome } = result;
    this.publishDialogClosed(session.sessionId, outcome);
    // `value` is what the store validated and recorded as the outcome's answer.
    this.dialogWaiters.settleWithAnswer(dialogId, value);
    this.publishStatus(session);
    return { result: "closed", outcome, sessionStatus: this.statusFromSession(session) };
  }

  /** Close an open extension dialog without an answer; the extension's wait settles with its kind's cancel value. */
  async cancelDialog(ref: PiSessionRef, dialogId: string): Promise<ExtensionDialogCloseResponse> {
    await this.assertWritable(ref);
    const session = await this.sessionForStatusOrDialogClose(ref);
    const result = this.pendingExtensionDialogStore.cancel(session.sessionId, dialogId, "cancelled");
    if (result.status === "stale") return { result: "stale", sessionStatus: this.statusFromSession(session) };
    const { outcome } = result;
    this.publishDialogClosed(session.sessionId, outcome);
    this.dialogWaiters.settleWithCancelValue(dialogId);
    this.publishStatus(session);
    return { result: "closed", outcome, sessionStatus: this.statusFromSession(session) };
  }

  /**
   * Implement one `ctx.ui.select()`/`confirm()`/`input()` call from extension
   * code: open the store record, tell the browsers, and park a Promise that
   * settles when the browser answers or cancels, the extension's own
   * `signal`/`timeout` dismisses the dialog, the daemon default timeout
   * elapses, or the runtime goes away. `store.open` validates the dialog, so a
   * malformed one rejects the extension's call rather than rendering garbage.
   * `async` so a rejected dialog becomes a rejection rather than a synchronous
   * throw from a promise-returning method.
   */
  private async openExtensionDialog(
    session: PiAgentSession,
    request: { kind: ExtensionDialogKind; title: string; message?: string | undefined; options?: string[] | undefined; placeholder?: string | undefined },
    opts: ExtensionUIDialogOptions | undefined,
  ): Promise<boolean | string | undefined> {
    const signal = opts?.signal;
    // A pre-aborted signal dismisses the dialog before it ever opens.
    if (signal?.aborted === true) return extensionDialogCancelValue(request.kind);
    const timeoutMs = effectiveExtensionDialogTimeoutMs(opts?.timeout, this.extensionDialogsTimeoutMs);
    const dialog = this.pendingExtensionDialogStore.open({
      sessionId: session.sessionId,
      kind: request.kind,
      title: request.title,
      ...(request.message === undefined ? {} : { message: request.message }),
      ...(request.options === undefined ? {} : { options: request.options }),
      ...(request.placeholder === undefined ? {} : { placeholder: request.placeholder }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      runScoped: session.isStreaming,
    });
    this.events.publish(session.sessionId, { type: "dialog.opened", dialog });
    this.publishStatus(session);
    return this.dialogWaiters.park(dialog, {
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(signal === undefined ? {} : { signal }),
      onTrigger: (reason) => {
        if (this.closeExtensionDialogFromTrigger(session.sessionId, dialog.dialogId, reason)) this.publishStatusForSessionId(session.sessionId);
      },
    });
  }

  /**
   * Close a dialog whose wait ended without the browser (timeout, signal
   * abort, run end, runtime teardown) and settle its parked Promise. Returns
   * whether this call closed the dialog; a stale close means a browser answer
   * or an earlier trigger already settled everything.
   */
  private closeExtensionDialogFromTrigger(sessionId: string, dialogId: string, reason: ExtensionDialogCancelReason): boolean {
    const result = this.pendingExtensionDialogStore.cancel(sessionId, dialogId, reason);
    if (result.status !== "closed") return false;
    this.publishDialogClosed(sessionId, result.outcome);
    this.dialogWaiters.settleWithCancelValue(dialogId);
    return true;
  }

  /**
   * Settle the session's run-scoped dialogs as `"aborted"`. Runs at
   * abort-request time (a user abort parks the agent loop behind the dialog
   * handler, so `agent_end` would never arrive on its own) and again from
   * the `agent_end` observer as the run-crash backstop — the store makes the
   * second settlement a stale no-op. Idle-opened dialogs (a `session_start`
   * probe, say) are not run-scoped and survive, because their waiter
   * outlives the run.
   */
  private abortRunScopedExtensionDialogs(sessionId: string): void {
    let closedAny = false;
    for (const dialog of this.pendingExtensionDialogStore.pendingDialogs(sessionId)) {
      if (dialog.runScoped) closedAny = this.closeExtensionDialogFromTrigger(sessionId, dialog.dialogId, "aborted") || closedAny;
    }
    if (closedAny) this.publishStatusForSessionId(sessionId);
  }

  /**
   * Settle every dialog of the session as `"session-ended"`: the runtime
   * whose extension code is parked on them is being closed, replaced, or
   * disposed, so those Promises would otherwise never settle.
   */
  private endSessionExtensionDialogs(sessionId: string): void {
    let closedAny = false;
    for (const dialog of this.pendingExtensionDialogStore.pendingDialogs(sessionId)) {
      closedAny = this.closeExtensionDialogFromTrigger(sessionId, dialog.dialogId, "session-ended") || closedAny;
    }
    // Publishes only while the session is still (or already re-)registered as
    // active, so teardown paths stay silent and runtime replacement refreshes.
    if (closedAny) this.publishStatusForSessionId(sessionId);
  }

  private publishDialogClosed(sessionId: string, outcome: ExtensionDialogOutcome): void {
    this.events.publish(sessionId, {
      type: "dialog.closed",
      dialogId: outcome.dialogId,
      reason: outcome.reason,
      ...(outcome.answer === undefined ? {} : { answer: outcome.answer }),
    });
  }

  /**
   * Publish status for a session known only by id, as the ask tools are: they
   * run inside the session's own runtime, so the active entry is the session.
   */
  private publishStatusForSessionId(sessionId: string): void {
    const session = this.active.get(sessionId)?.runtime.session;
    if (session !== undefined) this.publishStatus(session);
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

  private async registerVerifiedSubsession(link: TrackedSubsessionLink): Promise<void> {
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

    const cwd = this.cwdForVerifiedSubsession(link);
    await this.publishUnreadMutations(this.unreadStore.excludeSession(childSessionId, cwd));
  }

  private cwdForVerifiedSubsession(link: TrackedSubsessionLink): string {
    const activeCwd = this.activeChildForSubsessionLink(link)?.runtime.session.sessionManager.getCwd();
    const linkedCwd = nonEmptyString(activeCwd) ?? nonEmptyString(link.cwd);
    if (linkedCwd !== undefined) return canonicalizeStoredCwd(linkedCwd);

    const childSessionFile = link.childSessionFile;
    if (childSessionFile !== undefined) {
      try {
        return canonicalizeStoredCwd(this.sessionManager.open(childSessionFile).getCwd());
      } catch (error: unknown) {
        throw new Error("Could not resolve cwd for verified tracked sub-session", { cause: error });
      }
    }
    throw new Error("Could not resolve cwd for verified tracked sub-session");
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
      const complete = await this.registerPersistedSubsessionLinks(
        parentSessionId,
        activeParent.runtime.session.sessionManager,
        activeParentFile,
      );
      if (complete) this.subsessionHydratedParents.add(hydrationKey);
      return;
    }

    if (parentSessionFile === undefined) return;
    if ((await readSessionHeaderSummary(parentSessionFile))?.id !== parentSessionId) return;

    let parentManager: PiSessionManager;
    try {
      parentManager = this.sessionManager.open(parentSessionFile);
    } catch {
      return;
    }
    const complete = await this.registerPersistedSubsessionLinks(parentSessionId, parentManager, parentSessionFile);
    if (complete) this.subsessionHydratedParents.add(hydrationKey);
  }

  private async registerPersistedSubsessionLinks(parentSessionId: string, parentManager: PiSessionManager, parentSessionFile: string | undefined): Promise<boolean> {
    // Parent custom links are the authoritative recovery record: verify the
    // exact live child file/header before tracking. Do not negatively cache a
    // scan while a candidate child is temporarily unavailable.
    const entries = parentManager.getEntries?.() ?? parentManager.getBranch();
    let complete = true;
    for (const entry of entries) {
      const link = parsePersistedParentSubsessionLink(entry);
      if (link?.spawnedBySessionId !== parentSessionId) continue;
      const verified = await this.verifiedSubsessionLinkFromParentLink(parentSessionId, parentSessionFile, link);
      if (verified === undefined) {
        complete = false;
        continue;
      }
      await this.registerVerifiedSubsession(verified);
    }
    return complete;
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
    await this.registerVerifiedSubsession(link);
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

  async messages(ref: PiSessionRef, page?: { before?: number; limit?: number }): Promise<ClientMessagePage> {
    const session = await this.getOrOpen(ref);
    return pageMessagesAtSafeBoundary(historyMessagesFromEntries(await this.readableSessionBranch(ref, session)), page);
  }

  async status(ref: PiSessionRef): Promise<ClientSessionStatus> {
    const session = await this.sessionForStatusOrDialogClose(ref);
    if (this.hasActiveWork(session)) return this.statusFromSession(session);
    const branch = await this.readableSessionBranch(ref, session);
    return this.statusFromSession(session, transcriptMessageCount(branch));
  }

  /**
   * Join-time snapshot of the in-flight assistant stream. The `seq` watermark and
   * the partial are read together in one synchronous tick (no await between the
   * `currentSeq` read and the `state.streamingMessage` read) so a joining client
   * can seed the partial and then apply only buffered live events with
   * `seq > snapshot.seq`. The partial is browser-projected to strip thinking
   * signatures; it is `null` when no assistant message is mid-stream.
   */
  async streamSnapshot(ref: PiSessionRef): Promise<SessionStreamSnapshot> {
    const session = await this.getOrOpen(ref);
    // Single consistent tick: capture the watermark and the partial together so
    // the seq matches the partial the client seeds against.
    const seq = this.events.currentSeq(session.sessionId);
    const streamingMessage = session.state.streamingMessage;
    const partial = streamingMessage === undefined || streamingMessage === null
      ? null
      : annotateAssistantThinkingLevel(projectBrowserMessage(streamingMessage), session.thinkingLevel);
    return { seq, partial };
  }

  async availableModels(ref: PiSessionRef): Promise<ClientSessionModel[]> {
    const session = await this.getOrOpen(ref);
    const models = await this.sessionModelCandidates(session);
    return models.map(modelToClientModel);
  }

  async modelCatalog(ref: PiSessionRef): Promise<ClientSessionModelCatalogEntry[]> {
    const session = await this.getOrOpen(ref);
    const scope = this.modelScopeContext(session);
    return (await this.enabledModelCatalog(session)).map((entry) => catalogEntryToClientModel(entry, scope.editable));
  }

  /**
   * Add/remove one model to/from the global pi `enabledModels` scope. A
   * workspace `.pi/settings.json` override remains authoritative for that
   * workspace and is intentionally read-only in this picker.
   */
  async setModelEnabled(ref: PiSessionRef, provider: string, modelId: string, enabled: boolean): Promise<ClientSessionModelCatalogEntry[]> {
    await this.assertWritable(ref);
    const session = await this.getOrOpen(ref);
    return this.runModelScopeMutation(async () => {
      const scope = this.modelScopeContext(session);
      if (scope.source !== "global") throw new Error("Model availability is controlled by this workspace's .pi/settings.json");
      this.assertTreeNavigationInactive(session, "change enabled models");
      await session.modelRuntime.refresh({ allowNetwork: false });
      const currentIds = (await this.modelScopeSnapshot(session, scope)).enabledIds;
      const available = session.modelRuntime.getAvailableSnapshot();
      const availableIds = available.map(modelScopeId);
      const targetId = `${provider}/${modelId}`;
      if (!availableIds.includes(targetId)) throw new Error(`Model not found: ${targetId}`);
      if (!enabled && session.model !== undefined && modelScopeId(session.model) === targetId) {
        throw new Error("Current model cannot be disabled");
      }
      const nextIds = applyEnabledModelToggle(currentIds, availableIds, targetId, enabled);
      this.assertTreeNavigationInactive(session, "change enabled models");
      if (nextIds !== currentIds) this.applyEnabledModelScope(session, available, nextIds);
      // Respond from a fresh post-edit read so the response is exactly what
      // GET models/catalog returns after the edit, including pi's normalizations.
      return (await this.enabledModelCatalog(session)).map((entry) => catalogEntryToClientModel(entry));
    });
  }

  /** Atomically expose every model or narrow the global enabled scope to the current model. */
  async setModelScope(ref: PiSessionRef, mode: SessionModelScopeMode): Promise<ClientSessionModelCatalogEntry[]> {
    await this.assertWritable(ref);
    const session = await this.getOrOpen(ref);
    return this.runModelScopeMutation(async () => {
      const scope = this.modelScopeContext(session);
      if (scope.source !== "global") throw new Error("Model availability is controlled by this workspace's .pi/settings.json");
      this.assertTreeNavigationInactive(session, "change enabled models");
      await session.modelRuntime.refresh({ allowNetwork: false });
      const available = session.modelRuntime.getAvailableSnapshot();
      const availableIds = available.map(modelScopeId);
      let nextIds: readonly string[] | null = null;
      if (mode === "current") {
        const current = session.model;
        if (current === undefined || !availableIds.includes(modelScopeId(current))) {
          throw new Error("Current model is unavailable");
        }
        nextIds = [modelScopeId(current)];
      }
      this.assertTreeNavigationInactive(session, "change enabled models");
      this.applyEnabledModelScope(session, available, nextIds);
      return (await this.enabledModelCatalog(session)).map((entry) => catalogEntryToClientModel(entry));
    });
  }

  async setModel(ref: PiSessionRef, provider: string, modelId: string): Promise<ClientSessionStatus> {
    await this.assertWritable(ref);
    const session = await this.getOrOpen(ref);
    this.assertTreeNavigationInactive(session, "change models");
    const candidates = await this.sessionModelCandidates(session);
    this.assertTreeNavigationInactive(session, "change models");
    const model = candidates.find((candidate) => candidate.provider === provider && candidate.id === modelId)
      ?? session.modelRuntime.getModel(provider, modelId);
    if (model === undefined) throw new Error(`Model not found: ${provider}/${modelId}`);
    await this.runSessionEntryMutation(session, "change models", () => session.setModel(model));
    this.publishActivity(session, `model: ${model.id}`, "idle", model.provider);
    this.publishStatus(session);
    return this.statusFromSession(session);
  }

  async cycleModel(ref: PiSessionRef, direction: "forward" | "backward"): Promise<ClientSessionStatus> {
    await this.assertWritable(ref);
    const session = await this.getOrOpen(ref);
    const result = await this.runModelScopeMutation(async () => {
      await session.modelRuntime.refresh({ allowNetwork: false });
      await this.synchronizeSessionModelScope(session, session.modelRuntime.getAvailableSnapshot());
      return this.runSessionEntryMutation(session, "change models", () => session.cycleModel(direction));
    });
    if (result === undefined) throw new Error(session.scopedModels.length > 0 ? "Only one model in scope" : "Only one model available");
    this.publishActivity(session, `model: ${result.model.id}`, "idle", result.model.provider);
    this.publishStatus(session);
    return this.statusFromSession(session);
  }

  async availableThinkingLevels(ref: PiSessionRef): Promise<ClientThinkingLevel[]> {
    const session = await this.getOrOpen(ref);
    return session.getAvailableThinkingLevels();
  }

  async setThinkingLevel(ref: PiSessionRef, level: string): Promise<ClientSessionStatus> {
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

  async cycleThinkingLevel(ref: PiSessionRef): Promise<ClientSessionStatus> {
    await this.assertWritable(ref);
    const session = await this.getOrOpen(ref);
    this.assertTreeNavigationInactive(session, "change the thinking level");
    const level = session.cycleThinkingLevel();
    if (level === undefined) throw new Error("Current model does not support thinking");
    this.publishActivity(session, `thinking: ${level}`, "idle");
    this.publishStatus(session);
    return this.statusFromSession(session);
  }

  async commands(ref: PiSessionRef): Promise<ClientCommand[]> {
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

  async prompt(ref: PiSessionRef, text: unknown, streamingBehavior?: unknown, attachments?: unknown, options?: { echoUserMessage?: boolean }): Promise<void> {
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
    // A chat message answers the session's open ask in the user's own words, so
    // the form is void: keeping it open would invite answers to questions the
    // conversation has already moved past. Ignored duplicates skip this on
    // purpose: they must not void an ask posted after the queued original.
    await this.voidOpenAskForUserMessage(session);
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

  async saveAttachments(ref: PiSessionRef, attachments: unknown, folder?: string): Promise<SavedPromptAttachment[]> {
    const parsed = parsePromptAttachments(attachments, { enforceInlineSizeLimit: false, allowFileAttachments: true });
    if (parsed.length === 0) return [];
    await this.assertWritable(ref);
    const active = await this.getActive(ref);
    const cwd = active.runtime.cwd;
    // An explicit request folder wins; the config lookup below is only the
    // fallback for folder-less calls (see workspaceAttachmentsConfig).
    const effectiveFolder = folder ?? (await this.workspaceAttachmentsConfig(cwd)).defaultFolder;
    return saveAttachmentsToWorkspace(cwd, parsed, effectiveFolder === undefined ? {} : { folder: effectiveFolder });
  }

  /**
   * Fallback attachments config for save requests that omit an explicit
   * folder: the live global config merged with the session cwd's own
   * project-local override. Unlike `workspaceEffectiveConfig` in app.ts (which
   * resolves from the owning project's path), this lookup keys off the cwd
   * itself, so for secondary (worktree) workspaces it cannot see the owning
   * project's override. The composer therefore always sends the
   * workspace-effective folder it displayed explicitly; this cwd-based
   * resolution only governs folder-less API calls.
   */
  private async workspaceAttachmentsConfig(cwd: string): Promise<PiWebAttachmentsConfig> {
    const globalConfig = this.config === undefined ? {} : (await this.config.read()).effectiveConfig;
    return loadEffectiveProjectAttachmentsConfig(cwd, globalConfig);
  }

  async shell(ref: PiSessionRef, text: string): Promise<void> {
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

  async runCommand(ref: PiSessionRef, text: string): Promise<ClientCommandResult> {
    await this.assertWritable(ref);
    const active = await this.getActive(ref);
    return this.commandService.run(active.runtime.session.sessionId, text);
  }

  async respondToCommand(ref: PiSessionRef, requestId: string, value: string): Promise<ClientCommandResult> {
    await this.assertWritable(ref);
    const active = await this.getActive(ref);
    return this.commandService.respond(active.runtime.session.sessionId, requestId, value);
  }

  async navigateTree(ref: PiSessionRef, request: ClientSessionTreeNavigateRequest): Promise<ClientSessionTreeNavigateResult> {
    if (request.targetId.trim() === "") throw new Error("Session tree target is required");
    if (this.isTreeExclusiveSessionIdentityActive(ref.id)) {
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

  /**
   * Fork the session from one entry of its tree into a new session file,
   * leaving the original session untouched. The forked runtime replaces the
   * current one, so the outcome is reported for the session the client is
   * about to join rather than the forked-from record.
   */
  async forkFromTree(ref: PiSessionRef, request: ClientSessionTreeForkRequest): Promise<ClientSessionTreeForkResult> {
    if (request.entryId.trim() === "") throw new Error("Session tree entry is required");
    if (this.isTreeExclusiveSessionIdentityActive(ref.id)) {
      throw new Error("Stop current session activity before forking the session tree");
    }
    await this.assertWritable(ref);
    const session = await this.getOrOpen(ref);
    if (this.hasActiveWork(session)) throw new Error("Stop current session activity before forking the session tree");
    if (session.sessionManager.getLeafId() !== request.expectedLeafId) {
      throw new Error("The session changed since /tree was opened. Reopen /tree and try again.");
    }

    this.publishActivity(session, "forking session from entry", "active");
    this.publishStatus(session);
    try {
      const result = await this.commandService.forkEntry(session.sessionId, request.entryId, {
        expectedLeafId: request.expectedLeafId,
      });
      if (result.type === "unsupported") throw new Error(result.message);
      if (result.type !== "done") throw new Error("Session fork is unavailable");
      if (result.session === undefined) {
        if (this.isCurrentActiveSession(session)) {
          this.publishActivity(session, "fork cancelled", "idle");
          this.publishStatus(session);
        }
        return { cancelled: true };
      }

      const forkedSession = this.active.get(result.session.id)?.runtime.session;
      if (forkedSession !== undefined && this.isCurrentActiveSession(forkedSession)) {
        this.publishActivity(forkedSession, "session forked", "idle");
        this.publishStatus(forkedSession);
      }
      if (result.session.id !== session.sessionId) this.clearSupersededSessionActivity(session);
      return {
        cancelled: false,
        session: result.session,
        ...(result.promptDraft === undefined ? {} : { promptDraft: result.promptDraft }),
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.isCurrentActiveSession(session)) {
        this.publishActivity(session, "fork failed", "error", message);
        this.events.publish(session.sessionId, { type: "session.error", message });
        this.publishStatus(session);
      }
      throw error;
    }
  }

  /**
   * A changed-id fork can rebind its runtime after a heartbeat published the
   * prior identity as active. Clear every observable owner before forgetting
   * that identity's local activity record.
   */
  private clearSupersededSessionActivity(session: PiAgentSession): void {
    const sessionId = session.sessionId;
    if (this.activities.get(sessionId)?.phase === "active") {
      const at = new Date().toISOString();
      const stored = { phase: "idle" as const, label: "idle", at };
      this.activities.set(sessionId, stored);
      const activity = { sessionId, ...stored };
      this.events.publish(sessionId, { type: "activity.update", activity });
      this.events.publishGlobal({ type: "activity.update", activity });
    }
    this.workspaceActivity?.removeSession(sessionId, session.sessionManager.getCwd());
    this.activities.delete(sessionId);
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

  async archive(ref: PiSessionRef): Promise<void> {
    const session = await this.getOrOpen(ref);
    if (this.hasActiveWork(session)) throw new Error("Stop current session activity before archiving");
    await this.runTreeExclusiveOperation(
      [{ sessionId: session.sessionId, session }],
      "Stop current session activity before archiving",
      async () => {
        const archiveInput = await this.archiveInputForSession(session);
        await this.closeActive(session.sessionId, { kind: "clear", reason: "archive" });
        await this.archiveStore.archive(archiveInput);
        await this.forgetUnreadSessions([archiveInput]);
      },
    );
  }

  async archiveMany(refs: readonly SessionBulkMutationRef[]): Promise<SessionBulkArchiveResponse> {
    const uniqueRefs = uniqueBulkSessionRefs(refs);
    const [archivedRecords, sessionContext] = await Promise.all([
      this.archiveStore.list(),
      this.bulkSessionRefContext(uniqueRefs),
    ]);
    const failures: SessionBulkFailure[] = [];
    const alreadyArchivedSessionIds: string[] = [];
    const unreadArchivedIdentities: { sessionId: string; cwd: string }[] = [];
    const planItems: BulkArchivePlanItem[] = [];

    for (const ref of uniqueRefs) {
      const archived = findArchivedRecordForBulkRef(archivedRecords, ref);
      if (archived !== undefined) {
        this.publishNotificationMutations(this.notificationStore.clearSession(archived.sessionId, "archive"));
        alreadyArchivedSessionIds.push(archived.sessionId);
        unreadArchivedIdentities.push(archived);
        continue;
      }

      const active = this.activeForRef(bulkRefToSessionRef(ref));
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
      const active = this.activeForRef({ id: item.input.sessionId, cwd: item.input.cwd });
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
          unreadArchivedIdentities.push(...archived);
        } catch (error: unknown) {
          for (const input of readyInputs) failures.push({ sessionId: input.sessionId, error: errorMessage(error) });
        }
      },
    );
    await this.forgetUnreadSessions(unreadArchivedIdentities);

    return {
      archived: true,
      archivedSessionIds: uniqueStrings(archivedSessionIds),
      failures,
      generatedAt: new Date().toISOString(),
    };
  }

  async archiveTree(ref: PiSessionRef): Promise<ClientArchiveSessionsResponse> {
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
    await this.forgetUnreadSessions(plan.targets.map((target) => ({ sessionId: target.id, cwd: target.cwd })));

    return {
      archived: true,
      sessionIds: archiveInputs.map((input) => input.sessionId),
      archivedCount: archiveInputs.length,
      skippedAlreadyArchivedCount: plan.skippedAlreadyArchivedCount,
    };
  }

  async restore(ref: PiSessionRef): Promise<void> {
    const archived = await this.getArchived(ref);
    if (archived === undefined) throw new Error("Session not found");
    await this.closeActive(archived.sessionId, { kind: "clear", reason: "restore" });
    await this.archiveStore.restore(archived.sessionId);
    await this.forgetUnreadSessions([archived]);
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

      const active = this.activeForRef({ id: record.sessionId, cwd: record.cwd });
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

    const deleteIds = readyRecords.map((record) => record.sessionId);

    let deletedSessionIds: string[] = [];
    try {
      deletedSessionIds = await this.archiveStoreDeleteArchivedMany(deleteIds);
    } catch (error: unknown) {
      for (const sessionId of deleteIds) failures.push({ sessionId, error: errorMessage(error) });
    }
    const deletedIdSet = new Set(deletedSessionIds);
    await this.forgetUnreadSessions(readyRecords.filter((record) => deletedIdSet.has(record.sessionId)));

    return {
      deleted: true,
      deletedSessionIds,
      failures,
      generatedAt: new Date().toISOString(),
    };
  }

  async reload(ref: PiSessionRef): Promise<void> {
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

  async detachParent(ref: PiSessionRef): Promise<void> {
    const session = await this.getOrOpen(ref);
    const sessionFile = session.sessionFile;
    if (sessionFile === undefined || sessionFile === "") throw new Error("Session is not persisted");
    await clearParentSession(sessionFile);
    // The header rewrite keeps the inode, and whenever it leaves the file's
    // size unchanged it is invisible to the gateway's summary memo, which
    // cannot detect such rewrites from identity + size alone and would keep
    // listing the old parent link until restart.
    this.sessionManager.invalidateSessionFile(sessionFile);
    clearParentSessionHeader(session.sessionManager);
    this.unregisterSubsession(session.sessionId);
    await this.forgetUnreadSessions([{ sessionId: session.sessionId, cwd: session.sessionManager.getCwd() }]);
  }

  async clearQueue(ref: PiSessionRef): Promise<ClientSessionStatus> {
    await this.assertWritable(ref);
    const session = await this.getOrOpen(ref);
    this.clearCompactionPromptQueue(session.sessionId);
    clearSessionQueue(session);
    this.publishStatus(session);
    return this.statusFromSession(session);
  }

  async dismissWarning(ref: PiSessionRef, dismissId: string): Promise<ClientSessionStatus> {
    const session = await this.getOrOpen(ref);
    dismissSessionWarning(session, dismissId);
    this.publishStatus(session);
    return this.statusFromSession(session);
  }

  async abort(ref: PiSessionRef): Promise<void> {
    const active = this.activeForRef(ref);
    if (active === undefined) return;
    const sessionId = active.runtime.session.sessionId;
    this.clearCompactionPromptQueue(sessionId);
    clearSessionQueue(active.runtime.session);
    // Settle run-scoped dialogs now, at abort-request time: pi's agent loop
    // waits for a parked `tool_call` dialog handler before it can emit
    // `agent_end`, so leaving settlement to the `agent_end` observer would
    // strand the dialog until its timeout. Settling before the runtime abort
    // also means a failing or hung abort cannot strand the parked waiter.
    this.abortRunScopedExtensionDialogs(sessionId);
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

  async stop(ref: PiSessionRef): Promise<void> {
    const active = this.activeForRef(ref);
    if (active !== undefined) {
      await this.closeActive(active.runtime.session.sessionId);
      return;
    }
    // A session whose open is parked (e.g. on a session_start dialog) is not
    // active yet; close it through the same path so stopping cannot block
    // behind the dialog timeout.
    const startup = this.startupSessionForRef(ref);
    if (startup !== undefined) {
      await this.closeActive(startup.sessionId);
      return;
    }
    this.publishNotificationMutations(this.notificationStore.clearSessionIdentity(ref.id, canonicalizeStoredCwd(ref.cwd), "runtime-close"));
  }

  private async bulkSessionRefContext(refs: readonly SessionBulkMutationRef[]): Promise<BulkSessionRefContext> {
    const cwdSet = new Set<string>();
    for (const ref of refs) cwdSet.add(ref.cwd);
    return { sessionsByCwd: await this.listSessionsByCwd([...cwdSet]) };
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

  private async cleanupPlan(request: NormalizedSessionCleanupRequest) {
    const [sessions, archivedRecords] = await Promise.all([this.sessionManager.listAll(), this.archiveStore.list()]);
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
    // A session whose open is parked on a `session_start` dialog holds its
    // pending open until the dialog settles; settle it first so closing cannot
    // block behind the dialog timeout (which `0` makes infinite).
    if (this.startupSessions.has(sessionId)) this.endSessionExtensionDialogs(sessionId);
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
    this.forgetUnreadActivity(active.runtime.session);
    // An open ask is meaningful only while the runtime that posted it exists: no
    // one is left to receive the answers, so it is dropped without an outcome.
    this.pendingAskStore.forgetSession(sessionId);
    // Open dialogs share that stance, but their extension waiters are parked
    // Promises inside the dying runtime: settle them rather than dropping them.
    this.endSessionExtensionDialogs(sessionId);
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

  private async assertWritable(ref: PiSessionRef): Promise<void> {
    if (await this.getArchived(ref) !== undefined) throw new Error("Archived sessions are read-only. Restore the session to continue.");
  }

  private async getOrOpen(ref: PiSessionRef): Promise<PiAgentSession> {
    return (await this.getActive(ref)).runtime.session;
  }

  /**
   * An idle runtime is only Pi Web's cached control view. Another Pi process may
   * keep appending to the same JSONL file, so transcript reads must open a fresh
   * read-only snapshot rather than serving that cached branch forever. Active
   * runtimes remain authoritative and are never replaced, reloaded, or aborted.
   */
  private async readableSessionBranch(ref: PiSessionRef, session: PiAgentSession): Promise<unknown[]> {
    if (this.hasActiveWork(session) || this.sessionManager.readBranch === undefined) return session.sessionManager.getBranch();
    const sessionFile = session.sessionFile ?? session.sessionManager.getSessionFile();
    const resolvedPath = sessionFile === undefined ? await this.idleSessionFilePath(ref, session) : undefined;
    if (this.hasActiveWork(session)) return session.sessionManager.getBranch();
    const path = sessionFile ?? resolvedPath;
    if (path === undefined) return session.sessionManager.getBranch();
    const snapshot = await this.sessionManager.readBranch(path);
    // No snapshot exists when the transcript file is absent (a session known
    // by path but never persisted, or externally removed): the runtime branch
    // is the only readable branch then.
    if (snapshot === undefined) return session.sessionManager.getBranch();
    // Reading also yields. A prompt that started meanwhile must still win over
    // the completed disk snapshot and its potentially older event watermark.
    return this.hasActiveWork(session) ? session.sessionManager.getBranch() : snapshot;
  }

  /**
   * Resolve the transcript file for an idle runtime that does not know one,
   * at most once per {@link IDLE_SESSION_FILE_RESOLUTION_THROTTLE_MS}. The
   * negative result (no file yet) is the hot case: a never-persisted session
   * is polled every few seconds, and re-scanning its directory each tick is
   * pure waste. `getActive` never uses this path, so prompt routing always
   * sees a fresh resolution.
   */
  private async idleSessionFilePath(ref: PiSessionRef, session: PiAgentSession): Promise<string | undefined> {
    const cached = this.idleSessionFileResolutions.get(session);
    const at = this.now().getTime();
    if (cached !== undefined && at - cached.at < IDLE_SESSION_FILE_RESOLUTION_THROTTLE_MS) return cached.path;
    const match = await this.sessionManager.resolveSessionFile(ref.cwd, ref.id);
    this.idleSessionFileResolutions.set(session, { at, path: match?.path });
    return match?.path;
  }

  private async getActive(ref: PiSessionRef, options: Pick<CreateSessionRuntimeOptions, "notificationGeneration"> = {}): Promise<ActiveSession<PiSessionRuntime>> {
    const active = this.activeForRef(ref);
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

    // Resolve the session file directly by id: opening one known session must
    // not depend on — or wait behind — a full transcript listing of its whole
    // workspace. `getActive` routes prompt/shell/runCommand, so coupling it to
    // the listing would let an in-flight listing serialize unrelated sends.
    const match = await this.sessionManager.resolveSessionFile(ref.cwd, ref.id);
    if (!match) throw new Error("Session not found");
    return this.openExistingSession(match.id, match.cwd, () => this.sessionManager.open(match.path), options);
  }

  private openExistingSession(
    sessionId: string,
    cwd: string,
    openSessionManager: () => PiSessionManager,
    options: Pick<CreateSessionRuntimeOptions, "notificationGeneration" | "notifications"> = {},
  ): Promise<ActiveSession<PiSessionRuntime>> {
    const active = this.activeForRef({ id: sessionId, cwd });
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

  private async getArchived(ref: PiSessionRef): Promise<ArchivedSessionRecord | undefined> {
    const archived = await this.archiveStore.get(ref.id);
    if (archived === undefined) return undefined;
    if (archived.cwd !== ref.cwd) return undefined;
    return archived;
  }

  private isCurrentActiveSession(session: PiAgentSession): boolean {
    return this.active.get(session.sessionId)?.runtime.session === session;
  }

  /**
   * The command service tracks sessions by id alone; its callbacks only ever
   * run against a session the caller just resolved as active, so the cwd
   * needed for a full ref comes from that active runtime.
   */
  private activeSessionRef(sessionId: string): PiSessionRef {
    const active = this.active.get(sessionId);
    if (active === undefined) throw new Error("Session not found");
    return { id: sessionId, cwd: active.runtime.cwd };
  }

  private activeForRef(ref: PiSessionRef): ActiveSession<PiSessionRuntime> | undefined {
    const sessionId = ref.id;
    const exact = this.active.get(sessionId);
    if (exact !== undefined && refMatchesActiveSession(ref, exact)) return exact;
    for (const [candidateId, active] of this.active.entries()) {
      if (candidateId.startsWith(sessionId) && refMatchesActiveSession(ref, active)) return active;
    }
    return undefined;
  }

  private startupSessionForRef(ref: PiSessionRef): PiAgentSession | undefined {
    const sessionId = ref.id;
    const exact = this.startupSessions.get(sessionId);
    if (exact !== undefined && refMatchesStartupSession(ref, exact)) return exact;
    for (const [candidateId, session] of this.startupSessions.entries()) {
      if (candidateId.startsWith(sessionId) && refMatchesStartupSession(ref, session)) return session;
    }
    return undefined;
  }

  /**
   * The session to serve a read-only status or a dialog close for, while it
   * can still be found: active first, then still starting up, and only then
   * the on-demand open path (which a stale close on an idle session needs for
   * its status projection).
   */
  private async sessionForStatusOrDialogClose(ref: PiSessionRef): Promise<PiAgentSession> {
    const reachable = this.activeForRef(ref)?.runtime.session ?? this.startupSessionForRef(ref);
    if (reachable !== undefined) return reachable;
    return this.getOrOpen(ref);
  }

  /**
   * Construct a session while telling waiting browsers which phase of startup
   * they are waiting on. The reporting wraps the *whole* construction rather
   * than the inner bookkeeping `try`, because the runtime construction that runs
   * first is both the slowest phase and one that can fail on its own; a clear
   * that only ran for the later phases would leave a stale label behind.
   */
  private async create(
    sessionManager: PiSessionManager,
    cwd: string,
    options: CreateSessionRuntimeOptions = {},
  ): Promise<ActiveSession<PiSessionRuntime>> {
    const startup = this.startupProgress(sessionManager, options.startupIntent ?? "open", options.startupToken);
    try {
      return await this.createSessionRuntime(sessionManager, cwd, options, startup);
    } finally {
      startup.end();
    }
  }

  private async createSessionRuntime(
    sessionManager: PiSessionManager,
    cwd: string,
    options: CreateSessionRuntimeOptions,
    startup: SessionStartupProgressReporter,
  ): Promise<ActiveSession<PiSessionRuntime>> {
    startup.report(STARTUP_PHASE_RUNTIME);
    const delegationToolsEnabled = options.creationProvenance !== "tracked-subsession"
      && await sessionAllowsDelegationTools(sessionManager, this.sessionManager);
    const runtime = await this.createAgentRuntime(this.createRuntime, {
      cwd,
      agentDir: this.agentDir,
      sessionManager,
      delegationToolsEnabled,
      ...(options.initialModel === undefined ? {} : { initialModel: options.initialModel }),
      ...(options.initialThinkingLevel === undefined ? {} : { initialThinkingLevel: options.initialThinkingLevel }),
    });
    const active: ActiveSession<PiSessionRuntime> = { runtime, unsubscribe: noop };
    let boundSession = runtime.session;
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
      if (options.creationProvenance === "tracked-subsession") {
        await this.publishUnreadMutations(this.unreadStore.excludeSession(
          runtime.session.sessionId,
          canonicalizeStoredCwd(runtime.session.sessionManager.getCwd()),
        ));
      } else {
        await this.recoverSubsessionTrackingForOpenedSession(runtime.session);
      }
      startup.report(STARTUP_PHASE_EXTENSIONS);
      await this.bindSessionExtensions(runtime.session, notificationGeneration);
      this.bindRuntime(active);
      runtime.setRebindSession(async (session) => {
        const priorGeneration = notificationGeneration;
        let candidateGeneration: SessionNotificationGeneration | undefined;
        try {
          await this.prepareUnreadRuntimeRebind(boundSession, session);
          await this.recoverSubsessionTrackingForOpenedSession(session);
          if (priorGeneration !== undefined) {
            candidateGeneration = this.notificationStore.beginReplacement(priorGeneration, notificationIdentityForSession(session));
            this.notificationGenerationBySession.set(session, candidateGeneration);
          }
          this.bindRuntime(active, session);
          // The runtime being replaced parked every dialog the store still
          // holds for this session; settle those waits before the new
          // runtime's extensions can open fresh dialogs under the same id.
          this.endSessionExtensionDialogs(boundSession.sessionId);
          boundSession = session;
          await this.bindSessionExtensions(session, candidateGeneration);
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
      this.forgetUnreadActivity(boundSession);
      // A session_start dialog may already be parked when a later startup
      // step fails; its waiter dies with the runtime being torn down here.
      this.endSessionExtensionDialogs(boundSession.sessionId);
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
    // A `session_start` hook can park this bind on a dialog the browser has
    // not answered yet. On the initial create/open path the session becomes
    // active only after this returns, so register it for the duration: the
    // answer that unblocks startup has to be reachable while it waits.
    this.startupSessions.set(session.sessionId, session);
    try {
      await session.bindExtensions({
        uiContext,
        mode: "rpc",
        onError: (error) => {
          const message = `${error.extensionPath}: ${error.error}`;
          this.publishActivity(session, "extension error", "error", message);
          this.events.publish(session.sessionId, { type: "session.error", message });
        },
      });
    } finally {
      this.startupSessions.delete(session.sessionId);
    }
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
    };
    // PI WEB owns the browser-facing dialog, notification, and text-formatting
    // boundaries: the three dialog primitives park daemon-held Promises that
    // the browser answers, while every other UI method delegates to Pi's
    // headless defaults so unsupported surfaces cancel safely instead of
    // hanging.
    return new Proxy(baseUiContext, {
      get: (target, property, receiver): unknown => {
        if (property === "notify") return notify;
        if (property === "theme") return plainTextTheme;
        if (property === "confirm") {
          return (title: string, message: string, opts?: ExtensionUIDialogOptions) =>
            this.openExtensionDialog(session, { kind: "confirm", title, message }, opts);
        }
        if (property === "select") {
          return (title: string, options: string[], opts?: ExtensionUIDialogOptions) =>
            this.openExtensionDialog(session, { kind: "select", title, options }, opts);
        }
        if (property === "input") {
          return (title: string, placeholder: string | undefined, opts?: ExtensionUIDialogOptions) =>
            this.openExtensionDialog(session, { kind: "input", title, placeholder }, opts);
        }
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

  private async prepareUnreadRuntimeRebind(previous: PiAgentSession, next: PiAgentSession): Promise<void> {
    const previousCwd = canonicalizeStoredCwd(previous.sessionManager.getCwd());
    this.unreadStore.forgetActivity(previous.sessionId, previousCwd);
    const nextCwd = canonicalizeStoredCwd(next.sessionManager.getCwd());
    if (previous.sessionId === next.sessionId && cwdPathsEqual(previousCwd, nextCwd)) return;
    await this.publishUnreadMutations(this.unreadStore.forgetSession(previous.sessionId, previousCwd));
  }

  private forgetUnreadActivity(session: PiAgentSession): void {
    this.unreadStore.forgetActivity(
      session.sessionId,
      canonicalizeStoredCwd(session.sessionManager.getCwd()),
    );
  }

  private async forgetUnreadSessions(identities: readonly { sessionId: string; cwd: string }[]): Promise<void> {
    const mutations: SessionUnreadMutation[] = [];
    for (const identity of identities) {
      mutations.push(...this.unreadStore.forgetSession(
        identity.sessionId,
        canonicalizeStoredCwd(identity.cwd),
      ));
    }
    await this.publishUnreadMutations(mutations);
  }

  private observeUnreadActivityState(session: PiAgentSession): void {
    const mutations = this.unreadStore.observeActivityState(
      session.sessionId,
      canonicalizeStoredCwd(session.sessionManager.getCwd()),
      this.hasActiveWork(session),
    );
    if (mutations.length === 0) return;
    void this.publishUnreadMutations(mutations).catch(() => undefined);
  }

  private publishUnreadMutations(mutations: readonly SessionUnreadMutation[]): Promise<void> {
    // The store applied the mutations already, so the status projection is told
    // now rather than after the durable flush: it reads in-memory unread state
    // and must not lag behind the rows the browser is about to see.
    if (mutations.length > 0) this.onUnreadChanged?.();
    this.enqueueUnreadMutations(mutations);
    this.unreadPublicationFlushRequested = true;
    if (this.unreadPublication === undefined && this.unreadPublicationRetryTimer !== undefined) {
      const failure = this.unreadPublicationFailure;
      return Promise.reject(failure instanceof Error
        ? failure
        : new Error("Session unread publication is awaiting retry", { cause: failure }));
    }
    return this.ensureUnreadPublication();
  }

  private ensureUnreadPublication(): Promise<void> {
    const existing = this.unreadPublication;
    if (existing !== undefined) return existing;

    const publication = this.drainUnreadPublication();
    this.unreadPublication = publication;
    void publication.then(
      () => {
        if (this.unreadPublication === publication) this.unreadPublication = undefined;
      },
      (error: unknown) => {
        if (this.unreadPublication === publication) this.unreadPublication = undefined;
        this.unreadPublicationFailure = error;
        this.logger.info(
          { error: error instanceof Error ? error.message : String(error) },
          "failed to publish durable session unread mutations",
        );
        this.scheduleUnreadPublicationRetry();
      },
    );
    return publication;
  }

  private async drainUnreadPublication(): Promise<void> {
    while (this.unreadPublicationFlushRequested || this.pendingUnreadMutations.length > 0) {
      this.unreadPublicationFlushRequested = false;
      const batch = this.pendingUnreadMutations.splice(0);
      let publishedCount = 0;
      try {
        await this.unreadStore.flush();
        for (const mutation of batch) {
          this.events.publishGlobal(mutation.event);
          publishedCount += 1;
        }
      } catch (error: unknown) {
        this.prependUnreadMutations(batch.slice(publishedCount));
        this.unreadPublicationFlushRequested = true;
        throw error;
      }
      this.unreadPublicationFailure = undefined;
      this.clearUnreadPublicationRetry();
    }
  }

  private enqueueUnreadMutations(mutations: readonly SessionUnreadMutation[]): void {
    this.pendingUnreadMutations.push(...mutations);
    this.trimPendingUnreadMutations();
  }

  private prependUnreadMutations(mutations: readonly SessionUnreadMutation[]): void {
    this.pendingUnreadMutations.unshift(...mutations);
    this.trimPendingUnreadMutations();
  }

  private trimPendingUnreadMutations(): void {
    const excess = this.pendingUnreadMutations.length - MAX_PENDING_UNREAD_MUTATIONS;
    if (excess > 0) this.pendingUnreadMutations.splice(0, excess);
  }

  private scheduleUnreadPublicationRetry(): void {
    if (this.unreadPublicationStopped || this.unreadPublicationRetryTimer !== undefined) return;
    const delay = this.unreadPublicationRetryDelayMs;
    this.unreadPublicationRetryDelayMs = Math.min(
      Math.max(delay * 2, this.unreadPublicationRetryInitialMs),
      Math.max(MAX_UNREAD_PUBLICATION_RETRY_MS, this.unreadPublicationRetryInitialMs),
    );
    this.unreadPublicationRetryTimer = setTimeout(() => {
      this.unreadPublicationRetryTimer = undefined;
      void this.ensureUnreadPublication().catch(() => undefined);
    }, delay);
    this.unreadPublicationRetryTimer.unref();
  }

  private clearUnreadPublicationRetry(): void {
    if (this.unreadPublicationRetryTimer !== undefined) clearTimeout(this.unreadPublicationRetryTimer);
    this.unreadPublicationRetryTimer = undefined;
    this.unreadPublicationRetryDelayMs = this.unreadPublicationRetryInitialMs;
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
      this.events.publish(session.sessionId, toClientEvent(event, session.thinkingLevel));
      this.publishActivityForEvent(session, event);
      const eventType = getString(event, "type");
      if (eventType === "agent_end") this.abortRunScopedExtensionDialogs(session.sessionId);
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

    void generateShortSessionName(session.agent.streamFunction, model, firstMessage).then((name) => {
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
    const sessions = new Set<PiAgentSession>();
    for (const target of targets) {
      const runtime = target.runtime ?? (target.session === undefined ? undefined : this.activeRuntimeForSession(target.session));
      const session = target.session ?? runtime?.session;
      if (session !== undefined && this.hasActiveWork(session)) throw new Error(activeError);
      sessionIds.add(target.sessionId);
      if (runtime !== undefined) runtimes.add(runtime);
      if (session !== undefined) sessions.add(session);
    }

    for (const sessionId of sessionIds) {
      this.treeExclusiveSessionOperationCounts.set(sessionId, (this.treeExclusiveSessionOperationCounts.get(sessionId) ?? 0) + 1);
    }
    for (const runtime of runtimes) {
      this.treeExclusiveRuntimeOperationCounts.set(runtime, (this.treeExclusiveRuntimeOperationCounts.get(runtime) ?? 0) + 1);
    }
    for (const session of sessions) this.observeUnreadActivityState(session);

    try {
      return await operation();
    } finally {
      for (const runtime of runtimes) decrementWeakCount(this.treeExclusiveRuntimeOperationCounts, runtime);
      for (const sessionId of sessionIds) decrementMapCount(this.treeExclusiveSessionOperationCounts, sessionId);
      for (const session of sessions) {
        if (this.isCurrentActiveSession(session)) this.observeUnreadActivityState(session);
      }
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
    this.observeUnreadActivityState(session);
  }

  private endSessionEntryMutation(session: PiAgentSession): void {
    const remaining = (this.sessionEntryMutationCounts.get(session) ?? 1) - 1;
    if (remaining <= 0) this.sessionEntryMutationCounts.delete(session);
    else this.sessionEntryMutationCounts.set(session, remaining);
    this.observeUnreadActivityState(session);
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

  /**
   * Build the reporter for one session construction.
   *
   * The session id is known before any await — a `SessionManager` has its id
   * from construction — so the daemon can name what it is starting even though
   * the `PiAgentSession` that {@link publishActivity} needs does not exist yet.
   * Without an id there is nothing to report against, so the reporter stays
   * silent and the browser keeps its own generic wording.
   */
  private startupProgress(sessionManager: PiSessionManager, intent: "create" | "open", startupToken: string | undefined): SessionStartupProgressReporter {
    const sessionId = sessionManager.getSessionId();
    if (sessionId === "") return { report: noop, end: noop };
    const label = intent === "create" ? "Creating session" : "Opening session";
    return {
      report: (phase) => { this.publishStartupProgress(sessionId, startupToken, label, "active", this.startupDetail(phase)); },
      end: () => {
        // A real activity published during the window (an extension error, say)
        // is the truth about this session and must survive the clear.
        if (this.activities.has(sessionId)) return;
        this.publishStartupProgress(sessionId, startupToken, "idle", "idle", undefined);
      },
    };
  }

  private startupDetail(phase: string): string {
    return this.catalogRefreshStatus?.isRefreshInFlight() === true
      ? `${phase} · ${STARTUP_CONCURRENT_CATALOG_REFRESH}`
      : phase;
  }

  /**
   * Report startup progress on the global channel only, echoing the caller's
   * correlation token so a waiting browser row recognises its own construction.
   *
   * Unlike {@link publishActivity} this deliberately records nothing: no
   * `activities` entry, no workspace activity, no unread observation. There is
   * no session to own that state, and a failed creation would leave it stranded.
   *
   * Every report is marked `startup`, which is what keeps a session that is
   * merely opening from counting as one doing work. This is the only publisher
   * that sets the marker, and because it writes no `activities` entry no later
   * heartbeat re-publication can carry it.
   */
  private publishStartupProgress(sessionId: string, startupToken: string | undefined, label: string, phase: "active" | "idle", detail: string | undefined): void {
    const at = new Date().toISOString();
    const activity = detail === undefined ? { sessionId, phase, label, at, startup: true } : { sessionId, phase, label, detail, at, startup: true };
    this.events.publishGlobal(startupToken === undefined ? { type: "session.startup", activity } : { type: "session.startup", startupToken, activity });
  }

  private publishActivity(session: PiAgentSession, label: string, phase: "active" | "idle" | "error", detail?: string): void {
    const at = new Date().toISOString();
    const stored = detail === undefined ? { phase, label, at } : { phase, label, detail, at };
    this.activities.set(session.sessionId, stored);
    const activity = detail === undefined ? { sessionId: session.sessionId, phase, label, at } : { sessionId: session.sessionId, phase, label, detail, at };
    this.workspaceActivity?.applySessionActivity(session.sessionManager.getCwd(), activity);
    this.events.publish(session.sessionId, { type: "activity.update", activity });
    this.events.publishGlobal({ type: "activity.update", activity });
    this.observeUnreadActivityState(session);
  }

  private publishStatus(session: PiAgentSession): void {
    const status = this.statusFromSession(session);
    this.clearStaleActiveActivity(session);
    this.workspaceActivity?.applySessionStatus(session.sessionManager.getCwd(), status);
    this.events.publish(session.sessionId, { type: "status.update", status });
    this.events.publishGlobal({ type: "status.update", status });
    this.observeUnreadActivityState(session);
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

  private statusFromSession(session: PiAgentSession, messageCount = session.messages.length): ClientSessionStatus {
    const stats = session.getSessionStats();
    const model = session.model === undefined ? undefined : modelToClientModel(session.model);
    const contextUsage = session.getContextUsage();
    const warnings = this.warningsForSession(session);
    const pendingAsk = this.pendingAskStore.pendingAsk(session.sessionId);
    const pendingDialogs = this.pendingExtensionDialogStore.pendingDialogs(session.sessionId);
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
      messageCount,
      tokens: stats.tokens,
      cost: stats.cost,
      ...(contextUsage === undefined ? {} : { contextUsage }),
      ...(warnings.length === 0 ? {} : { warnings }),
      ...(pendingAsk === undefined ? {} : { pendingAsk }),
      ...(pendingDialogs.length === 0 ? {} : { pendingDialogs }),
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
    const key = `${ref.cwd}\0${ref.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(ref);
  }
  return unique;
}

function bulkRefToSessionRef(ref: SessionBulkMutationRef): PiSessionRef {
  return { id: ref.id, cwd: ref.cwd };
}

function findArchivedRecordForBulkRef(records: readonly ArchivedSessionRecord[], ref: SessionBulkMutationRef): ArchivedSessionRecord | undefined {
  return records.find((record) => record.cwd === ref.cwd && (record.sessionId === ref.id || record.sessionId.startsWith(ref.id)));
}

function findListedSessionForBulkRef(context: BulkSessionRefContext, ref: SessionBulkMutationRef): PiSessionListEntry | undefined {
  return findSessionByIdOrPrefix(context.sessionsByCwd.get(ref.cwd) ?? [], ref.id);
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

/** The scope source pi's enabled-id precedence reads from: live scope, settings patterns, runtime catalog. */
function sessionScopeSource(session: PiAgentSession): { settingsManager: PiAgentSession["settingsManager"]; modelRuntime: PiAgentSession["modelRuntime"]; scopedModels: PiAgentSession["scopedModels"] } {
  return { settingsManager: session.settingsManager, modelRuntime: session.modelRuntime, scopedModels: session.scopedModels };
}

function catalogEntryToClientModel(entry: EnabledModelCatalogEntry<AgentModel>, editable = true): ClientSessionModelCatalogEntry {
  return {
    ...modelToClientModel(entry.model),
    provider: entry.model.provider,
    id: entry.model.id,
    enabled: entry.enabled,
    catalogIndex: entry.catalogIndex,
    ...(editable ? {} : { editable: false }),
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

/**
 * Attach the thinking level in effect when an assistant message was generated,
 * so chat bubbles can show it next to the model. Non-assistant messages pass
 * through by reference; assistant messages are copied only when a level is set.
 * "off" is the absence of thinking, not a level worth labeling on every bubble.
 */
function annotateAssistantThinkingLevel(message: unknown, thinkingLevel: string | undefined): unknown {
  if (thinkingLevel === undefined || thinkingLevel === "" || thinkingLevel === "off") return message;
  if (!isRecord(message) || message["role"] !== "assistant") return message;
  return { ...message, thinkingLevel };
}

function historyMessages(session: PiAgentSession): unknown[] {
  return historyMessagesFromEntries(session.sessionManager.getBranch());
}

function historyMessagesFromEntries(entries: readonly unknown[]): unknown[] {
  const messages: unknown[] = [];
  // Pi records the initial level at session creation and every later change, so
  // walking the branch yields the level in effect for each assistant message.
  let thinkingLevel: string | undefined;
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    if (entry["type"] === "message") messages.push(annotateAssistantThinkingLevel(entry["message"], thinkingLevel));
    else if (entry["type"] === "thinking_level_change") {
      const level = getString(entry, "thinkingLevel");
      if (level !== undefined) thinkingLevel = level;
    }
    else if (entry["type"] === "custom_message" && entry["display"] === true) messages.push({ role: "custom", content: entry["content"], customType: entry["customType"], details: entry["details"] });
    else if (entry["type"] === "compaction") messages.push({ role: "system", source: "compaction", content: `Compacted history:\n\n${stringValue(entry["summary"])}` });
    else if (entry["type"] === "branch_summary") messages.push({ role: "system", source: "branch_summary", content: `Branch summary:\n\n${stringValue(entry["summary"])}` });
  }
  return messages;
}

function transcriptMessageCount(entries: readonly unknown[]): number {
  let count = 0;
  for (const entry of entries) {
    if (isRecord(entry) && entry["type"] === "message") count += 1;
  }
  return count;
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

function toClientEvent(event: unknown, thinkingLevel?: string): SessionUiEvent {
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
    if (message === undefined) return { type: "message.end" };
    return { type: "message.end", message: annotateAssistantThinkingLevel(message, thinkingLevel) };
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
