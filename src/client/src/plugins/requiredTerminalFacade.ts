import type { TerminalCommandRun, TerminalCommandRunStatus, Workspace } from "../api";
import type { ContributionQueryValue, QualifiedContributionId, WorkspaceBackend, WorkspacePanelTerminal, WorkspacePluginBinding, WorkspaceTerminalCommandInput } from "./types";

export interface WorkspaceContributionNavigationV1 {
  readonly contributionId: QualifiedContributionId;
  readonly navigationAliases?: readonly QualifiedContributionId[];
  readonly query: Readonly<Record<string, ContributionQueryValue | undefined | null>>;
}

export interface RequiredTerminalFacadeHostV1 {
  navigateWorkspaceContribution(workspace: Workspace, navigation: WorkspaceContributionNavigationV1): void | Promise<void>;
}

export interface RequiredTerminalWorkspaceBindingV1 {
  readonly origin: string;
  readonly registrationPluginId: string;
  readonly workspace: Workspace;
  readonly backend: WorkspaceBackend;
  readonly host: RequiredTerminalFacadeHostV1;
}

export interface RequiredTerminalCommandRunQueryV1 {
  readonly backend: WorkspaceBackend;
  readonly filter?: Readonly<{
    terminalId?: string;
    statuses?: readonly TerminalCommandRunStatus[];
    metadata?: Readonly<Record<string, string>>;
  }>;
  readonly signal?: AbortSignal;
}

export interface RequiredTerminalBrowserFacadeV1 {
  readonly version: 1;
  createWorkspaceTerminal(binding: RequiredTerminalWorkspaceBindingV1): WorkspacePanelTerminal;
  listCommandRuns(query: RequiredTerminalCommandRunQueryV1): Promise<TerminalCommandRun[]>;
  parseCommandRun(value: unknown): TerminalCommandRun;
}

export interface RequiredTerminalBrowserComposition {
  readonly binding: WorkspacePluginBinding;
  readonly facade: RequiredTerminalBrowserFacadeV1;
}

export class RequiredTerminalBrowserUnavailableError extends Error {
  override name = "RequiredTerminalBrowserUnavailableError";
}

export function snapshotRequiredTerminalBrowserFacade(value: unknown): RequiredTerminalBrowserFacadeV1 {
  if (!isRecord(value) || value["version"] !== 1) {
    throw new Error("Required Terminal browser entry did not provide facade v1");
  }
  const createWorkspaceTerminal = value["createWorkspaceTerminal"];
  const listCommandRuns = value["listCommandRuns"];
  const parseCommandRun = value["parseCommandRun"];
  if (typeof createWorkspaceTerminal !== "function" || typeof listCommandRuns !== "function" || typeof parseCommandRun !== "function") {
    throw new Error("Required Terminal browser entry did not provide facade v1");
  }
  const facade: RequiredTerminalBrowserFacadeV1 = {
    version: 1,
    createWorkspaceTerminal(binding) {
      const terminal: unknown = Reflect.apply(createWorkspaceTerminal, value, [binding]);
      if (!isRecord(terminal)) throw new Error("Required Terminal browser facade returned an invalid workspace terminal");
      const open = terminal["open"];
      const runCommand = terminal["runCommand"];
      if (typeof open !== "function" || typeof runCommand !== "function") {
        throw new Error("Required Terminal browser facade returned an invalid workspace terminal");
      }
      return Object.freeze({
        open: (options?: { terminalId?: string | undefined }) => { Reflect.apply(open, terminal, [options]); },
        runCommand: (input: WorkspaceTerminalCommandInput) => Promise.resolve(Reflect.apply(runCommand, terminal, [input])).then(requireTerminalCommandRunHandle),
      });
    },
    async listCommandRuns(query) {
      const result: unknown = await Reflect.apply(listCommandRuns, value, [query]);
      if (!Array.isArray(result)) throw new Error("Required Terminal browser facade returned an invalid command-run list");
      return result.map((run) => facade.parseCommandRun(run));
    },
    parseCommandRun(input) {
      return requireTerminalCommandRun(Reflect.apply(parseCommandRun, value, [input]));
    },
  };
  return Object.freeze(facade);
}

export function requiredTerminalUnavailableError(machineId: string): RequiredTerminalBrowserUnavailableError {
  return new RequiredTerminalBrowserUnavailableError(
    machineId === "local"
      ? "Required Terminal plugin is unavailable. Open Settings for recovery guidance."
      : `Required Terminal plugin is unavailable on machine ${machineId}. Open Settings for recovery guidance.`,
  );
}

function requireTerminalCommandRunHandle(value: unknown) {
  if (!isRecord(value) || !(value["completed"] instanceof Promise)) {
    throw new Error("Required Terminal browser facade returned an invalid command-run handle");
  }
  return Object.freeze({
    run: requireTerminalCommandRun(value["run"]),
    completed: value["completed"].then(requireTerminalCommandRun),
  });
}

function requireTerminalCommandRun(value: unknown): TerminalCommandRun {
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

function invalidCommandRun(): Error {
  return new Error("Required Terminal browser facade returned an invalid command run");
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((child) => typeof child === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
