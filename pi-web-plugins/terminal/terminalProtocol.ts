import type {
  JsonObject,
  JsonValue,
  TerminalCommandRun,
  TerminalCommandRunStatus,
  WorkspaceBackend,
  WorkspaceBackendChannel,
  WorkspaceBackendChannelClose,
  WorkspaceTerminalCommandInput,
} from "@jmfederico/pi-web/plugin-api";

export interface TerminalInfo {
  id: string;
  cwd: string;
  name: string;
  createdAt: string;
  exited: boolean;
  exitCode?: number;
  commandRunId?: string;
}

export interface TerminalSize {
  cols: number;
  rows: number;
}

export interface TerminalCommandRunFilter {
  terminalId?: string;
  statuses?: TerminalCommandRunStatus[];
  metadata?: Record<string, string>;
}

export interface TerminalInputFrame extends JsonObject {
  type: "input";
  data: string;
}

export interface TerminalResizeFrame extends JsonObject {
  type: "resize";
  cols: number;
  rows: number;
}

export type TerminalClientFrame = TerminalInputFrame | TerminalResizeFrame;

export type TerminalServerFrame =
  | { type: "output"; data: string; replay: false }
  | { type: "output"; data: string; replay: true; replayComplete: boolean }
  | { type: "exit"; exitCode?: number }
  | { type: "error"; message: string };

/** The paired channel contract allows at most 64 KiB of plugin JSON per frame. */
export const TERMINAL_CHANNEL_DATA_JSON_MAX_BYTES = 64 * 1024;
const EMPTY_TERMINAL_INPUT_FRAME_BYTES = utf8Bytes(JSON.stringify({ type: "input", data: "" }));

/** Split Xterm input without breaking Unicode code points or JSON byte bounds. */
export function terminalInputFrames(data: string): TerminalInputFrame[] {
  if (data === "") return [];
  const frames: TerminalInputFrame[] = [];
  let characters: string[] = [];
  let frameBytes = EMPTY_TERMINAL_INPUT_FRAME_BYTES;
  for (const character of data) {
    const serializedCharacter = JSON.stringify(character);
    const characterBytes = utf8Bytes(serializedCharacter) - 2; // surrounding JSON quotes are already in the empty-frame overhead
    if (characters.length !== 0 && frameBytes + characterBytes > TERMINAL_CHANNEL_DATA_JSON_MAX_BYTES) {
      frames.push({ type: "input", data: characters.join("") });
      characters = [];
      frameBytes = EMPTY_TERMINAL_INPUT_FRAME_BYTES;
    }
    if (frameBytes + characterBytes > TERMINAL_CHANNEL_DATA_JSON_MAX_BYTES) {
      throw new Error("Terminal input character exceeds the paired channel frame limit");
    }
    characters.push(character);
    frameBytes += characterBytes;
  }
  if (characters.length !== 0) frames.push({ type: "input", data: characters.join("") });
  return frames;
}

export interface TerminalAttachOptions {
  terminalId: string;
  size?: TerminalSize;
  signal?: AbortSignal;
  onFrame(frame: TerminalServerFrame): void;
}

/** Typed client for the Terminal package's private paired-backend protocol. */
export class TerminalBackendClient {
  constructor(private readonly backend: WorkspaceBackend) {
    requireRequestBackend(backend);
  }

  async list(signal?: AbortSignal): Promise<TerminalInfo[]> {
    return parseTerminalInfoArray(await this.backend.request("terminal.list", null, signal === undefined ? undefined : { signal }));
  }

  async create(size?: TerminalSize, signal?: AbortSignal): Promise<TerminalInfo> {
    const input: JsonValue = size === undefined ? {} : { cols: size.cols, rows: size.rows };
    return parseTerminalInfo(await this.backend.request("terminal.create", input, signal === undefined ? undefined : { signal }));
  }

  async close(terminalId: string, signal?: AbortSignal): Promise<void> {
    parseClosed(await this.backend.request("terminal.close", { terminalId }, signal === undefined ? undefined : { signal }));
  }

  async continue(terminalId: string, signal?: AbortSignal): Promise<TerminalInfo> {
    return parseTerminalInfo(await this.backend.request("terminal.continue", { terminalId }, signal === undefined ? undefined : { signal }));
  }

  async runCommand(origin: string, input: WorkspaceTerminalCommandInput, signal?: AbortSignal): Promise<TerminalCommandRun> {
    return parseTerminalCommandRun(await this.backend.request("terminal.run", {
      origin,
      title: input.title,
      command: input.command,
      metadata: input.metadata ?? {},
    }, signal === undefined ? undefined : { signal }));
  }

  async listCommandRuns(filter: TerminalCommandRunFilter = {}, signal?: AbortSignal): Promise<TerminalCommandRun[]> {
    return parseTerminalCommandRunArray(await this.backend.request("terminal.list-runs", terminalCommandRunFilterInput(filter), signal === undefined ? undefined : { signal }));
  }

  async getCommandRun(runId: string, signal?: AbortSignal): Promise<TerminalCommandRun | undefined> {
    const value = await this.backend.request("terminal.get-run", { runId }, signal === undefined ? undefined : { signal });
    return value === null ? undefined : parseTerminalCommandRun(value);
  }

  async cancelCommandRun(runId: string, signal?: AbortSignal): Promise<TerminalCommandRun> {
    return parseTerminalCommandRun(await this.backend.request("terminal.cancel-run", { runId }, signal === undefined ? undefined : { signal }));
  }

  async attach(options: TerminalAttachOptions): Promise<WorkspaceBackendChannel> {
    const openChannel = requireChannelBackend(this.backend);
    return openChannel("terminal.attach", {
      terminalId: options.terminalId,
      ...(options.size ?? {}),
    }, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      onData: (data) => { options.onFrame(parseTerminalServerFrame(data)); },
    });
  }
}

function requireRequestBackend(backend: WorkspaceBackend): void {
  if (backend.capabilityVersion !== 1) {
    throw new Error("Required Terminal paired backend capability v1 is unavailable");
  }
}

function requireChannelBackend(backend: WorkspaceBackend): NonNullable<WorkspaceBackend["openChannel"]> {
  if (backend.channelVersion !== 1 || backend.openChannel === undefined) {
    throw new Error("Required Terminal paired channel v1 is unavailable");
  }
  return backend.openChannel.bind(backend);
}

function terminalCommandRunFilterInput(filter: TerminalCommandRunFilter): JsonValue {
  return {
    ...(filter.terminalId === undefined ? {} : { terminalId: filter.terminalId }),
    ...(filter.statuses === undefined ? {} : { statuses: filter.statuses }),
    ...(filter.metadata === undefined ? {} : { metadata: filter.metadata }),
  };
}

export function parseTerminalInfo(value: unknown): TerminalInfo {
  const record = requireRecord(value, "Terminal info");
  return {
    id: requireString(record, "id", "Terminal info"),
    cwd: requireString(record, "cwd", "Terminal info"),
    name: requireString(record, "name", "Terminal info"),
    createdAt: requireString(record, "createdAt", "Terminal info"),
    exited: requireBoolean(record, "exited", "Terminal info"),
    ...optionalNumberField(record, "exitCode", "Terminal info"),
    ...optionalStringField(record, "commandRunId", "Terminal info"),
  };
}

export function parseTerminalCommandRun(value: unknown): TerminalCommandRun {
  const record = requireRecord(value, "Terminal command run");
  return {
    id: requireString(record, "id", "Terminal command run"),
    origin: requireString(record, "origin", "Terminal command run"),
    projectId: requireString(record, "projectId", "Terminal command run"),
    workspaceId: requireString(record, "workspaceId", "Terminal command run"),
    terminalId: requireString(record, "terminalId", "Terminal command run"),
    title: requireString(record, "title", "Terminal command run"),
    command: requireString(record, "command", "Terminal command run"),
    status: parseTerminalCommandRunStatus(record["status"]),
    ...optionalNumberField(record, "exitCode", "Terminal command run"),
    createdAt: requireString(record, "createdAt", "Terminal command run"),
    ...optionalStringField(record, "startedAt", "Terminal command run"),
    ...optionalStringField(record, "completedAt", "Terminal command run"),
    metadata: parseStringRecord(record["metadata"], "Terminal command run metadata"),
  };
}

export function parseTerminalServerFrame(value: unknown): TerminalServerFrame {
  const record = requireRecord(value, "Terminal channel frame");
  const type = record["type"];
  if (type === "output") {
    const data = requireStringValue(record, "data", "Terminal output frame");
    const replay = record["replay"];
    if (replay === false) {
      if (record["replayComplete"] !== undefined) throw new Error("Terminal live output frame must not declare replay completion");
      return { type, data, replay };
    }
    if (replay === true) {
      const replayComplete = record["replayComplete"];
      if (typeof replayComplete !== "boolean") throw new Error("Terminal replay output frame replayComplete must be a boolean");
      return { type, data, replay, replayComplete };
    }
    throw new Error("Terminal output frame replay must be a boolean");
  }
  if (type === "exit") return { type, ...optionalNumberField(record, "exitCode", "Terminal exit frame") };
  if (type === "error") return { type, message: requireStringValue(record, "message", "Terminal error frame") };
  throw new Error("Invalid Terminal channel frame");
}

export function terminalChannelFailureMessage(close: WorkspaceBackendChannelClose): string | undefined {
  if (close.error !== undefined) return `${close.error.code}: ${close.error.message}`;
  if (close.code === 1000 && close.wasClean) return undefined;
  return close.reason === "" ? `Terminal channel closed with code ${String(close.code)}` : close.reason;
}

function parseTerminalInfoArray(value: unknown): TerminalInfo[] {
  if (!Array.isArray(value)) throw new Error("Terminal list response must be an array");
  return value.map(parseTerminalInfo);
}

function parseTerminalCommandRunArray(value: unknown): TerminalCommandRun[] {
  if (!Array.isArray(value)) throw new Error("Terminal command run list response must be an array");
  return value.map(parseTerminalCommandRun);
}

function parseClosed(value: unknown): void {
  const record = requireRecord(value, "Terminal close response");
  if (record["closed"] !== true) throw new Error("Terminal close response is invalid");
}

function parseTerminalCommandRunStatus(value: unknown): TerminalCommandRunStatus {
  if (value === "queued" || value === "running" || value === "succeeded" || value === "failed") return value;
  throw new Error("Invalid Terminal command run status");
}

function parseStringRecord(value: unknown, label: string): Record<string, string> {
  const record = requireRecord(value, label);
  return Object.fromEntries(Object.entries(record).map(([key, child]) => {
    if (typeof child !== "string") throw new Error(`${label} ${key} must be a string`);
    return [key, child];
  }));
}

function optionalStringField(record: Record<string, unknown>, key: string, label: string): Record<string, string> {
  const value = record[key];
  if (value === undefined) return {};
  if (typeof value !== "string") throw new Error(`${label} ${key} must be a string`);
  return { [key]: value };
}

function optionalNumberField(record: Record<string, unknown>, key: string, label: string): Record<string, number> {
  const value = record[key];
  if (value === undefined) return {};
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} ${key} must be a finite number`);
  return { [key]: value };
}

function requireString(record: Record<string, unknown>, key: string, label: string): string {
  const value = requireStringValue(record, key, label);
  if (value === "") throw new Error(`${label} ${key} must not be empty`);
  return value;
}

function requireStringValue(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`${label} ${key} must be a string`);
  return value;
}

function requireBoolean(record: Record<string, unknown>, key: string, label: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") throw new Error(`${label} ${key} must be a boolean`);
  return value;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
