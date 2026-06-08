import type { FileSuggestion, PiWebConfigValues, RunTerminalCommandInput, TerminalCommandRun, TerminalCommandRunFilter } from "../../../shared/apiTypes";
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
  parseDetached,
  parseFileContentResponse,
  parseFileSuggestion,
  parseFileTreeResponse,
  parseGitDiffResponse,
  parseGitStatusResponse,
  parseMachine,
  parseMachineHealth,
  parseMachinesResponse,
  parseMessagePage,
  parseModelSelectionResponse,
  parseOAuthFlowState,
  parsePiWebConfigResponse,
  parsePiWebPluginsResponse,
  parsePiWebStatusResponse,
  parseProject,
  parseRestored,
  parseSessionInfo,
  parseSessionStatus,
  parseSlashCommand,
  parseStopped,
  parseTerminalCommandRun,
  parseTerminalInfo,
  parseThinkingLevelsResponse,
  parseWorkspace,
  parseWorkspaceActivityResponse,
} from "./parsers";
import { machineGitDiffUrl, messageUrl } from "./urls";

const machinePrefix = (machineId = "local") => `/api/machines/${encodeURIComponent(machineId)}`;

export const piWebApi = {
  piWebStatus: () => request("/api/pi-web/status", parsePiWebStatusResponse),
};

export const machinesApi = {
  machines: () => request("/api/machines", parseMachinesResponse),
  addMachine: (input: { name: string; baseUrl: string; token?: string }) => request("/api/machines", parseMachine, { method: "POST", body: JSON.stringify(input) }),
  deleteMachine: (machineId: string) => request(`/api/machines/${encodeURIComponent(machineId)}`, (value) => value, { method: "DELETE" }),
  health: (machineId: string) => request(`/api/machines/${encodeURIComponent(machineId)}/health`, parseMachineHealth),
};

export const configApi = {
  config: () => request("/api/config", parsePiWebConfigResponse),
  saveConfig: (config: PiWebConfigValues) => request("/api/config", parsePiWebConfigResponse, { method: "PUT", body: JSON.stringify({ config }) }),
};

export const pluginsApi = {
  plugins: () => request("/api/plugins", parsePiWebPluginsResponse),
};

export const activityApi = {
  workspaceActivity: (machineId = "local") => request(`${machinePrefix(machineId)}/activity`, parseWorkspaceActivityResponse),
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
};

export const sessionsApi = {
  sessions: (cwd: string, machineId = "local") => request(`${machinePrefix(machineId)}/sessions?cwd=${encodeURIComponent(cwd)}`, arrayOf(parseSessionInfo)),
  startSession: (cwd: string, machineId = "local") => request(`${machinePrefix(machineId)}/sessions`, parseSessionInfo, { method: "POST", body: JSON.stringify({ cwd }) }),
  messages: (sessionId: string, options?: { limit?: number; before?: number }, machineId = "local") => request(messageUrl(sessionId, options, machineId), parseMessagePage),
  status: (sessionId: string, machineId = "local") => request(`${machinePrefix(machineId)}/sessions/${sessionId}/status`, parseSessionStatus),
  models: (sessionId: string, machineId = "local") => request(`${machinePrefix(machineId)}/sessions/${sessionId}/models`, parseModelSelectionResponse),
  setModel: (sessionId: string, provider: string, modelId: string, machineId = "local") => request(`${machinePrefix(machineId)}/sessions/${sessionId}/model`, parseSessionStatus, { method: "POST", body: JSON.stringify({ provider, modelId }) }),
  cycleModel: (sessionId: string, direction: "forward" | "backward", machineId = "local") => request(`${machinePrefix(machineId)}/sessions/${sessionId}/model/cycle`, parseSessionStatus, { method: "POST", body: JSON.stringify({ direction }) }),
  thinkingLevels: (sessionId: string, machineId = "local") => request(`${machinePrefix(machineId)}/sessions/${sessionId}/thinking-levels`, parseThinkingLevelsResponse),
  setThinkingLevel: (sessionId: string, level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh", machineId = "local") => request(`${machinePrefix(machineId)}/sessions/${sessionId}/thinking-level`, parseSessionStatus, { method: "POST", body: JSON.stringify({ level }) }),
  cycleThinkingLevel: (sessionId: string, machineId = "local") => request(`${machinePrefix(machineId)}/sessions/${sessionId}/thinking-level/cycle`, parseSessionStatus, { method: "POST" }),
  commands: (sessionId: string, machineId = "local") => request(`${machinePrefix(machineId)}/sessions/${sessionId}/commands`, arrayOf(parseSlashCommand)),
  prompt: (sessionId: string, text: string, streamingBehavior?: "steer" | "followUp", machineId = "local") => request(`${machinePrefix(machineId)}/sessions/${sessionId}/prompt`, parseAccepted, { method: "POST", body: JSON.stringify(streamingBehavior === undefined ? { text } : { text, streamingBehavior }) }),
  shell: (sessionId: string, text: string, machineId = "local") => request(`${machinePrefix(machineId)}/sessions/${sessionId}/shell`, parseAccepted, { method: "POST", body: JSON.stringify({ text }) }),
  runCommand: (sessionId: string, text: string, machineId = "local") => request(`${machinePrefix(machineId)}/sessions/${sessionId}/commands/run`, parseCommandResult, { method: "POST", body: JSON.stringify({ text }) }),
  respondToCommand: (sessionId: string, requestId: string, value: string, machineId = "local") => request(`${machinePrefix(machineId)}/sessions/${sessionId}/commands/respond`, parseCommandResult, { method: "POST", body: JSON.stringify({ requestId, value }) }),
  abort: (sessionId: string, machineId = "local") => request(`${machinePrefix(machineId)}/sessions/${sessionId}/abort`, parseAborted, { method: "POST" }),
  stop: (sessionId: string, machineId = "local") => request(`${machinePrefix(machineId)}/sessions/${sessionId}/stop`, parseStopped, { method: "POST" }),
  archive: (sessionId: string, machineId = "local") => request(`${machinePrefix(machineId)}/sessions/${sessionId}/archive`, parseArchived, { method: "POST" }),
  archiveWithDescendants: (sessionId: string, machineId = "local") => request(`${machinePrefix(machineId)}/sessions/${sessionId}/archive-tree`, parseArchived, { method: "POST" }),
  restore: (sessionId: string, machineId = "local") => request(`${machinePrefix(machineId)}/sessions/${sessionId}/restore`, parseRestored, { method: "POST" }),
  deleteArchived: (sessionId: string, machineId = "local") => request(`${machinePrefix(machineId)}/sessions/${sessionId}`, parseDeleted, { method: "DELETE" }),
  detachParent: (sessionId: string, machineId = "local") => request(`${machinePrefix(machineId)}/sessions/${sessionId}/detach-parent`, parseDetached, { method: "POST" }),
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
}

export const filesApi = {
  files: (cwd: string, query: string, options: FileSuggestionQueryOptions = {}) => {
    const params = new URLSearchParams({ cwd, q: query });
    if (options.kind !== undefined) params.set("kind", options.kind);
    if (options.mode !== undefined) params.set("mode", options.mode);
    if (options.scope !== undefined) params.set("scope", options.scope);
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
  ...activityApi,
  ...projectsApi,
  ...workspacesApi,
  ...sessionsApi,
  ...terminalsApi,
  ...filesApi,
  ...gitApi,
};
