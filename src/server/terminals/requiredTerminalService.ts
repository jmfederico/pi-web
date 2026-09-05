import type { TerminalCommandRun } from "../../shared/apiTypes.js";

export interface RequiredTerminalCommandFailureNotice {
  readonly message: string;
  readonly context: Readonly<Record<string, string>>;
}

export interface RunTerminalCommandOptions {
  projectId: string;
  workspaceId: string;
  cwd: string;
  origin: string;
  title: string;
  command: string;
  metadata?: unknown;
  /** Private host-composition intent; never part of the browser Terminal protocol. */
  failureNotice?: RequiredTerminalCommandFailureNotice;
  cols?: number;
  rows?: number;
}

export interface RequiredTerminalActivity {
  id: string;
  cwd: string;
  exited: boolean;
}

export interface RequiredTerminalActivitySink {
  updateTerminal(terminal: RequiredTerminalActivity): void;
  removeTerminal(terminalId: string, cwd?: string): void;
}

/** Narrow core composition port supplied only by the required Terminal entry. */
export interface RequiredTerminalService {
  closeForCwd(cwd: string): void;
  runCommand(options: RunTerminalCommandOptions): TerminalCommandRun;
  bindActivitySink(sink: RequiredTerminalActivitySink): void;
}

export class RequiredTerminalUnavailableError extends Error {
  override name = "RequiredTerminalUnavailableError";
}

export function snapshotRequiredTerminalService(value: unknown): RequiredTerminalService {
  if (!isRecord(value)) throw new Error("Required Terminal server entry did not provide its composition service");
  const closeForCwd = value["closeForCwd"];
  const runCommand = value["runCommand"];
  const bindActivitySink = value["bindActivitySink"];
  if (typeof closeForCwd !== "function" || typeof runCommand !== "function" || typeof bindActivitySink !== "function") {
    throw new Error("Required Terminal server entry did not provide its composition service");
  }
  return Object.freeze({
    closeForCwd: (cwd: string) => { Reflect.apply(closeForCwd, value, [cwd]); },
    runCommand: (options: RunTerminalCommandOptions) => requireCommandRun(Reflect.apply(runCommand, value, [options])),
    bindActivitySink: (sink: RequiredTerminalActivitySink) => {
      Reflect.apply(bindActivitySink, value, [Object.freeze({
        updateTerminal: (terminal: RequiredTerminalActivity) => { sink.updateTerminal(terminal); },
        removeTerminal: (terminalId: string, cwd?: string) => { sink.removeTerminal(terminalId, cwd); },
      })]);
    },
  });
}

export function unavailableRequiredTerminalService(): RequiredTerminalService {
  const unavailable = (): never => {
    throw new RequiredTerminalUnavailableError(
      "Required Terminal plugin is unavailable in recovery safe start; workspace removal cannot continue",
    );
  };
  return Object.freeze({
    closeForCwd: unavailable,
    runCommand: unavailable,
    bindActivitySink: () => undefined,
  });
}

function requireCommandRun(value: unknown): TerminalCommandRun {
  if (!isRecord(value)) throw invalidCommandRun();
  const status = value["status"];
  const exitCode = optionalFiniteNumber(value["exitCode"]);
  const startedAt = optionalString(value["startedAt"]);
  const completedAt = optionalString(value["completedAt"]);
  if (typeof value["id"] !== "string"
    || typeof value["origin"] !== "string"
    || typeof value["projectId"] !== "string"
    || typeof value["workspaceId"] !== "string"
    || typeof value["terminalId"] !== "string"
    || typeof value["title"] !== "string"
    || typeof value["command"] !== "string"
    || (status !== "queued" && status !== "running" && status !== "succeeded" && status !== "failed")
    || exitCode === invalidOptionalField
    || typeof value["createdAt"] !== "string"
    || startedAt === invalidOptionalField
    || completedAt === invalidOptionalField
    || !isStringRecord(value["metadata"])) {
    throw invalidCommandRun();
  }
  return {
    id: value["id"],
    origin: value["origin"],
    projectId: value["projectId"],
    workspaceId: value["workspaceId"],
    terminalId: value["terminalId"],
    title: value["title"],
    command: value["command"],
    status,
    ...(exitCode === undefined ? {} : { exitCode }),
    createdAt: value["createdAt"],
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(completedAt === undefined ? {} : { completedAt }),
    metadata: { ...value["metadata"] },
  };
}

const invalidOptionalField = Symbol("invalid optional Terminal field");

function optionalFiniteNumber(value: unknown): number | undefined | typeof invalidOptionalField {
  if (value === undefined) return undefined;
  return typeof value === "number" && Number.isFinite(value) ? value : invalidOptionalField;
}

function optionalString(value: unknown): string | undefined | typeof invalidOptionalField {
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : invalidOptionalField;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((child) => typeof child === "string");
}

function invalidCommandRun(): Error {
  return new Error("Required Terminal server entry returned an invalid command run");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
