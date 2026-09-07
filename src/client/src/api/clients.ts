import type { AskUserSubmission, DeleteWorkspaceFileResponse, ExtensionDialogAnswer, FileSuggestion, MoveWorkspaceFileOptions, PiPackageInstallRequest, PiPackageRemoveRequest, PiPackageScope, PiPackageUpdateRequest, PiWebConfigValues, PromptAttachment, ServerNoticeDismissRequest, SessionBulkMutationRef, SessionCleanupRequest, SessionModelScopeMode, SessionNotificationDismissThrough, SessionRef, SessionTreeForkRequest, SessionTreeForkResult, SessionTreeNavigateRequest, SessionUnreadAcknowledgeRequest, WorkspaceRemovalRequest, WriteWorkspaceFileOptions } from "../../../shared/apiTypes";
import { resolveAppUrl } from "../appUrl";
import { request } from "./http";
import {
  arrayOf,
  parseAborted,
  parseAskUserCloseResponse,
  parseAccepted,
  parseArchived,
  parseAuthProvidersResponse,
  parseClosed,
  parseCommandResult,
  parseDeleteWorkspaceFileResponse,
  parseDetached,
  parseExtensionDialogCloseResponse,
  parseFileContentResponse,
  parseFileSuggestion,
  parseFileTreeResponse,
  parseMachine,
  parseMachineHealth,
  parseMachineRuntime,
  parseMachinesResponse,
  parseMessagePage,
  parseModelSelectionResponse,
  parseSessionModelCatalogResponse,
  parseMoveWorkspaceFileResponse,
  parseOAuthFlowState,
  parsePiPackageMutationResponse,
  parsePiPackagesResponse,
  parsePiWebConfigResponse,
  parsePiWebPluginsResponse,
  parsePiWebRuntimeResponse,
  parsePiWebStatusResponse,
  parseProject,
  parseReloaded,
  parseRestored,
  parseSavedAttachments,
  parseSessionBulkArchiveResponse,
  parseSessionBulkDeleteArchivedResponse,
  parseSessionCleanupExecuteResponse,
  parseSessionCleanupPreviewResponse,
  parseSessionInfo,
  parseSessionNotificationInboxSnapshot,
  parseServerNoticeSnapshot,
  parseSessionStatus,
  parseSessionUnreadCatalogSnapshot,
  parseSessionStreamSnapshot,
  parseSessionTreeForkResult,
  parseSessionTreeNavigateResult,
  parseSlashCommand,
  parseStopped,
  parseThinkingLevelsResponse,
  parseWriteWorkspaceFileResponse,
  parseWorkspaceProviderResolution,
  parseWorkspaceTrustResponse,
  requireMachineStatusSnapshot,
} from "./parsers";
import { messagePath } from "./urls";

const machinePrefix = (machineId = "local") => `api/machines/${encodeURIComponent(machineId)}`;

function sessionBasePath(session: SessionRef, machineId = "local"): string {
  return `${machinePrefix(machineId)}/sessions/${encodeURIComponent(session.id)}`;
}

function sessionPath(session: SessionRef, endpoint: string, machineId = "local"): string {
  return `${sessionBasePath(session, machineId)}/${endpoint}`;
}

function sessionQueryPath(session: SessionRef, endpoint: string, machineId = "local"): string {
  return `${sessionPath(session, endpoint, machineId)}${sessionQuery(session)}`;
}

function sessionQuery(session: SessionRef): string {
  return `?${new URLSearchParams({ cwd: session.cwd }).toString()}`;
}

function sessionBody(session: SessionRef, fields: Record<string, unknown> = {}): string {
  return JSON.stringify({ cwd: session.cwd, ...fields });
}

function sessionBulkMutationBody(sessions: readonly SessionRef[]): string {
  return JSON.stringify({ sessions: sessions.map(sessionBulkMutationRef) });
}

function sessionBulkMutationRef(session: SessionRef): SessionBulkMutationRef {
  return { id: session.id, cwd: session.cwd };
}

function piWebStatusPath(machineId: string): string {
  return machineId === "local" ? "api/pi-web/status" : `${machinePrefix(machineId)}/pi-web/status`;
}

export const piWebApi = {
  piWebStatus: (machineId = "local") => request(piWebStatusPath(machineId), parsePiWebStatusResponse),
  checkForUpdates: (machineId = "local") => request(`${piWebStatusPath(machineId)}?refresh=1`, parsePiWebStatusResponse, { cache: "no-store" }),
  piWebRuntime: () => request("api/pi-web/runtime", parsePiWebRuntimeResponse),
};

export const machinesApi = {
  machines: () => request("api/machines", parseMachinesResponse),
  addMachine: (input: { name: string; baseUrl: string; token?: string }) => request("api/machines", parseMachine, { method: "POST", body: JSON.stringify(input) }),
  deleteMachine: (machineId: string) => request(`api/machines/${encodeURIComponent(machineId)}`, (value) => value, { method: "DELETE" }),
  health: (machineId: string) => request(`api/machines/${encodeURIComponent(machineId)}/health`, parseMachineHealth),
  runtime: (machineId: string, refresh = false) => request(`api/machines/${encodeURIComponent(machineId)}/runtime${refresh ? "?refresh=1" : ""}`, parseMachineRuntime, refresh ? { cache: "no-store" } : {}),
};

function configPath(machineId?: string): string {
  return machineId === undefined ? "api/config" : `${machinePrefix(machineId)}/config`;
}

function pluginsPath(machineId?: string): string {
  return machineId === undefined ? "api/plugins" : `${machinePrefix(machineId)}/plugins`;
}

export const configApi = {
  config: (machineId?: string) => request(configPath(machineId), parsePiWebConfigResponse),
  saveConfig: (config: PiWebConfigValues, machineId?: string) => request(configPath(machineId), parsePiWebConfigResponse, { method: "PUT", body: JSON.stringify({ config }) }),
};

export const pluginsApi = {
  plugins: (machineId?: string) => request(pluginsPath(machineId), parsePiWebPluginsResponse),
};

function piPackagePath(endpoint = "", machineId?: string): string {
  const basePath = machineId === undefined ? "api/pi-packages" : `${machinePrefix(machineId)}/pi-packages`;
  return endpoint === "" ? basePath : `${basePath}/${endpoint}`;
}

export const piPackagesApi = {
  packages: (machineId?: string) => request(piPackagePath("", machineId), parsePiPackagesResponse),
  install: (source: string, machineId?: string) => {
    const body: PiPackageInstallRequest = { source };
    return request(piPackagePath("install", machineId), parsePiPackageMutationResponse, { method: "POST", body: JSON.stringify(body) });
  },
  remove: (source: string, scope?: PiPackageScope, machineId?: string) => {
    const body: PiPackageRemoveRequest = scope === undefined ? { source } : { source, scope };
    return request(piPackagePath("remove", machineId), parsePiPackageMutationResponse, { method: "POST", body: JSON.stringify(body) });
  },
  update: (source?: string, machineId?: string) => {
    const body: PiPackageUpdateRequest | undefined = source === undefined ? undefined : { source };
    return request(piPackagePath("update", machineId), parsePiPackageMutationResponse, { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  },
};

export const machineStatusApi = {
  machineStatus: (machineId = "local") => request(`${machinePrefix(machineId)}/status`, requireMachineStatusSnapshot),
};

export const noticesApi = {
  snapshot: (machineId = "local") => request(`${machinePrefix(machineId)}/notices`, parseServerNoticeSnapshot, { cache: "no-store" }),
  dismiss: (machineId: string, daemonInstanceId: string, noticeId: string) => {
    const body: ServerNoticeDismissRequest = { daemonInstanceId, noticeId };
    return request(`${machinePrefix(machineId)}/notices/dismiss`, parseServerNoticeSnapshot, { method: "POST", body: JSON.stringify(body) });
  },
};

export const projectsApi = {
  projects: (machineId = "local") => request(`${machinePrefix(machineId)}/projects`, arrayOf(parseProject)),
  addProject: (path: string, name?: string, create?: boolean, machineId = "local") => request(`${machinePrefix(machineId)}/projects`, parseProject, { method: "POST", body: JSON.stringify({ path, name, create }) }),
  closeProject: (projectId: string, machineId = "local") => request(`${machinePrefix(machineId)}/projects/${encodeURIComponent(projectId)}`, parseClosed, { method: "DELETE" }),
  projectDirectories: (query: string, machineId = "local") => request(`${machinePrefix(machineId)}/project-directories?q=${encodeURIComponent(query)}`, arrayOf(parseFileSuggestion)),
};

function workspaceResolution(projectId: string, machineId = "local", options?: { signal?: AbortSignal }) {
  return request(
    `${machinePrefix(machineId)}/projects/${encodeURIComponent(projectId)}/workspaces`,
    (value) => {
      const resolution = parseWorkspaceProviderResolution(value);
      if (resolution.projectId !== projectId) throw new Error("Workspace resolution did not match the requested project");
      return resolution;
    },
    options?.signal === undefined ? undefined : { signal: options.signal },
  );
}

export const workspacesApi = {
  workspaceResolution,
  workspaces: async (projectId: string, machineId = "local", options?: { signal?: AbortSignal }) => [
    ...(await workspaceResolution(projectId, machineId, options)).workspaces,
  ],
  deleteWorkspace: (projectId: string, workspaceId: string, precondition: string, machineId = "local") => {
    const body: WorkspaceRemovalRequest = { precondition };
    return request(
      `${machinePrefix(machineId)}/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}`,
      (value): unknown => value,
      { method: "DELETE", body: JSON.stringify(body) },
    );
  },
  workspaceTree: (projectId: string, workspaceId: string, path = "", machineId = "local", options?: { signal?: AbortSignal }) => request(
    `${machinePrefix(machineId)}/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/tree?path=${encodeURIComponent(path)}`,
    parseFileTreeResponse,
    options?.signal === undefined ? undefined : { signal: options.signal },
  ),
  workspaceFile: (projectId: string, workspaceId: string, path: string, machineId = "local", options?: { signal?: AbortSignal }) => request(
    `${machinePrefix(machineId)}/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/file?path=${encodeURIComponent(path)}`,
    parseFileContentResponse,
    options?.signal === undefined ? undefined : { signal: options.signal },
  ),
  writeWorkspaceFile: (projectId: string, workspaceId: string, path: string, content: string | Uint8Array, options?: WriteWorkspaceFileOptions, machineId = "local") => {
    const params = new URLSearchParams({ path });
    if (options?.createDirs === false) params.set("createDirs", "false");
    if (options?.overwrite === false) params.set("overwrite", "false");
    const isBinary = content instanceof Uint8Array;
    const body: BodyInit = isBinary ? new Uint8Array(content) : new TextEncoder().encode(content);
    return request(
      `${machinePrefix(machineId)}/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/file?${params.toString()}`,
      parseWriteWorkspaceFileResponse,
      { method: "PUT", body, headers: { "Content-Type": isBinary ? "application/octet-stream" : "text/plain" } },
    );
  },
  deleteWorkspaceFile: (projectId: string, workspaceId: string, path: string, machineId = "local"): Promise<DeleteWorkspaceFileResponse> => {
    const params = new URLSearchParams({ path });
    return request(`${machinePrefix(machineId)}/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/file?${params.toString()}`, parseDeleteWorkspaceFileResponse, { method: "DELETE" });
  },
  moveWorkspaceFile: (projectId: string, workspaceId: string, fromPath: string, toPath: string, options?: MoveWorkspaceFileOptions, machineId = "local") => {
    const params = new URLSearchParams({ fromPath, toPath });
    if (options?.createDirs === false) params.set("createDirs", "false");
    if (options?.overwrite === true) params.set("overwrite", "true");
    return request(
      `${machinePrefix(machineId)}/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/file/move?${params.toString()}`,
      parseMoveWorkspaceFileResponse,
      { method: "POST" },
    );
  },
};

export const sessionsApi = {
  sessions: (cwd: string, machineId = "local", options?: { signal?: AbortSignal }) => request(
    `${machinePrefix(machineId)}/sessions?cwd=${encodeURIComponent(cwd)}`,
    arrayOf(parseSessionInfo),
    options?.signal === undefined ? undefined : { signal: options.signal },
  ),
  unreadCatalog: (machineId = "local") => request(`${machinePrefix(machineId)}/sessions/unread`, parseSessionUnreadCatalogSnapshot, { cache: "no-store" }),
  acknowledgeUnread: (session: SessionRef, catalogId: string, throughCompletionOrder: number, machineId = "local") => {
    const body: SessionUnreadAcknowledgeRequest = { cwd: session.cwd, catalogId, throughCompletionOrder };
    return request(sessionPath(session, "unread/acknowledge", machineId), parseSessionUnreadCatalogSnapshot, { method: "POST", body: JSON.stringify(body) });
  },
  notificationInbox: (session: SessionRef, machineId = "local") => request(sessionQueryPath(session, "notifications", machineId), parseSessionNotificationInboxSnapshot),
  dismissNotification: (session: SessionRef, daemonInstanceId: string, notificationId: string, machineId = "local") => request(sessionPath(session, "notifications/dismiss", machineId), parseSessionNotificationInboxSnapshot, { method: "POST", body: sessionBody(session, { daemonInstanceId, notificationId }) }),
  dismissAllNotifications: (session: SessionRef, daemonInstanceId: string, through: SessionNotificationDismissThrough, machineId = "local") => request(sessionPath(session, "notifications/dismiss-all", machineId), parseSessionNotificationInboxSnapshot, { method: "POST", body: sessionBody(session, { daemonInstanceId, throughOrder: through.order, throughOverflowWatermark: through.overflowWatermark }) }),
  startSession: (cwd: string, machineId = "local", startupToken?: string) => request(`${machinePrefix(machineId)}/sessions`, parseSessionInfo, { method: "POST", body: JSON.stringify(startupToken === undefined ? { cwd } : { cwd, startupToken }) }),
  cleanupPreview: (input: SessionCleanupRequest, machineId = "local") => request(`${machinePrefix(machineId)}/sessions/cleanup/preview`, parseSessionCleanupPreviewResponse, { method: "POST", body: JSON.stringify(input) }),
  cleanup: (input: SessionCleanupRequest, machineId = "local") => request(`${machinePrefix(machineId)}/sessions/cleanup`, parseSessionCleanupExecuteResponse, { method: "POST", body: JSON.stringify(input) }),
  archiveMany: (sessions: readonly SessionRef[], machineId = "local") => request(`${machinePrefix(machineId)}/sessions/bulk/archive`, parseSessionBulkArchiveResponse, { method: "POST", body: sessionBulkMutationBody(sessions) }),
  deleteArchivedMany: (sessions: readonly SessionRef[], machineId = "local") => request(`${machinePrefix(machineId)}/sessions/bulk/delete-archived`, parseSessionBulkDeleteArchivedResponse, { method: "POST", body: sessionBulkMutationBody(sessions) }),
  messages: (session: SessionRef, options?: { limit?: number; before?: number }, machineId = "local") => request(messagePath(session, options, machineId), parseMessagePage),
  status: (session: SessionRef, machineId = "local") => request(sessionQueryPath(session, "status", machineId), parseSessionStatus),
  streamSnapshot: (session: SessionRef, machineId = "local") => request(sessionQueryPath(session, "stream-snapshot", machineId), parseSessionStreamSnapshot),
  clearQueue: (session: SessionRef, machineId = "local") => request(sessionPath(session, "queue/clear", machineId), parseSessionStatus, { method: "POST", body: sessionBody(session) }),
  dismissWarning: (session: SessionRef, dismissId: string, machineId = "local") => request(sessionPath(session, "warnings/dismiss", machineId), parseSessionStatus, { method: "POST", body: sessionBody(session, { dismissId }) }),
  submitAsk: (session: SessionRef, askId: string, submission: AskUserSubmission, machineId = "local") => request(sessionPath(session, "ask/submit", machineId), parseAskUserCloseResponse, { method: "POST", body: sessionBody(session, { askId, answers: submission.answers }) }),
  cancelAsk: (session: SessionRef, askId: string, machineId = "local") => request(sessionPath(session, "ask/cancel", machineId), parseAskUserCloseResponse, { method: "POST", body: sessionBody(session, { askId }) }),
  answerDialog: (session: SessionRef, dialogId: string, value: ExtensionDialogAnswer, machineId = "local") => request(sessionPath(session, "dialogs/answer", machineId), parseExtensionDialogCloseResponse, { method: "POST", body: sessionBody(session, { dialogId, value }) }),
  cancelDialog: (session: SessionRef, dialogId: string, machineId = "local") => request(sessionPath(session, "dialogs/cancel", machineId), parseExtensionDialogCloseResponse, { method: "POST", body: sessionBody(session, { dialogId }) }),
  models: (session: SessionRef, machineId = "local") => request(sessionQueryPath(session, "models", machineId), parseModelSelectionResponse),
  modelCatalog: (session: SessionRef, machineId = "local") => request(sessionQueryPath(session, "models/catalog", machineId), parseSessionModelCatalogResponse),
  setModelEnabled: (session: SessionRef, provider: string, modelId: string, enabled: boolean, machineId = "local") => request(sessionPath(session, "models/enabled", machineId), parseSessionModelCatalogResponse, { method: "POST", body: sessionBody(session, { provider, modelId, enabled }) }),
  setModelScope: (session: SessionRef, mode: SessionModelScopeMode, machineId = "local") => request(sessionPath(session, "models/scope", machineId), parseSessionModelCatalogResponse, { method: "POST", body: sessionBody(session, { mode }) }),
  setModel: (session: SessionRef, provider: string, modelId: string, machineId = "local") => request(sessionPath(session, "model", machineId), parseSessionStatus, { method: "POST", body: sessionBody(session, { provider, modelId }) }),
  cycleModel: (session: SessionRef, direction: "forward" | "backward", machineId = "local") => request(sessionPath(session, "model/cycle", machineId), parseSessionStatus, { method: "POST", body: sessionBody(session, { direction }) }),
  thinkingLevels: (session: SessionRef, machineId = "local") => request(sessionQueryPath(session, "thinking-levels", machineId), parseThinkingLevelsResponse),
  setThinkingLevel: (session: SessionRef, level: string, machineId = "local") => request(sessionPath(session, "thinking-level", machineId), parseSessionStatus, { method: "POST", body: sessionBody(session, { level }) }),
  cycleThinkingLevel: (session: SessionRef, machineId = "local") => request(sessionPath(session, "thinking-level/cycle", machineId), parseSessionStatus, { method: "POST", body: sessionBody(session) }),
  commands: (session: SessionRef, machineId = "local") => request(sessionQueryPath(session, "commands", machineId), arrayOf(parseSlashCommand)),
  prompt: (session: SessionRef, text: string, streamingBehavior?: "steer" | "followUp", machineId = "local", attachments?: PromptAttachment[]) => request(sessionPath(session, "prompt", machineId), parseAccepted, { method: "POST", body: sessionBody(session, { text, ...(streamingBehavior === undefined ? {} : { streamingBehavior }), ...(attachments !== undefined && attachments.length > 0 ? { attachments } : {}) }) }),
  saveAttachments: (session: SessionRef, attachments: PromptAttachment[], machineId = "local", folder?: string) => request(sessionPath(session, "attachments", machineId), parseSavedAttachments, { method: "POST", body: sessionBody(session, { attachments, ...(folder === undefined ? {} : { folder }) }) }),
  shell: (session: SessionRef, text: string, machineId = "local") => request(sessionPath(session, "shell", machineId), parseAccepted, { method: "POST", body: sessionBody(session, { text }) }),
  runCommand: (session: SessionRef, text: string, machineId = "local") => request(sessionPath(session, "commands/run", machineId), parseCommandResult, { method: "POST", body: sessionBody(session, { text }) }),
  respondToCommand: (session: SessionRef, requestId: string, value: string, machineId = "local") => request(sessionPath(session, "commands/respond", machineId), parseCommandResult, { method: "POST", body: sessionBody(session, { requestId, value }) }),
  navigateTree: (session: SessionRef, navigation: SessionTreeNavigateRequest, machineId = "local") => request(sessionPath(session, "tree/navigate", machineId), parseSessionTreeNavigateResult, {
    method: "POST",
    body: sessionBody(session, { targetId: navigation.targetId, expectedLeafId: navigation.expectedLeafId, summary: navigation.summary }),
  }),
  forkTree: (session: SessionRef, fork: SessionTreeForkRequest, machineId = "local") => requestSessionTreeFork(session, fork, machineId),
  abort: (session: SessionRef, machineId = "local") => request(sessionPath(session, "abort", machineId), parseAborted, { method: "POST", body: sessionBody(session) }),
  stop: (session: SessionRef, machineId = "local") => request(sessionPath(session, "stop", machineId), parseStopped, { method: "POST", body: sessionBody(session) }),
  archive: (session: SessionRef, machineId = "local") => request(sessionPath(session, "archive", machineId), parseArchived, { method: "POST", body: sessionBody(session) }),
  archiveWithDescendants: (session: SessionRef, machineId = "local") => request(sessionPath(session, "archive-tree", machineId), parseArchived, { method: "POST", body: sessionBody(session) }),
  restore: (session: SessionRef, machineId = "local") => request(sessionPath(session, "restore", machineId), parseRestored, { method: "POST", body: sessionBody(session) }),
  detachParent: (session: SessionRef, machineId = "local") => request(sessionPath(session, "detach-parent", machineId), parseDetached, { method: "POST", body: sessionBody(session) }),
  reloadSession: (session: SessionRef, machineId = "local") => request(sessionPath(session, "reload", machineId), parseReloaded, { method: "POST", body: sessionBody(session) }),
  authProviders: (options?: { mode?: "login" | "logout"; authType?: "oauth" | "api_key"; machineId?: string }) => {
    const params = new URLSearchParams();
    if (options?.mode !== undefined) params.set("mode", options.mode);
    if (options?.authType !== undefined) params.set("authType", options.authType);
    const query = params.toString();
    return request(`${machinePrefix(options?.machineId)}/auth/providers${query === "" ? "" : `?${query}`}`, parseAuthProvidersResponse);
  },
  startInteractiveApiKeyLogin: (providerId: string, machineId = "local") => request(`${machinePrefix(machineId)}/auth/api-key/interactive`, parseOAuthFlowState, { method: "POST", body: JSON.stringify({ providerId }) }),
  logoutProvider: (providerId: string, machineId = "local") => request(`${machinePrefix(machineId)}/auth/logout`, parseAccepted, { method: "POST", body: JSON.stringify({ providerId }) }),
  startOAuthLogin: (providerId: string, machineId = "local") => request(`${machinePrefix(machineId)}/auth/oauth`, parseOAuthFlowState, { method: "POST", body: JSON.stringify({ providerId }) }),
  oauthFlow: (flowId: string, machineId = "local") => request(`${machinePrefix(machineId)}/auth/oauth/${encodeURIComponent(flowId)}`, parseOAuthFlowState),
  respondOAuthFlow: (flowId: string, requestId: string, value: string, machineId = "local") => request(`${machinePrefix(machineId)}/auth/oauth/${encodeURIComponent(flowId)}/respond`, parseOAuthFlowState, { method: "POST", body: JSON.stringify({ requestId, value }) }),
  cancelOAuthFlow: (flowId: string, machineId = "local") => request(`${machinePrefix(machineId)}/auth/oauth/${encodeURIComponent(flowId)}/cancel`, parseOAuthFlowState, { method: "POST" }),
};

/**
 * Raised when an older session daemon cannot serve the specific `tree/fork`
 * route. The message is user-facing and explains how to enable the operation.
 */
export class SessionTreeForkUnavailableError extends Error {
  constructor() {
    super("Fork from the session tree is unavailable. Restart the session daemon to enable it.");
    this.name = "SessionTreeForkUnavailableError";
  }
}

async function requestSessionTreeFork(session: SessionRef, fork: SessionTreeForkRequest, machineId: string): Promise<SessionTreeForkResult> {
  const response = await fetch(resolveAppUrl(sessionPath(session, "tree/fork", machineId)), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: sessionBody(session, { entryId: fork.entryId, expectedLeafId: fork.expectedLeafId }),
  });
  if (!response.ok) {
    const body: unknown = await response.json().catch((): unknown => ({}));
    if (isMissingSessionTreeForkRoute(response.status, body)) throw new SessionTreeForkUnavailableError();
    throw new Error(apiErrorMessage(body) ?? response.statusText);
  }
  return parseSessionTreeForkResult(await response.json());
}

function isMissingSessionTreeForkRoute(status: number, value: unknown): boolean {
  if (status !== 404 || !isRecord(value)) return false;
  if (value["statusCode"] !== 404 || value["error"] !== "Not Found") return false;
  const message = value["message"];
  return typeof message === "string" && /^Route POST:.*\/tree\/fork not found$/i.test(message);
}

function apiErrorMessage(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const error = value["error"];
  return typeof error === "string" ? error : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export interface FileSuggestionQueryOptions {
  kind?: FileSuggestion["kind"] | undefined;
  mode?: "file" | "path" | undefined;
  scope?: "tracked" | "all" | undefined;
  machineId?: string | undefined;
  projectId: string;
  workspaceId: string;
}

export const filesApi = {
  files: (query: string, options: FileSuggestionQueryOptions) => {
    const params = new URLSearchParams({ q: query });
    if (options.kind !== undefined) params.set("kind", options.kind);
    if (options.mode !== undefined) params.set("mode", options.mode);
    if (options.scope !== undefined) params.set("scope", options.scope);
    return request(`${machinePrefix(options.machineId)}/projects/${encodeURIComponent(options.projectId)}/workspaces/${encodeURIComponent(options.workspaceId)}/files?${params.toString()}`, arrayOf(parseFileSuggestion));
  },
};

const workspaceTrustPath = (machineId: string, projectId: string, workspaceId: string) =>
  `${machinePrefix(machineId)}/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/trust`;

const projectTrustPath = (machineId: string, path: string) => {
  const params = new URLSearchParams({ path });
  return `${machinePrefix(machineId)}/projects/trust?${params.toString()}`;
};

export const trustApi = {
  /** Existing-decision lookup for a raw path (add-project dialog); the server resolves the path first. */
  projectTrust: (path: string, machineId = "local") => request(projectTrustPath(machineId, path), parseWorkspaceTrustResponse),
  workspaceTrust: (projectId: string, workspaceId: string, machineId = "local") => request(workspaceTrustPath(machineId, projectId, workspaceId), parseWorkspaceTrustResponse),
  setWorkspaceTrust: (projectId: string, workspaceId: string, trusted: boolean, machineId = "local") => request(workspaceTrustPath(machineId, projectId, workspaceId), parseWorkspaceTrustResponse, { method: "PUT", body: JSON.stringify({ trusted }) }),
};

export const api = {
  ...piWebApi,
  ...machinesApi,
  ...noticesApi,
  ...configApi,
  ...pluginsApi,
  ...piPackagesApi,
  ...projectsApi,
  ...workspacesApi,
  ...sessionsApi,
  ...filesApi,
  ...trustApi,

};
