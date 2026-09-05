import type {
  JsonObject,
  JsonValue,
  PairedPluginBackendV1,
  PairedPluginChannel,
  PairedPluginChannelOpenContext,
  PairedPluginRequestContext,
  PiWebServerPlugin,
  ServerPluginActivation,
  ServerPluginActivationContext,
} from "@jmfederico/pi-web/server-plugin-api";
import {
  TerminalService,
  type CreateTerminalOptions,
  type RunTerminalCommandOptions,
  type TerminalActivitySink,
  type TerminalCommandRun,
  type TerminalCommandRunFilter,
  type TerminalCommandRunStatus,
  type TerminalInfo,
  type TerminalWorkspaceScope,
} from "./terminalService.js";

const TERMINAL_CHANNEL_OUTPUT_FRAME_TARGET_BYTES = 60 * 1024;

interface RequiredTerminalServiceContribution {
  closeForCwd(cwd: string): void;
  runCommand(options: RunTerminalCommandOptions): TerminalCommandRun;
  bindActivitySink(sink: TerminalActivitySink): void;
}

interface TerminalActivation extends ServerPluginActivation {
  requiredTerminalService: RequiredTerminalServiceContribution;
}

const plugin: PiWebServerPlugin = {
  apiVersion: 1,
  name: "Terminal",
  activate(context) {
    return activateTerminalPlugin(context);
  },
};

export default plugin;

export function activateTerminalPlugin(context: ServerPluginActivationContext): TerminalActivation {
  if (context.pluginId !== "terminal") {
    throw new Error(`Terminal server entry must activate as plugin id terminal, received ${context.pluginId}`);
  }
  const notices = context.notices;
  if (notices?.version !== 1) {
    throw new Error("Terminal server entry requires server notice reporter version 1");
  }
  const service = new TerminalService((input) => { notices.record(input); });
  const requiredTerminalService: RequiredTerminalServiceContribution = Object.freeze({
    closeForCwd: (cwd: string) => { service.closeForCwd(cwd); },
    runCommand: (options: RunTerminalCommandOptions) => service.runCommand(options),
    bindActivitySink: (sink: TerminalActivitySink) => { service.bindActivitySink(sink); },
  });
  let stopped = false;
  return Object.freeze({
    pairedBackend: createTerminalBackend(service, context),
    requiredTerminalService,
    health: () => stopped
      ? Object.freeze({ status: "unhealthy" as const, message: "Terminal service is stopped" })
      : Object.freeze({ status: "healthy" as const }),
    stop: () => {
      if (stopped) return;
      stopped = true;
      service.dispose();
    },
  });
}

export function createTerminalBackend(
  service: TerminalService,
  activationContext?: Pick<ServerPluginActivationContext, "logger">,
): PairedPluginBackendV1 {
  return Object.freeze({
    version: 1,
    request: (context: PairedPluginRequestContext) => terminalRequest(service, context),
    openChannel: (context: PairedPluginChannelOpenContext) => openTerminalChannel(service, context, activationContext),
  });
}

function terminalRequest(service: TerminalService, context: PairedPluginRequestContext): JsonValue {
  throwIfAborted(context.signal);
  const scope = terminalScope(context);
  switch (context.operation) {
    case "terminal.list":
      requireNullishInput(context.input, context.operation);
      return service.list(scope).map(terminalInfoJson);
    case "terminal.create": {
      const input = requireObject(context.input, context.operation);
      return terminalInfoJson(service.create({
        ...scope,
        ...optionalTerminalName(input),
        ...optionalTerminalSize(input),
      }));
    }
    case "terminal.close": {
      service.close(scope, requireIdInput(context.input, context.operation, "terminalId"));
      return { closed: true };
    }
    case "terminal.continue":
      return terminalInfoJson(service.continue(scope, requireIdInput(context.input, context.operation, "terminalId")));
    case "terminal.run": {
      const input = requireObject(context.input, context.operation);
      return commandRunJson(service.runCommand(parseRunCommand(scope, input)));
    }
    case "terminal.list-runs": {
      const input = requireObjectOrEmpty(context.input, context.operation);
      return service.listCommandRunsForScope(scope, parseCommandRunFilter(input)).map(commandRunJson);
    }
    case "terminal.get-run": {
      const run = service.getCommandRunForScope(scope, requireIdInput(context.input, context.operation, "runId"));
      return run === undefined ? null : commandRunJson(run);
    }
    case "terminal.cancel-run":
      return commandRunJson(service.cancelCommandRunForScope(scope, requireIdInput(context.input, context.operation, "runId")));
    default:
      throw new Error(`Unsupported Terminal operation: ${context.operation}`);
  }
}

function openTerminalChannel(
  service: TerminalService,
  context: PairedPluginChannelOpenContext,
  activationContext?: Pick<ServerPluginActivationContext, "logger">,
): PairedPluginChannel {
  if (context.operation !== "terminal.attach") {
    throw new Error(`Unsupported Terminal channel operation: ${context.operation}`);
  }
  throwIfAborted(context.signal);
  const scope = terminalScope(context);
  const input = requireObject(context.input, context.operation);
  const terminalId = requireString(input, "terminalId", context.operation);
  const size = optionalTerminalSize(input);
  if (size.cols !== undefined && size.rows !== undefined) {
    service.resize(scope, terminalId, size.cols, size.rows);
  }

  let resolveCompleted: () => void = () => undefined;
  const completed = new Promise<void>((resolve) => { resolveCompleted = resolve; });
  let opening = true;
  let detach = (): void => undefined;
  const send = (frame: JsonValue): void => {
    try {
      context.send(frame);
    } catch (error) {
      if (opening) throw error;
      detach();
      activationContext?.logger.error("Terminal channel output failed", {
        terminalId,
        message: boundedErrorMessage(error),
      });
    }
  };
  detach = service.attach(scope, terminalId, {
    output(data, replay) {
      for (const frame of terminalOutputFrames(data, replay)) send(frame);
    },
    exit(exitCode) {
      send({ type: "exit", ...(exitCode === undefined ? {} : { exitCode }) });
    },
    closed() {
      resolveCompleted();
    },
  });
  opening = false;
  let cleanedUp = false;
  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    context.signal.removeEventListener("abort", cleanup);
    detach();
  };
  context.signal.addEventListener("abort", cleanup, { once: true });

  return Object.freeze({
    closed: completed,
    receive(data: JsonValue, signal: AbortSignal): void {
      throwIfAborted(signal);
      throwIfAborted(context.signal);
      const frame = requireObject(data, "terminal.attach frame");
      const type = requireString(frame, "type", "terminal.attach frame");
      if (type === "input") {
        service.write(scope, terminalId, requireTerminalInputData(frame));
        return;
      }
      if (type === "resize") {
        const parsed = requireTerminalSize(frame, "terminal.attach resize frame");
        service.resize(scope, terminalId, parsed.cols, parsed.rows);
        return;
      }
      throw new Error(`Unsupported Terminal channel frame: ${type}`);
    },
    close(): void {
      cleanup();
    },
  });
}

function terminalScope(context: Pick<PairedPluginRequestContext, "project" | "workspace">): TerminalWorkspaceScope {
  if (context.workspace.projectId !== context.project.id) {
    throw new Error("Terminal workspace project scope does not match the host project");
  }
  return Object.freeze({
    projectId: context.project.id,
    workspaceId: context.workspace.id,
    cwd: context.workspace.path,
  });
}

function parseRunCommand(scope: TerminalWorkspaceScope, input: JsonObject): RunTerminalCommandOptions {
  const metadata = input["metadata"];
  return {
    ...scope,
    origin: requireString(input, "origin", "terminal.run"),
    title: requireString(input, "title", "terminal.run"),
    command: requireString(input, "command", "terminal.run"),
    ...(metadata === undefined ? {} : { metadata }),
    ...optionalTerminalSize(input),
  };
}

function parseCommandRunFilter(input: JsonObject): TerminalCommandRunFilter {
  const terminalId = optionalString(input, "terminalId", "terminal.list-runs");
  const metadataValue = input["metadata"];
  const statusesValue = input["statuses"];
  const metadata = metadataValue === undefined ? undefined : stringRecord(metadataValue, "terminal.list-runs metadata");
  const statuses = statusesValue === undefined ? undefined : requireArray(statusesValue, "terminal.list-runs statuses").map((status) => parseCommandRunStatus(status));
  return {
    ...(terminalId === undefined ? {} : { terminalId }),
    ...(statuses === undefined ? {} : { statuses }),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function terminalInfoJson(info: TerminalInfo): JsonObject {
  return {
    id: info.id,
    cwd: info.cwd,
    name: info.name,
    createdAt: info.createdAt,
    exited: info.exited,
    ...(info.exitCode === undefined ? {} : { exitCode: info.exitCode }),
    ...(info.commandRunId === undefined ? {} : { commandRunId: info.commandRunId }),
  };
}

function commandRunJson(run: TerminalCommandRun): JsonObject {
  return {
    id: run.id,
    origin: run.origin,
    projectId: run.projectId,
    workspaceId: run.workspaceId,
    terminalId: run.terminalId,
    title: run.title,
    command: run.command,
    status: run.status,
    ...(run.exitCode === undefined ? {} : { exitCode: run.exitCode }),
    createdAt: run.createdAt,
    ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
    ...(run.completedAt === undefined ? {} : { completedAt: run.completedAt }),
    metadata: { ...run.metadata },
  };
}

function optionalTerminalName(input: JsonObject): Pick<CreateTerminalOptions, "name"> {
  const name = optionalString(input, "name", "terminal.create");
  return name === undefined ? {} : { name };
}

function optionalTerminalSize(input: JsonObject): Pick<CreateTerminalOptions, "cols" | "rows"> {
  const cols = input["cols"];
  const rows = input["rows"];
  if (cols === undefined && rows === undefined) return {};
  return requireTerminalSize(input, "Terminal size");
}

function requireTerminalSize(input: JsonObject, label: string): { cols: number; rows: number } {
  const cols = input["cols"];
  const rows = input["rows"];
  if (typeof cols !== "number" || !Number.isFinite(cols) || cols <= 0) throw new Error(`${label} cols must be a positive number`);
  if (typeof rows !== "number" || !Number.isFinite(rows) || rows <= 0) throw new Error(`${label} rows must be a positive number`);
  return { cols: Math.floor(cols), rows: Math.floor(rows) };
}

function requireIdInput(input: JsonValue, operation: string, key: string): string {
  return requireString(requireObject(input, operation), key, operation);
}

function requireObject(value: JsonValue, label: string): JsonObject {
  if (!isJsonObject(value)) throw new Error(`${label} input must be an object`);
  return value;
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireObjectOrEmpty(value: JsonValue, label: string): JsonObject {
  return value === null ? {} : requireObject(value, label);
}

function requireNullishInput(value: JsonValue, label: string): void {
  if (value !== null && (typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 0)) {
    throw new Error(`${label} input must be null or an empty object`);
  }
}

function requireString(record: JsonObject, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} ${key} must be a non-empty string`);
  return value;
}

function requireTerminalInputData(record: JsonObject): string {
  const value = record["data"];
  if (typeof value !== "string" || value === "") throw new Error("terminal.attach input frame data must be a non-empty string");
  return value;
}

function optionalString(record: JsonObject, key: string, label: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${label} ${key} must be a string`);
  return value;
}

function stringRecord(value: JsonValue, label: string): Record<string, string> {
  const record = requireObject(value, label);
  return Object.fromEntries(Object.entries(record).map(([key, child]) => {
    if (typeof child !== "string") throw new Error(`${label} ${key} must be a string`);
    return [key, child];
  }));
}

function requireArray(value: JsonValue, label: string): readonly JsonValue[] {
  if (!isJsonArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function parseCommandRunStatus(value: JsonValue): TerminalCommandRunStatus {
  if (value === "queued" || value === "running" || value === "succeeded" || value === "failed") return value;
  throw new Error(`Invalid Terminal command run status: ${JSON.stringify(value)}`);
}

interface TerminalOutputFrame extends JsonObject {
  readonly type: "output";
  readonly data: string;
  readonly replay: boolean;
  readonly replayComplete?: boolean;
}

export function terminalOutputFrames(value: string, replay: boolean): TerminalOutputFrame[] {
  const emptyFrame = terminalOutputFrame("", replay, false);
  const emptyFrameBytes = Buffer.byteLength(JSON.stringify(emptyFrame), "utf8");
  const chunks: string[] = [];
  let chunk = "";
  let encodedBytes = emptyFrameBytes;
  for (const character of value) {
    // JSON escaping can expand control characters well beyond their raw UTF-8
    // size, so budget the serialized representation rather than the PTY text.
    const characterBytes = Buffer.byteLength(JSON.stringify(character), "utf8") - 2;
    if (encodedBytes + characterBytes > TERMINAL_CHANNEL_OUTPUT_FRAME_TARGET_BYTES && chunk !== "") {
      chunks.push(chunk);
      chunk = "";
      encodedBytes = emptyFrameBytes;
    }
    chunk += character;
    encodedBytes += characterBytes;
  }
  if (chunk !== "" || value === "") chunks.push(chunk);
  return chunks.map((data, index) => terminalOutputFrame(data, replay, index === chunks.length - 1));
}

function terminalOutputFrame(data: string, replay: boolean, replayComplete: boolean): TerminalOutputFrame {
  return replay
    ? { type: "output", data, replay: true, replayComplete }
    : { type: "output", data, replay: false };
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const reason: unknown = signal.reason;
  throw reason instanceof Error ? reason : new Error("Terminal operation was cancelled", { cause: reason });
}

function boundedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 1_024 ? message : `${message.slice(0, 1_021)}...`;
}
