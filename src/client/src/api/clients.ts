import type { FileSuggestion } from "../../../shared/apiTypes";
import { request } from "./http";
import {
  arrayOf,
  parseAborted,
  parseAccepted,
  parseArchived,
  parseClosed,
  parseCommandResult,
  parseFileContentResponse,
  parseFileSuggestion,
  parseFileTreeResponse,
  parseGitDiffResponse,
  parseGitStatusResponse,
  parseMessagePage,
  parseProject,
  parseRestored,
  parseSessionInfo,
  parseSessionStatus,
  parseSlashCommand,
  parseStopped,
  parseWorkspace,
} from "./parsers";
import { gitDiffUrl, messageUrl } from "./urls";

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
  commands: (sessionId: string) => request(`/api/sessions/${sessionId}/commands`, arrayOf(parseSlashCommand)),
  prompt: (sessionId: string, text: string, streamingBehavior?: "steer" | "followUp") => request(`/api/sessions/${sessionId}/prompt`, parseAccepted, { method: "POST", body: JSON.stringify(streamingBehavior === undefined ? { text } : { text, streamingBehavior }) }),
  shell: (sessionId: string, text: string) => request(`/api/sessions/${sessionId}/shell`, parseAccepted, { method: "POST", body: JSON.stringify({ text }) }),
  runCommand: (sessionId: string, text: string) => request(`/api/sessions/${sessionId}/commands/run`, parseCommandResult, { method: "POST", body: JSON.stringify({ text }) }),
  respondToCommand: (sessionId: string, requestId: string, value: string) => request(`/api/sessions/${sessionId}/commands/respond`, parseCommandResult, { method: "POST", body: JSON.stringify({ requestId, value }) }),
  abort: (sessionId: string) => request(`/api/sessions/${sessionId}/abort`, parseAborted, { method: "POST" }),
  stop: (sessionId: string) => request(`/api/sessions/${sessionId}/stop`, parseStopped, { method: "POST" }),
  archive: (sessionId: string) => request(`/api/sessions/${sessionId}/archive`, parseArchived, { method: "POST" }),
  restore: (sessionId: string) => request(`/api/sessions/${sessionId}/restore`, parseRestored, { method: "POST" }),
};

export const filesApi = {
  files: (cwd: string, query: string, kind?: FileSuggestion["kind"], mode?: "file" | "path") => request(`/api/files?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(query)}${kind !== undefined ? `&kind=${encodeURIComponent(kind)}` : ""}${mode !== undefined ? `&mode=${encodeURIComponent(mode)}` : ""}`, arrayOf(parseFileSuggestion)),
};

export const gitApi = {
  gitStatus: (projectId: string, workspaceId: string) => request(`/api/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/git/status`, parseGitStatusResponse),
  gitDiff: (projectId: string, workspaceId: string, options?: { path?: string; staged?: boolean }) => request(gitDiffUrl(projectId, workspaceId, options), parseGitDiffResponse),
};

export const api = {
  ...projectsApi,
  ...workspacesApi,
  ...sessionsApi,
  ...filesApi,
  ...gitApi,
};
