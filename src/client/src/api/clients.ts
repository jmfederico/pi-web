import type { FileSuggestion } from "../../../shared/apiTypes";
import { request } from "./http";
import {
  arrayOf,
  parseAborted,
  parseAccepted,
  parseArchived,
  parseAuthProvidersResponse,
  parseClosed,
  parseCommandResult,
  parseDetached,
  parseFileContentResponse,
  parseFileSuggestion,
  parseFileTreeResponse,
  parseGitDiffResponse,
  parseGitStatusResponse,
  parseMessagePage,
  parseModelSelectionResponse,
  parseOAuthFlowState,
  parsePiWebStatusResponse,
  parseProject,
  parseRestored,
  parseSessionInfo,
  parseSessionStatus,
  parseSlashCommand,
  parseStopped,
  parseTerminalInfo,
  parseThinkingLevelsResponse,
  parseWorkspace,
} from "./parsers";
import { gitDiffUrl, messageUrl } from "./urls";

export const piWebApi = {
  piWebStatus: () => request("/api/pi-web/status", parsePiWebStatusResponse),
};

export const projectsApi = {
  projects: () => request("/api/projects", arrayOf(parseProject)),
  addProject: (path: string, name?: string, create?: boolean) => request("/api/projects", parseProject, { method: "POST", body: JSON.stringify({ path, name, create }) }),
  closeProject: (projectId: string) => request(`/api/projects/${encodeURIComponent(projectId)}`, parseClosed, { method: "DELETE" }),
  projectDirectories: (query: string) => request(`/api/project-directories?q=${encodeURIComponent(query)}`, arrayOf(parseFileSuggestion)),
};

export const workspacesApi = {
  workspaces: (projectId: string) => request(`/api/projects/${projectId}/workspaces`, arrayOf(parseWorkspace)),
  workspaceTree: (projectId: string, workspaceId: string, path = "") => request(`/api/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/tree?path=${encodeURIComponent(path)}`, parseFileTreeResponse),
  workspaceFile: (projectId: string, workspaceId: string, path: string) => request(`/api/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/file?path=${encodeURIComponent(path)}`, parseFileContentResponse),
};

export const sessionsApi = {
  sessions: (cwd: string) => request(`/api/sessions?cwd=${encodeURIComponent(cwd)}`, arrayOf(parseSessionInfo)),
  startSession: (cwd: string) => request("/api/sessions", parseSessionInfo, { method: "POST", body: JSON.stringify({ cwd }) }),
  messages: (sessionId: string, options?: { limit?: number; before?: number }) => request(messageUrl(sessionId, options), parseMessagePage),
  status: (sessionId: string) => request(`/api/sessions/${sessionId}/status`, parseSessionStatus),
  models: (sessionId: string) => request(`/api/sessions/${sessionId}/models`, parseModelSelectionResponse),
  setModel: (sessionId: string, provider: string, modelId: string) => request(`/api/sessions/${sessionId}/model`, parseSessionStatus, { method: "POST", body: JSON.stringify({ provider, modelId }) }),
  cycleModel: (sessionId: string, direction: "forward" | "backward") => request(`/api/sessions/${sessionId}/model/cycle`, parseSessionStatus, { method: "POST", body: JSON.stringify({ direction }) }),
  thinkingLevels: (sessionId: string) => request(`/api/sessions/${sessionId}/thinking-levels`, parseThinkingLevelsResponse),
  setThinkingLevel: (sessionId: string, level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh") => request(`/api/sessions/${sessionId}/thinking-level`, parseSessionStatus, { method: "POST", body: JSON.stringify({ level }) }),
  cycleThinkingLevel: (sessionId: string) => request(`/api/sessions/${sessionId}/thinking-level/cycle`, parseSessionStatus, { method: "POST" }),
  commands: (sessionId: string) => request(`/api/sessions/${sessionId}/commands`, arrayOf(parseSlashCommand)),
  prompt: (sessionId: string, text: string, streamingBehavior?: "steer" | "followUp") => request(`/api/sessions/${sessionId}/prompt`, parseAccepted, { method: "POST", body: JSON.stringify(streamingBehavior === undefined ? { text } : { text, streamingBehavior }) }),
  shell: (sessionId: string, text: string) => request(`/api/sessions/${sessionId}/shell`, parseAccepted, { method: "POST", body: JSON.stringify({ text }) }),
  runCommand: (sessionId: string, text: string) => request(`/api/sessions/${sessionId}/commands/run`, parseCommandResult, { method: "POST", body: JSON.stringify({ text }) }),
  respondToCommand: (sessionId: string, requestId: string, value: string) => request(`/api/sessions/${sessionId}/commands/respond`, parseCommandResult, { method: "POST", body: JSON.stringify({ requestId, value }) }),
  abort: (sessionId: string) => request(`/api/sessions/${sessionId}/abort`, parseAborted, { method: "POST" }),
  stop: (sessionId: string) => request(`/api/sessions/${sessionId}/stop`, parseStopped, { method: "POST" }),
  archive: (sessionId: string) => request(`/api/sessions/${sessionId}/archive`, parseArchived, { method: "POST" }),
  restore: (sessionId: string) => request(`/api/sessions/${sessionId}/restore`, parseRestored, { method: "POST" }),
  detachParent: (sessionId: string) => request(`/api/sessions/${sessionId}/detach-parent`, parseDetached, { method: "POST" }),
  authProviders: (options?: { mode?: "login" | "logout"; authType?: "oauth" | "api_key" }) => {
    const params = new URLSearchParams();
    if (options?.mode !== undefined) params.set("mode", options.mode);
    if (options?.authType !== undefined) params.set("authType", options.authType);
    const query = params.toString();
    return request(`/api/auth/providers${query === "" ? "" : `?${query}`}`, parseAuthProvidersResponse);
  },
  saveApiKey: (providerId: string, key: string) => request("/api/auth/api-key", parseAccepted, { method: "POST", body: JSON.stringify({ providerId, key }) }),
  logoutProvider: (providerId: string) => request("/api/auth/logout", parseAccepted, { method: "POST", body: JSON.stringify({ providerId }) }),
  startOAuthLogin: (providerId: string) => request("/api/auth/oauth", parseOAuthFlowState, { method: "POST", body: JSON.stringify({ providerId }) }),
  oauthFlow: (flowId: string) => request(`/api/auth/oauth/${encodeURIComponent(flowId)}`, parseOAuthFlowState),
  respondOAuthFlow: (flowId: string, requestId: string, value: string) => request(`/api/auth/oauth/${encodeURIComponent(flowId)}/respond`, parseOAuthFlowState, { method: "POST", body: JSON.stringify({ requestId, value }) }),
  cancelOAuthFlow: (flowId: string) => request(`/api/auth/oauth/${encodeURIComponent(flowId)}/cancel`, parseOAuthFlowState, { method: "POST" }),
};

export const terminalsApi = {
  terminals: (projectId: string, workspaceId: string) => request(`/api/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/terminals`, arrayOf(parseTerminalInfo)),
  startTerminal: (projectId: string, workspaceId: string, options?: { name?: string; cols?: number; rows?: number }) => request(`/api/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/terminals`, parseTerminalInfo, { method: "POST", body: JSON.stringify(options ?? {}) }),
  closeTerminal: (projectId: string, workspaceId: string, terminalId: string) => request(`/api/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/terminals/${encodeURIComponent(terminalId)}`, parseClosed, { method: "DELETE" }),
};

export const filesApi = {
  files: (cwd: string, query: string, kind?: FileSuggestion["kind"], mode?: "file" | "path") => request(`/api/files?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(query)}${kind !== undefined ? `&kind=${encodeURIComponent(kind)}` : ""}${mode !== undefined ? `&mode=${encodeURIComponent(mode)}` : ""}`, arrayOf(parseFileSuggestion)),
};

export const gitApi = {
  gitStatus: (projectId: string, workspaceId: string) => request(`/api/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/git/status`, parseGitStatusResponse),
  gitDiff: (projectId: string, workspaceId: string, options?: { path?: string; staged?: boolean }) => request(gitDiffUrl(projectId, workspaceId, options), parseGitDiffResponse),
};

export const api = {
  ...piWebApi,
  ...projectsApi,
  ...workspacesApi,
  ...sessionsApi,
  ...terminalsApi,
  ...filesApi,
  ...gitApi,
};
