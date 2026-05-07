export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: string;
}

export interface Workspace {
  id: string;
  projectId: string;
  path: string;
  label: string;
  branch?: string;
  isMain: boolean;
  isGitWorktree: boolean;
}

export interface SessionInfo {
  id: string;
  path: string;
  cwd: string;
  name?: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
  archived?: boolean;
  archivedAt?: string;
}

export interface SessionActivity {
  sessionId: string;
  phase: "active" | "idle" | "error";
  label: string;
  detail?: string;
  at: string;
}

export interface SessionStatus {
  sessionId: string;
  model?: { provider?: string; id?: string; name?: string; contextWindow?: number; reasoning?: unknown };
  thinkingLevel?: string;
  isStreaming: boolean;
  isCompacting: boolean;
  isBashRunning: boolean;
  pendingMessageCount: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost: number;
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
}

export interface SlashCommand {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill" | "builtin";
}

export interface FileSuggestion {
  path: string;
  kind: "tracked" | "untracked" | "other";
}

export interface CommandOption {
  value: string;
  label: string;
  description?: string;
}

export interface MessagePage {
  messages: unknown[];
  start: number;
  total: number;
}

export type CommandResult =
  | { type: "done"; message?: string; session?: SessionInfo }
  | { type: "select"; requestId: string; title: string; options: CommandOption[] }
  | { type: "unsupported"; message: string };

async function request<T>(url: string, parse: (value: unknown) => T, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined) headers.set("content-type", "application/json");
  const response = await fetch(url, { ...init, headers });
  if (!response.ok) {
    const body: unknown = await response.json().catch((): unknown => ({}));
    throw new Error(errorMessage(body) ?? response.statusText);
  }
  const body: unknown = await response.json();
  return parse(body);
}

function errorMessage(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value["error"] === "string" ? value["error"] : undefined;
}

export const api = {
  projects: () => request("/api/projects", arrayOf(parseProject)),
  addProject: (path: string, name?: string) => request("/api/projects", parseProject, { method: "POST", body: JSON.stringify({ path, name }) }),
  workspaces: (projectId: string) => request(`/api/projects/${projectId}/workspaces`, arrayOf(parseWorkspace)),
  sessions: (cwd: string) => request(`/api/sessions?cwd=${encodeURIComponent(cwd)}`, arrayOf(parseSessionInfo)),
  startSession: (cwd: string) => request("/api/sessions", parseSessionInfo, { method: "POST", body: JSON.stringify({ cwd }) }),
  messages: (sessionId: string, options?: { limit?: number; before?: number }) => request(messageUrl(sessionId, options), parseMessagePage),
  status: (sessionId: string) => request(`/api/sessions/${sessionId}/status`, parseSessionStatus),
  commands: (sessionId: string) => request(`/api/sessions/${sessionId}/commands`, arrayOf(parseSlashCommand)),
  files: (cwd: string, query: string, kind?: FileSuggestion["kind"], mode?: "file" | "path") => request(`/api/files?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(query)}${kind !== undefined ? `&kind=${encodeURIComponent(kind)}` : ""}${mode !== undefined ? `&mode=${encodeURIComponent(mode)}` : ""}`, arrayOf(parseFileSuggestion)),
  prompt: (sessionId: string, text: string, streamingBehavior?: "steer" | "followUp") => request(`/api/sessions/${sessionId}/prompt`, parseAccepted, { method: "POST", body: JSON.stringify(streamingBehavior === undefined ? { text } : { text, streamingBehavior }) }),
  shell: (sessionId: string, text: string) => request(`/api/sessions/${sessionId}/shell`, parseAccepted, { method: "POST", body: JSON.stringify({ text }) }),
  runCommand: (sessionId: string, text: string) => request(`/api/sessions/${sessionId}/commands/run`, parseCommandResult, { method: "POST", body: JSON.stringify({ text }) }),
  respondToCommand: (sessionId: string, requestId: string, value: string) => request(`/api/sessions/${sessionId}/commands/respond`, parseCommandResult, { method: "POST", body: JSON.stringify({ requestId, value }) }),
  abort: (sessionId: string) => request(`/api/sessions/${sessionId}/abort`, parseAborted, { method: "POST" }),
  stop: (sessionId: string) => request(`/api/sessions/${sessionId}/stop`, parseStopped, { method: "POST" }),
  archive: (sessionId: string) => request(`/api/sessions/${sessionId}/archive`, parseArchived, { method: "POST" }),
  restore: (sessionId: string) => request(`/api/sessions/${sessionId}/restore`, parseRestored, { method: "POST" }),
};

export function sessionEvents(sessionId: string): WebSocket {
  return new WebSocket(`${webSocketBaseUrl()}/api/sessions/${sessionId}/events`);
}

export function globalSessionEvents(): WebSocket {
  return new WebSocket(`${webSocketBaseUrl()}/api/sessions/events`);
}

function messageUrl(sessionId: string, options?: { limit?: number; before?: number }): string {
  const params = new URLSearchParams();
  if (options?.limit !== undefined) params.set("limit", String(options.limit));
  if (options?.before !== undefined) params.set("before", String(options.before));
  const query = params.toString();
  return `/api/sessions/${sessionId}/messages${query ? `?${query}` : ""}`;
}

function webSocketBaseUrl(): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected object response");
  return value;
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`Expected string field: ${key}`);
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`Expected optional string field: ${key}`);
  return value;
}

function requireNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number") throw new Error(`Expected number field: ${key}`);
  return value;
}

function requireBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") throw new Error(`Expected boolean field: ${key}`);
  return value;
}

function arrayOf<T>(parse: (value: unknown) => T): (value: unknown) => T[] {
  return (value) => {
    if (!Array.isArray(value)) throw new Error("Expected array response");
    return value.map(parse);
  };
}

function parseUnknownArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Expected array response");
  return value;
}

function parseMessagePage(value: unknown): MessagePage {
  if (Array.isArray(value)) return { messages: value, start: 0, total: value.length };
  const record = requireRecord(value);
  return { messages: parseUnknownArray(record["messages"]), start: requireNumber(record, "start"), total: requireNumber(record, "total") };
}

function parseProject(value: unknown): Project {
  const record = requireRecord(value);
  return { id: requireString(record, "id"), name: requireString(record, "name"), path: requireString(record, "path"), createdAt: requireString(record, "createdAt") };
}

function parseWorkspace(value: unknown): Workspace {
  const record = requireRecord(value);
  const branch = optionalString(record, "branch");
  return {
    id: requireString(record, "id"),
    projectId: requireString(record, "projectId"),
    path: requireString(record, "path"),
    label: requireString(record, "label"),
    ...(branch === undefined ? {} : { branch }),
    isMain: requireBoolean(record, "isMain"),
    isGitWorktree: requireBoolean(record, "isGitWorktree"),
  };
}

function parseSessionInfo(value: unknown): SessionInfo {
  const record = requireRecord(value);
  const name = optionalString(record, "name");
  const archivedAt = optionalString(record, "archivedAt");
  return {
    id: requireString(record, "id"),
    path: requireString(record, "path"),
    cwd: requireString(record, "cwd"),
    ...(name === undefined ? {} : { name }),
    created: requireString(record, "created"),
    modified: requireString(record, "modified"),
    messageCount: requireNumber(record, "messageCount"),
    firstMessage: requireString(record, "firstMessage"),
    ...(record["archived"] === true ? { archived: true } : {}),
    ...(archivedAt === undefined ? {} : { archivedAt }),
  };
}

function parseSessionStatus(value: unknown): SessionStatus {
  const record = requireRecord(value);
  return {
    sessionId: requireString(record, "sessionId"),
    isStreaming: requireBoolean(record, "isStreaming"),
    isCompacting: requireBoolean(record, "isCompacting"),
    isBashRunning: requireBoolean(record, "isBashRunning"),
    pendingMessageCount: requireNumber(record, "pendingMessageCount"),
    tokens: parseTokens(record["tokens"]),
    cost: requireNumber(record, "cost"),
    ...optionalModel(record["model"]),
    ...optionalContextUsage(record["contextUsage"]),
    ...optionalField("thinkingLevel", optionalString(record, "thinkingLevel")),
  };
}

function parseTokens(value: unknown): SessionStatus["tokens"] {
  const record = requireRecord(value);
  return {
    input: requireNumber(record, "input"),
    output: requireNumber(record, "output"),
    cacheRead: requireNumber(record, "cacheRead"),
    cacheWrite: requireNumber(record, "cacheWrite"),
    total: requireNumber(record, "total"),
  };
}

function optionalModel(value: unknown): Pick<SessionStatus, "model"> | object {
  if (value === undefined) return {};
  const record = requireRecord(value);
  return { model: { ...optionalField("provider", optionalString(record, "provider")), ...optionalField("id", optionalString(record, "id")), ...optionalField("name", optionalString(record, "name")), ...optionalField("contextWindow", optionalNumber(record, "contextWindow")), ...optionalField("reasoning", record["reasoning"]) } };
}

function optionalContextUsage(value: unknown): Pick<SessionStatus, "contextUsage"> | object {
  if (value === undefined) return {};
  const record = requireRecord(value);
  return { contextUsage: { tokens: numberOrNull(record, "tokens"), contextWindow: requireNumber(record, "contextWindow"), percent: numberOrNull(record, "percent") } };
}

function parseSlashCommand(value: unknown): SlashCommand {
  const record = requireRecord(value);
  const source = requireString(record, "source");
  if (source !== "extension" && source !== "prompt" && source !== "skill" && source !== "builtin") throw new Error("Invalid command source");
  return { name: requireString(record, "name"), source, ...optionalField("description", optionalString(record, "description")) };
}

function parseFileSuggestion(value: unknown): FileSuggestion {
  const record = requireRecord(value);
  const kind = requireString(record, "kind");
  if (kind !== "tracked" && kind !== "untracked" && kind !== "other") throw new Error("Invalid file kind");
  return { path: requireString(record, "path"), kind };
}

function parseCommandResult(value: unknown): CommandResult {
  const record = requireRecord(value);
  const type = requireString(record, "type");
  if (type === "unsupported") return { type, message: requireString(record, "message") };
  if (type === "select") return { type, requestId: requireString(record, "requestId"), title: requireString(record, "title"), options: arrayOf(parseCommandOption)(record["options"]) };
  if (type === "done") return { type, ...optionalField("message", optionalString(record, "message")), ...optionalSession(record["session"]) };
  throw new Error("Invalid command result type");
}

function parseCommandOption(value: unknown): CommandOption {
  const record = requireRecord(value);
  return { value: requireString(record, "value"), label: requireString(record, "label"), ...optionalField("description", optionalString(record, "description")) };
}

function optionalSession(value: unknown): Pick<Extract<CommandResult, { type: "done" }>, "session"> | object {
  return value === undefined ? {} : { session: parseSessionInfo(value) };
}

function parseAccepted(value: unknown): { accepted: true } {
  const record = requireRecord(value);
  if (record["accepted"] !== true) throw new Error("Expected accepted response");
  return { accepted: true };
}

function parseAborted(value: unknown): { aborted: true } {
  const record = requireRecord(value);
  if (record["aborted"] !== true) throw new Error("Expected aborted response");
  return { aborted: true };
}

function parseStopped(value: unknown): { stopped: true } {
  const record = requireRecord(value);
  if (record["stopped"] !== true) throw new Error("Expected stopped response");
  return { stopped: true };
}

function parseArchived(value: unknown): { archived: true } {
  const record = requireRecord(value);
  if (record["archived"] !== true) throw new Error("Expected archived response");
  return { archived: true };
}

function parseRestored(value: unknown): { restored: true } {
  const record = requireRecord(value);
  if (record["restored"] !== true) throw new Error("Expected restored response");
  return { restored: true };
}

function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number") throw new Error(`Expected optional number field: ${key}`);
  return value;
}

function numberOrNull(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== "number") throw new Error(`Expected number|null field: ${key}`);
  return value;
}

function optionalField(key: string, value: unknown): object {
  return value === undefined ? {} : { [key]: value };
}
