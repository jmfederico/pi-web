import type { DeleteWorkspaceFileResponse, FileSuggestion, MoveWorkspaceFileOptions, PiPackageInstallRequest, PiPackageRemoveRequest, PiPackageScope, PiPackageUpdateRequest, PiWebConfigValues, PromptAttachment, RunTerminalCommandInput, SessionBulkMutationRef, SessionCleanupRequest, SessionRef, TerminalCommandRun, TerminalCommandRunFilter, WriteWorkspaceFileOptions } from "../../../shared/apiTypes";
import { request } from "./http";
import {
  arrayOf,
  parseAborted,
  parseAccepted,
  parseArchived,
  parseAuthProvidersResponse,
  parseClosed,
  parseCommandResult,
  parseDeleted,
  parseDeleteWorkspaceFileResponse,
  parseDetached,
  parseFileContentResponse,
  parseFileSuggestion,
  parseFileTreeResponse,
  parseGitDiffResponse,
  parseGitStatusResponse,
  parseMachine,
  parseMachineHealth,
  parseMachineRuntime,
  parseMachinesResponse,
  parseMessagePage,
  parseModelSelectionResponse,
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
  parseSessionStatus,
  parseSlashCommand,
  parseStopped,
  parseSubscribed,
  parseTerminalCommandRun,
  parseTerminalInfo,
  parseThinkingLevelsResponse,
  parseUnsubscribed,
  parseVapidPublicKeyResponse,
  parseWriteWorkspaceFileResponse,
  parseWorkspace,
  parseWorkspaceActivityResponse,
} from "./parsers";
import { machineGitDiffUrl, messageUrl } from "./urls";

const machinePrefix = (machineId = "local") => `/api/machines/${encodeURIComponent(machineId)}`;

type SessionLookup = SessionRef | string;

function sessionId(session: SessionLookup): string {
  return typeof session === "string" ? session : session.id;
}

function sessionCwd(session: SessionLookup): string | undefined {
  return typeof session === "string" ? undefined : session.cwd;
}

function sessionBaseUrl(session: SessionLookup, machineId = "local"): string {
  return `${machinePrefix(machineId)}/sessions/${encodeURIComponent(sessionId(session))}`;
}

function sessionUrl(session: SessionLookup, endpoint: string, machineId = "local"): string {
  return `${sessionBaseUrl(session, machineId)}/${endpoint}`;
}

function sessionQueryUrl(session: SessionLookup, endpoint: string, machineId = "local"): string {
  return `${sessionUrl(session, endpoint, machineId)}${sessionQuery(session)}`;
}

function sessionBaseQueryUrl(session: SessionLookup, machineId = "local"): string {
  return `${sessionBaseUrl(session, machineId)}${sessionQuery(session)}`;
}

function sessionQuery(session: SessionLookup): string {
  const cwd = sessionCwd(session);
  return cwd === undefined || cwd === "" ? "" : `?${new URLSearchParams({ cwd }).toString()}`;
}

function sessionBody(session: SessionLookup, fields: Record<string, unknown> = {}): string {
  const cwd = sessionCwd(session);
  return JSON.stringify(cwd === undefined || cwd === "" ? fields : { cwd, ...fields });
}

function sessionBulkMutationBody(sessions: readonly SessionLookup[]): string {
  return JSON.stringify({ sessions: sessions.map(sessionBulkMutationRef) });
}

function sessionBulkMutationRef(session: SessionLookup): SessionBulkMutationRef {
  const id = sessionId(session);
  const cwd = sessionCwd(session);
  return cwd === undefined || cwd === "" ? { id } : { id, cwd };
}

export const piWebApi = {
  piWebStatus: (machineId = "local") => request(machineId === "local" ? "/api/pi-web/status" : `${machinePrefix(machineId)}/pi-web/status`, parsePiWebStatusResponse),
  piWebRuntime: () => request("/api/pi-web/runtime", parsePiWebRuntimeResponse),
};

export const machinesApi = {
  machines: () => request("/api/machines", parseMachinesResponse),
  addMachine: (input: { name: string; baseUrl: string; token?: string }) => request("/api/machines", parseMachine, { method: "POST", body: JSON.stringify(input) }),
  deleteMachine: (machineId: string) => request(`/api/machines/${encodeURIComponent(machineId)}`, (value) => value, { method: "DELETE" }),
  health: (machineId: string) => request(`/api/machines/${encodeURIComponent(machineId)}/health`, parseMachineHealth),
  runtime: (machineId: string) => request(`/api/machines/${encodeURIComponent(machineId)}/runtime`, parseMachineRuntime),
};

function configUrl(machineId?: string): string {
  return machineId === undefined ? "/api/config" : `${machinePrefix(machineId)}/config`;
}

function pluginsUrl(machineId?: string): string {
  return machineId === undefined ? "/api/plugins" : `${machinePrefix(machineId)}/plugins`;
}

export const configApi = {
  config: (machineId?: string) => request(configUrl(machineId), parsePiWebConfigResponse),
  saveConfig: (config: PiWebConfigValues, machineId?: string) => request(configUrl(machineId), parsePiWebConfigResponse, { method: "PUT", body: JSON.stringify({ config }) }),
};

export const pluginsApi = {
  plugins: (machineId?: string) => request(pluginsUrl(machineId), parsePiWebPluginsResponse),
};

function piPackageUrl(endpoint = "", machineId?: string): string {
  const baseUrl = machineId === undefined ? "/api/pi-packages" : `${machinePrefix(machineId)}/pi-packages`;
  return endpoint === "" ? baseUrl : `${baseUrl}/${endpoint}`;
}

export const piPackagesApi = {
  packages: (machineId?: string) => request(piPackageUrl("", machineId), parsePiPackagesResponse),
  install: (source: string, machineId?: string) => {
    const body: PiPackageInstallRequest = { source };
    return request(piPackageUrl("install", machineId), parsePiPackageMutationResponse, { method: "POST", body: JSON.stringify(body) });
  },
  remove: (source: string, scope?: PiPackageScope, machineId?: string) => {
    const body: PiPackageRemoveRequest = scope === undefined ? { source } : { source, scope };
    return request(piPackageUrl("remove", machineId), parsePiPackageMutationResponse, { method: "POST", body: JSON.stringify(body) });
  },
  update: (source?: string, machineId?: string) => {
    const body: PiPackageUpdateRequest | undefined = source === undefined ? undefined : { source };
    return request(piPackageUrl("update", machineId), parsePiPackageMutationResponse, { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  },
};

export const activityApi = {
  workspaceActivity: (machineId = "local") => request(`${machinePrefix(machineId)}/activity`, parseWorkspaceActivityResponse),
};

export interface PushSubscriptionRequest {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export const pushApi = {
  vapidPublicKey: () => request("/api/push/vapid-public-key", parseVapidPublicKeyResponse),
  subscribe: (subscription: PushSubscriptionRequest) => request("/api/push/subscribe", parseSubscribed, { method: "POST", body: JSON.stringify(subscription) }),
  unsubscribe: (endpoint: string) => request("/api/push/unsubscribe", parseUnsubscribed, { method: "DELETE", body: JSON.stringify({ endpoint }) }),
};

export const projectsApi = {
  projects: (machineId = "local") => request(`${machinePrefix(machineId)}/projects`, arrayOf(parseProject)),
  addProject: (path: string, name?: string, create?: boolean, machineId = "local") => request(`${machinePrefix(machineId)}/projects`, parseProject, { method: "POST", body: JSON.stringify({ path, name, create }) }),
  closeProject: (projectId: string, machineId = "local") => request(`${machinePrefix(machineId)}/projects/${encodeURIComponent(projectId)}`, parseClosed, { method: "DELETE" }),
  projectDirectories: (query: string, machineId = "local") => request(`${machinePrefix(machineId)}/project-directories?q=${encodeURIComponent(query)}`, arrayOf(parseFileSuggestion)),
};

export const workspacesApi = {
  workspaces: (projectId: string, machineId = "local") => request(`${machinePrefix(machineId)}/projects/${projectId}/workspaces`, arrayOf(parseWorkspace)),
  deleteWorkspace: (projectId: string, workspaceId: string, machineId = "local") => request(`${machinePrefix(machineId)}/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}`, parseTerminalCommandRun, { method: "DELETE" }),
  workspaceTree: (projectId: string, workspaceId: string, path = "", machineId = "local") => request(`${machinePrefix(machineId)}/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/tree?path=${encodeURIComponent(path)}`, parseFileTreeResponse),
  workspaceFile: (projectId: string, workspaceId: string, path: string, machineId = "local") => request(`${machinePrefix(machineId)}/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/file?path=${encodeURIComponent(path)}`, parseFileContentResponse),
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
  sessions: (cwd: string, machineId = "local") => request(`${machinePrefix(machineId)}/sessions?cwd=${encodeURIComponent(cwd)}`, arrayOf(parseSessionInfo)),
  startSession: (cwd: string, machineId = "local") => request(`${machinePrefix(machineId)}/sessions`, parseSessionInfo, { method: "POST", body: JSON.stringify({ cwd }) }),
  cleanupPreview: (input: SessionCleanupRequest, machineId = "local") => request(`${machinePrefix(machineId)}/sessions/cleanup/preview`, parseSessionCleanupPreviewResponse, { method: "POST", body: JSON.stringify(input) }),
  cleanup: (input: SessionCleanupRequest, machineId = "local") => request(`${machinePrefix(machineId)}/sessions/cleanup`, parseSessionCleanupExecuteResponse, { method: "POST", body: JSON.stringify(input) }),
  archiveMany: (sessions: readonly SessionLookup[], machineId = "local") => request(`${machinePrefix(machineId)}/sessions/bulk/archive`, parseSessionBulkArchiveResponse, { method: "POST", body: sessionBulkMutationBody(sessions) }),
  deleteArchivedMany: (sessions: readonly SessionLookup[], machineId = "local") => request(`${machinePrefix(machineId)}/sessions/bulk/delete-archived`, parseSessionBulkDeleteArchivedResponse, { method: "POST", body: sessionBulkMutationBody(sessions) }),
  messages: (session: SessionLookup, options?: { limit?: number; before?: number }, machineId = "local") => request(messageUrl(session, options, machineId), parseMessagePage),
  status: (session: SessionLookup, machineId = "local") => request(sessionQueryUrl(session, "status", machineId), parseSessionStatus),
  models: (session: SessionLookup, machineId = "local") => request(sessionQueryUrl(session, "models", machineId), parseModelSelectionResponse),
  setModel: (session: SessionLookup, provider: string, modelId: string, machineId = "local") => request(sessionUrl(session, "model", machineId), parseSessionStatus, { method: "POST", body: sessionBody(session, { provider, modelId }) }),
  cycleModel: (session: SessionLookup, direction: "forward" | "backward", machineId = "local") => request(sessionUrl(session, "model/cycle", machineId), parseSessionStatus, { method: "POST", body: sessionBody(session, { direction }) }),
  thinkingLevels: (session: SessionLookup, machineId = "local") => request(sessionQueryUrl(session, "thinking-levels", machineId), parseThinkingLevelsResponse),
  setThinkingLevel: (session: SessionLookup, level: string, machineId = "local") => request(sessionUrl(session, "thinking-level", machineId), parseSessionStatus, { method: "POST", body: sessionBody(session, { level }) }),
  cycleThinkingLevel: (session: SessionLookup, machineId = "local") => request(sessionUrl(session, "thinking-level/cycle", machineId), parseSessionStatus, { method: "POST", body: sessionBody(session) }),
  commands: (session: SessionLookup, machineId = "local") => request(sessionQueryUrl(session, "commands", machineId), arrayOf(parseSlashCommand)),
  prompt: (session: SessionLookup, text: string, streamingBehavior?: "steer" | "followUp", machineId = "local", attachments?: PromptAttachment[]) => request(sessionUrl(session, "prompt", machineId), parseAccepted, { method: "POST", body: sessionBody(session, { text, ...(streamingBehavior === undefined ? {} : { streamingBehavior }), ...(attachments !== undefined && attachments.length > 0 ? { attachments } : {}) }) }),
  saveAttachments: (session: SessionLookup, attachments: PromptAttachment[], machineId = "local", folder?: string) => request(sessionUrl(session, "attachments", machineId), parseSavedAttachments, { method: "POST", body: sessionBody(session, { attachments, ...(folder === undefined ? {} : { folder }) }) }),
  shell: (session: SessionLookup, text: string, machineId = "local") => request(sessionUrl(session, "shell", machineId), parseAccepted, { method: "POST", body: sessionBody(session, { text }) }),
  runCommand: (session: SessionLookup, text: string, machineId = "local") => request(sessionUrl(session, "commands/run", machineId), parseCommandResult, { method: "POST", body: sessionBody(session, { text }) }),
  respondToCommand: (session: SessionLookup, requestId: string, value: string, machineId = "local") => request(sessionUrl(session, "commands/respond", machineId), parseCommandResult, { method: "POST", body: sessionBody(session, { requestId, value }) }),
  abort: (session: SessionLookup, machineId = "local") => request(sessionUrl(session, "abort", machineId), parseAborted, { method: "POST", body: sessionBody(session) }),
  stop: (session: SessionLookup, machineId = "local") => request(sessionUrl(session, "stop", machineId), parseStopped, { method: "POST", body: sessionBody(session) }),
  archive: (session: SessionLookup, machineId = "local") => request(sessionUrl(session, "archive", machineId), parseArchived, { method: "POST", body: sessionBody(session) }),
  archiveWithDescendants: (session: SessionLookup, machineId = "local") => request(sessionUrl(session, "archive-tree", machineId), parseArchived, { method: "POST", body: sessionBody(session) }),
  restore: (session: SessionLookup, machineId = "local") => request(sessionUrl(session, "restore", machineId), parseRestored, { method: "POST", body: sessionBody(session) }),
  deleteArchived: (session: SessionLookup, machineId = "local") => request(sessionBaseQueryUrl(session, machineId), parseDeleted, { method: "DELETE" }),
  detachParent: (session: SessionLookup, machineId = "local") => request(sessionUrl(session, "detach-parent", machineId), parseDetached, { method: "POST", body: sessionBody(session) }),
  reloadSession: (session: SessionLookup, machineId = "local") => request(sessionUrl(session, "reload", machineId), parseReloaded, { method: "POST", body: sessionBody(session) }),
  authProviders: (options?: { mode?: "login" | "logout"; authType?: "oauth" | "api_key"; machineId?: string }) => {
    const params = new URLSearchParams();
    if (options?.mode !== undefined) params.set("mode", options.mode);
    if (options?.authType !== undefined) params.set("authType", options.authType);
    const query = params.toString();
    return request(`${machinePrefix(options?.machineId)}/auth/providers${query === "" ? "" : `?${query}`}`, parseAuthProvidersResponse);
  },
  saveApiKey: (providerId: string, key: string, machineId = "local") => request(`${machinePrefix(machineId)}/auth/api-key`, parseAccepted, { method: "POST", body: JSON.stringify({ providerId, key }) }),
  logoutProvider: (providerId: string, machineId = "local") => request(`${machinePrefix(machineId)}/auth/logout`, parseAccepted, { method: "POST", body: JSON.stringify({ providerId }) }),
  startOAuthLogin: (providerId: string, machineId = "local") => request(`${machinePrefix(machineId)}/auth/oauth`, parseOAuthFlowState, { method: "POST", body: JSON.stringify({ providerId }) }),
  oauthFlow: (flowId: string, machineId = "local") => request(`${machinePrefix(machineId)}/auth/oauth/${encodeURIComponent(flowId)}`, parseOAuthFlowState),
  respondOAuthFlow: (flowId: string, requestId: string, value: string, machineId = "local") => request(`${machinePrefix(machineId)}/auth/oauth/${encodeURIComponent(flowId)}/respond`, parseOAuthFlowState, { method: "POST", body: JSON.stringify({ requestId, value }) }),
  cancelOAuthFlow: (flowId: string, machineId = "local") => request(`${machinePrefix(machineId)}/auth/oauth/${encodeURIComponent(flowId)}/cancel`, parseOAuthFlowState, { method: "POST" }),
};

export const terminalsApi = {
  terminals: (projectId: string, workspaceId: string, machineId = "local") => request(`${machinePrefix(machineId)}/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/terminals`, arrayOf(parseTerminalInfo)),
  startTerminal: (projectId: string, workspaceId: string, options?: { name?: string; cols?: number; rows?: number }, machineId = "local") => request(`${machinePrefix(machineId)}/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/terminals`, parseTerminalInfo, { method: "POST", body: JSON.stringify(options ?? {}) }),
  closeWorkspaceTerminals: (projectId: string, workspaceId: string, machineId = "local") => request(`${machinePrefix(machineId)}/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/terminals`, parseClosed, { method: "DELETE" }),
  closeTerminal: (projectId: string, workspaceId: string, terminalId: string, machineId = "local") => request(`${machinePrefix(machineId)}/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/terminals/${encodeURIComponent(terminalId)}`, parseClosed, { method: "DELETE" }),
  continueTerminal: (projectId: string, workspaceId: string, terminalId: string, machineId = "local") => request(`${machinePrefix(machineId)}/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/terminals/${encodeURIComponent(terminalId)}/continue`, parseTerminalInfo, { method: "POST" }),
  runTerminalCommand: (origin: string, input: RunTerminalCommandInput, machineId = "local") => request(`${machinePrefix(machineId)}/projects/${encodeURIComponent(input.workspace.projectId)}/workspaces/${encodeURIComponent(input.workspace.id)}/terminal-command-runs`, parseTerminalCommandRun, { method: "POST", body: JSON.stringify({ origin, title: input.title, command: input.command, metadata: input.metadata ?? {} }) }),
  listCommandRuns: (filter?: TerminalCommandRunFilter, machineId = "local") => request(`${machinePrefix(machineId)}/terminal-command-runs${terminalCommandRunFilterQuery(filter)}`, arrayOf(parseTerminalCommandRun)),
  getCommandRun: (runId: string, machineId = "local") => getOptionalTerminalCommandRun(runId, machineId),
  cancelCommandRun: (runId: string, machineId = "local") => request(`${machinePrefix(machineId)}/terminal-command-runs/${encodeURIComponent(runId)}/cancel`, parseTerminalCommandRun, { method: "POST" }),
};

async function getOptionalTerminalCommandRun(runId: string, machineId: string): Promise<TerminalCommandRun | undefined> {
  const response = await fetch(`${machinePrefix(machineId)}/terminal-command-runs/${encodeURIComponent(runId)}`);
  if (response.status === 404) return undefined;
  if (!response.ok) {
    const body: unknown = await response.json().catch((): unknown => ({}));
    throw new Error(apiErrorMessage(body) ?? response.statusText);
  }
  return parseTerminalCommandRun(await response.json());
}

function terminalCommandRunFilterQuery(filter: TerminalCommandRunFilter | undefined): string {
  if (filter === undefined) return "";
  const params = new URLSearchParams();
  if (filter.projectId !== undefined) params.set("projectId", filter.projectId);
  if (filter.workspaceId !== undefined) params.set("workspaceId", filter.workspaceId);
  if (filter.terminalId !== undefined) params.set("terminalId", filter.terminalId);
  if (filter.statuses !== undefined && filter.statuses.length > 0) params.set("statuses", filter.statuses.join(","));
  if (filter.metadata !== undefined && Object.keys(filter.metadata).length > 0) params.set("metadata", JSON.stringify(filter.metadata));
  const query = params.toString();
  return query === "" ? "" : `?${query}`;
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
  projectId?: string | undefined;
  workspaceId?: string | undefined;
  workspaceScoped?: boolean | undefined;
}

export const filesApi = {
  files: (cwd: string, query: string, options: FileSuggestionQueryOptions = {}) => {
    const params = new URLSearchParams({ q: query });
    if (options.kind !== undefined) params.set("kind", options.kind);
    if (options.mode !== undefined) params.set("mode", options.mode);
    if (options.scope !== undefined) params.set("scope", options.scope);
    if (options.workspaceScoped === true && options.projectId !== undefined && options.workspaceId !== undefined) {
      return request(`${machinePrefix(options.machineId)}/projects/${encodeURIComponent(options.projectId)}/workspaces/${encodeURIComponent(options.workspaceId)}/files?${params.toString()}`, arrayOf(parseFileSuggestion));
    }
    params.set("cwd", cwd);
    return request(`${machinePrefix(options.machineId)}/files?${params.toString()}`, arrayOf(parseFileSuggestion));
  },
};

export const gitApi = {
  gitStatus: (projectId: string, workspaceId: string, machineId = "local") => request(`${machinePrefix(machineId)}/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/git/status`, parseGitStatusResponse),
  gitDiff: (projectId: string, workspaceId: string, options?: { path?: string; staged?: boolean }, machineId = "local") => request(machineGitDiffUrl(machineId, projectId, workspaceId, options), parseGitDiffResponse),
};

export const api = {
  ...piWebApi,
  ...machinesApi,
  ...configApi,
  ...pluginsApi,
  ...piPackagesApi,
  ...activityApi,
  ...projectsApi,
  ...workspacesApi,
  ...sessionsApi,
  ...terminalsApi,
  ...filesApi,
  ...gitApi,
};
