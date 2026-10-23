import type { AnyTerminalCommandRun, MaintenanceTerminalCommandRun, TerminalCommandRun, TerminalCommandRunStatus, Workspace } from "../api";
import type { MaintenanceTerminal, ContributionQueryValue, PluginCapability, PluginPeer, QualifiedContributionId, WorkspacePanelTerminal, WorkspacePluginBinding, WorkspaceTerminalCommandInput } from "./types";

export interface WorkspaceContributionNavigationV1 {
  readonly contributionId: QualifiedContributionId;
  readonly query: Readonly<Record<string, ContributionQueryValue | undefined | null>>;
}

export interface RequiredTerminalFacadeHostV1 {
  navigateWorkspaceContribution(workspace: Workspace, navigation: WorkspaceContributionNavigationV1): void | Promise<void>;
}

export interface RequiredTerminalWorkspaceBindingV1 {
  readonly origin: string;
  readonly registrationPluginId: string;
  readonly workspace: Workspace;
  readonly peer: PluginPeer;
  readonly host: RequiredTerminalFacadeHostV1;
}

export interface RequiredTerminalMaintenanceBindingV1 {
  readonly origin: string;
  readonly machineId: string;
  readonly registrationPluginId: string;
  readonly peer: PluginPeer;
  readonly host: { navigateApplicationContribution(contributionId: QualifiedContributionId): boolean };
}

export interface RequiredTerminalCommandRunQueryV1 {
  readonly peer: PluginPeer;
  readonly filter?: Readonly<{
    terminalId?: string;
    statuses?: readonly TerminalCommandRunStatus[];
    metadata?: Readonly<Record<string, string>>;
  }>;
  readonly signal?: AbortSignal;
}

/** Privileged host-only composition port supplied by the required bundled Terminal; not third-party API. */
export interface RequiredTerminalBrowserFacadeV1 {
  readonly version: 1;
  createWorkspaceTerminal(binding: RequiredTerminalWorkspaceBindingV1): WorkspacePanelTerminal;
  createMaintenanceTerminal?(binding: RequiredTerminalMaintenanceBindingV1): MaintenanceTerminal;
  listCommandRuns(query: RequiredTerminalCommandRunQueryV1): Promise<TerminalCommandRun[]>;
  parseCommandRun(value: unknown): TerminalCommandRun;
}

export interface RequiredTerminalBrowserComposition {
  readonly binding: WorkspacePluginBinding;
  readonly facade: RequiredTerminalBrowserFacadeV1;
}

/** Host-owned structural token matching Terminal's package-owned capability. */
export const REQUIRED_TERMINAL_BROWSER_FACADE_CAPABILITY = Object.freeze({
  pluginId: "pi-web.terminal",
  id: "browser-facade",
  version: 1,
  parse: snapshotRequiredTerminalBrowserFacade,
}) satisfies PluginCapability<RequiredTerminalBrowserFacadeV1, 1>;

export class RequiredTerminalBrowserUnavailableError extends Error {
  override name = "RequiredTerminalBrowserUnavailableError";
}

export function snapshotRequiredTerminalBrowserFacade(value: unknown): RequiredTerminalBrowserFacadeV1 {
  if (!isRecord(value) || value["version"] !== 1) {
    throw new Error("Required Terminal browser entry did not provide facade v1");
  }
  const createWorkspaceTerminal = value["createWorkspaceTerminal"];
  const createMaintenanceTerminal = value["createMaintenanceTerminal"];
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
        runCommand: (input: WorkspaceTerminalCommandInput) => Promise.resolve(Reflect.apply(runCommand, terminal, [input])).then((handle) => requireTerminalCommandRunHandle(handle, requireTerminalCommandRun)),
      });
    },
    ...(typeof createMaintenanceTerminal !== "function" ? {} : {
      createMaintenanceTerminal(binding: RequiredTerminalMaintenanceBindingV1): MaintenanceTerminal {
        const terminal: unknown = Reflect.apply(createMaintenanceTerminal, value, [binding]);
        if (!isRecord(terminal)) throw new Error("Required Terminal browser facade returned an invalid maintenance terminal");
        const open = terminal["open"];
        const runCommand = terminal["runCommand"];
        if (typeof open !== "function" || typeof runCommand !== "function") throw new Error("Required Terminal browser facade returned an invalid maintenance terminal");
        return Object.freeze({
          open: (options?: { terminalId?: string | undefined }) => { Reflect.apply(open, terminal, [options]); },
          runCommand: (input: WorkspaceTerminalCommandInput) => Promise.resolve(Reflect.apply(runCommand, terminal, [input])).then((handle) => requireTerminalCommandRunHandle(handle, requireMaintenanceCommandRun)),
        });
      },
    }),
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

function requireTerminalCommandRunHandle<Run extends AnyTerminalCommandRun>(value: unknown, mapRun: (value: unknown) => Run) {
  if (!isRecord(value) || !(value["completed"] instanceof Promise)) {
    throw new Error("Required Terminal browser facade returned an invalid command-run handle");
  }
  return Object.freeze({
    run: mapRun(value["run"]),
    completed: value["completed"].then(mapRun),
  });
}

function requireTerminalCommandRun(value: unknown): TerminalCommandRun {
  const run = requireAnyCommandRun(value);
  if (run.scope === "maintenance") throw invalidCommandRun();
  return run;
}

function requireMaintenanceCommandRun(value: unknown): MaintenanceTerminalCommandRun {
  const run = requireAnyCommandRun(value);
  if (run.scope !== "maintenance") throw invalidCommandRun();
  return run;
}

function requireAnyCommandRun(value: unknown): AnyTerminalCommandRun {
  if (!isRecord(value)) throw invalidCommandRun();
  const status = value["status"];
  const exitCode = optionalFiniteNumber(value["exitCode"]);
  const startedAt = optionalString(value["startedAt"]);
  const completedAt = optionalString(value["completedAt"]);
  if (typeof value["id"] !== "string"
    || typeof value["origin"] !== "string"
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
  const scope = value["scope"] === "maintenance"
    ? maintenanceRunScope(value)
    : workspaceRunScope(value);
  return {
    ...scope,
    id: value["id"],
    origin: value["origin"],
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

function maintenanceRunScope(value: Record<string, unknown>): { scope: "maintenance" } {
  if (value["projectId"] !== undefined || value["workspaceId"] !== undefined) throw invalidCommandRun();
  return { scope: "maintenance" };
}

function workspaceRunScope(value: Record<string, unknown>): { projectId: string; workspaceId: string } {
  if ((value["scope"] !== undefined && value["scope"] !== "workspace")
    || typeof value["projectId"] !== "string" || typeof value["workspaceId"] !== "string") throw invalidCommandRun();
  return { projectId: value["projectId"], workspaceId: value["workspaceId"] };
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
