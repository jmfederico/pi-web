import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { workspaceIdFor } from "./workspaceIdentity.js";
import type {
  ProjectInput,
  ProviderClaim,
  ProviderWorkspace,
  WorkspaceRemovalPresentation as ProviderWorkspaceRemovalPresentation,
  WorkspaceRemovePlan,
} from "../../server-plugin-api.js";
import type {
  JsonObject,
  JsonValue,
  Project,
  WorkspaceListing,
  WorkspaceProviderAuthorityResolution,
  WorkspaceProviderDiagnostic,
  WorkspaceProviderTier,
  WorkspaceRemovalHostState,
} from "../../shared/apiTypes.js";
import { isPiWebPluginId } from "../../shared/pluginIds.js";
import {
  cloneBoundedPluginBackendJson,
  PLUGIN_BACKEND_DISPATCH_TIMEOUT_MS,
  PLUGIN_BACKEND_REQUEST_TIMEOUT_MS,
  PLUGIN_BACKEND_RESPONSE_JSON_MAX_BYTES,
  requirePluginBackendOperation,
  requirePluginBackendRevision,
} from "../../shared/pluginBackendProtocol.js";
import type {
  ServerPluginHealthInspection,
  ServerPluginProviderContribution,
} from "../plugins/serverPluginRuntime.js";

export type {
  WorkspaceProviderAuthorityResolution,
  WorkspaceProviderDiagnostic,
  WorkspaceProviderDiagnosticCode,
} from "../../shared/apiTypes.js";

const DEFAULT_PROVIDER_TIMEOUT_MS = PLUGIN_BACKEND_REQUEST_TIMEOUT_MS;

type ProviderTier = WorkspaceProviderTier;
type ProviderOperation = "probe" | "list" | "request" | "prepareRemove";

export interface WorkspaceProviderRegistryLogger {
  warn(details: Record<string, unknown>, message: string): void;
}

export type WorkspacePathInspector = (path: string) => boolean | Promise<boolean>;

export interface WorkspaceProviderRegistryOptions {
  /** Active contributions from one immutable server-plugin runtime snapshot. */
  contributions: readonly ServerPluginProviderContribution[];
  logger: WorkspaceProviderRegistryLogger;
  providerTimeoutMs?: number;
  /** End-to-end deadline for owner re-resolution plus one backend request. */
  requestTimeoutMs?: number;
  pathInspector?: WorkspacePathInspector;
}

export interface WorkspaceProviderRequest {
  pluginId: string;
  moduleRevision: string;
  project: Project;
  workspaceId: string;
  operation: string;
  input: unknown;
}

/** Current owner snapshot used by the host-owned workspace removal orchestrator. */
export interface WorkspaceProviderRemovalTarget {
  ownerPluginId: string;
  target: WorkspaceListing;
  workspaces: readonly WorkspaceListing[];
  /** Invoke the current owner's bounded native validation and command planner. */
  prepare(): Promise<WorkspaceRemovePlan>;
}

export type WorkspaceProviderRemovalErrorCode =
  | "owner-conflict"
  | "owner-unavailable"
  | "workspace-not-found"
  | "removal-unavailable"
  | "resolution-failed"
  | "resolution-timeout"
  | "preparation-failed"
  | "preparation-timeout"
  | "invalid-plan";

export class WorkspaceProviderRemovalError extends Error {
  override name = "WorkspaceProviderRemovalError";

  constructor(
    readonly code: WorkspaceProviderRemovalErrorCode,
    readonly statusCode: number,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
  }
}

export type WorkspaceProviderRequestErrorCode =
  | "inactive-plugin"
  | "stale-plugin-revision"
  | "invalid-operation"
  | "invalid-input"
  | "owner-conflict"
  | "owner-mismatch"
  | "workspace-not-found"
  | "resolution-failed"
  | "resolution-timeout"
  | "operation-unavailable"
  | "request-failed"
  | "request-timeout"
  | "invalid-result";

export class WorkspaceProviderRequestError extends Error {
  override name = "WorkspaceProviderRequestError";

  constructor(
    readonly code: WorkspaceProviderRequestErrorCode,
    readonly statusCode: number,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
  }
}

interface ParsedProviderWorkspace {
  key: string;
  path: string;
  label: string;
  isMain: boolean;
  data?: unknown;
  publicMetadata?: unknown;
  removal?: unknown;
}

interface TierSelectionNone {
  kind: "none";
}

interface TierSelectionWinner {
  kind: "winner";
  contribution: ServerPluginProviderContribution;
}

interface TierSelectionConflict {
  kind: "conflict";
  pluginIds: readonly string[];
}

interface ValidatedProviderWorkspace {
  workspace: WorkspaceListing;
  providerWorkspace: Readonly<ProviderWorkspace>;
}

type TierSelection = TierSelectionNone | TierSelectionWinner | TierSelectionConflict;

/** Keep only active providers whose bounded startup health inspection is not unhealthy. */
export function eligibleWorkspaceProviderContributions(
  contributions: readonly ServerPluginProviderContribution[],
  inspections: readonly ServerPluginHealthInspection[],
): readonly ServerPluginProviderContribution[] {
  const healthByPluginId = new Map(inspections.map(({ pluginId, health }) => [pluginId, health.status]));
  return Object.freeze(contributions.filter(({ pluginId }) => {
    const status = healthByPluginId.get(pluginId);
    return status === "healthy" || status === "degraded";
  }));
}

/**
 * Resolves one exclusive workspace owner from the active server-plugin snapshot.
 * Probe failures are local to one resolution; a claimant that later fails to
 * list never falls through to a lower-priority provider.
 */
export class WorkspaceProviderRegistry {
  private readonly contributions: readonly ServerPluginProviderContribution[];
  private readonly providerTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly pathInspector: WorkspacePathInspector;
  private readonly pendingResolutions = new Map<string, Promise<WorkspaceProviderAuthorityResolution>>();

  constructor(private readonly options: WorkspaceProviderRegistryOptions) {
    this.contributions = Object.freeze([...options.contributions]
      .sort((left, right) => left.pluginId.localeCompare(right.pluginId)));
    this.providerTimeoutMs = positiveInteger(options.providerTimeoutMs, DEFAULT_PROVIDER_TIMEOUT_MS, "providerTimeoutMs");
    this.requestTimeoutMs = positiveInteger(options.requestTimeoutMs, PLUGIN_BACKEND_DISPATCH_TIMEOUT_MS, "requestTimeoutMs");
    this.pathInspector = options.pathInspector ?? pathIsDirectory;
  }

  /** Workspace-lister adapter used by spawned-session target validation. */
  async list(project: Project): Promise<WorkspaceListing[]> {
    const resolution = await this.resolve(project);
    return [...resolution.workspaces];
  }

  /**
   * Resolve workspaces together with attributable diagnostics for host consumers.
   * Only identical work already in flight is shared; the entry is removed before
   * callers observe completion so ownership and topology are never cached.
   */
  async resolve(project: Project): Promise<WorkspaceProviderAuthorityResolution> {
    const input = snapshotProject(project);
    const key = workspaceResolutionKey(input);
    const existing = this.pendingResolutions.get(key);
    if (existing !== undefined) return existing;

    const pending = this.resolveSnapshot(input);
    this.pendingResolutions.set(key, pending);
    try {
      return await pending;
    } finally {
      if (this.pendingResolutions.get(key) === pending) this.pendingResolutions.delete(key);
    }
  }

  private async resolveSnapshot(input: ProjectInput): Promise<WorkspaceProviderAuthorityResolution> {
    const diagnostics: WorkspaceProviderDiagnostic[] = [];

    for (const tier of ["primary", "fallback"] as const) {
      const selection = await this.selectInTier(input, tier, diagnostics);
      if (selection.kind === "none") continue;
      if (selection.kind === "conflict") {
        const message = `Workspace provider conflict in ${tier} tier: ${selection.pluginIds.join(", ")}`;
        const diagnostic = freezeDiagnostic({
          code: "claim-conflict",
          message,
          tier,
          pluginIds: selection.pluginIds,
        });
        diagnostics.push(diagnostic);
        this.options.logger.warn({ projectId: input.id, tier, pluginIds: selection.pluginIds }, "workspace provider claim conflict");
        return degradedResolution(input, diagnostics);
      }
      return await this.resolveWinner(input, tier, selection.contribution, diagnostics);
    }

    return Object.freeze({
      status: "folder",
      projectId: input.id,
      workspaces: Object.freeze([folderWorkspace(input)]),
      diagnostics: Object.freeze([...diagnostics]),
    });
  }

  /**
   * Re-resolve the current owner and its private workspace snapshot before
   * invoking one bounded provider operation. Callers never supply owner data.
   */
  async request(request: WorkspaceProviderRequest): Promise<JsonValue> {
    try {
      return await runBoundedProviderOperation(
        request.pluginId,
        "request",
        this.requestTimeoutMs,
        (signal) => this.dispatchRequest(request, signal),
      );
    } catch (error) {
      if (error instanceof WorkspaceProviderTimeoutError) {
        throw providerRequestError("request-timeout", 504, boundedErrorMessage(error), error);
      }
      throw error;
    }
  }

  /** Re-resolve one live owner/target before host safety checks and provider planning. */
  async resolveRemoval(
    project: Project,
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceProviderRemovalTarget> {
    const input = snapshotProject(project);
    if (workspaceId === "") throw providerRemovalError("workspace-not-found", 404, "Workspace not found");
    const diagnostics: WorkspaceProviderDiagnostic[] = [];

    for (const tier of ["primary", "fallback"] as const) {
      const selection = await this.selectInTier(input, tier, diagnostics, signal);
      if (selection.kind === "none") continue;
      if (selection.kind === "conflict") {
        throw providerRemovalError(
          "owner-conflict",
          409,
          `Workspace owner conflict prevents removal: ${selection.pluginIds.join(", ")}`,
        );
      }

      const contribution = selection.contribution;
      let validated: ValidatedProviderWorkspace[];
      try {
        const listed: unknown = await runBoundedProviderOperation(
          contribution.pluginId,
          "list",
          this.providerTimeoutMs,
          (operationSignal) => contribution.provider.list(input, operationSignal),
          signal,
        );
        validated = await validateProviderWorkspaces(input, contribution, listed, this.pathInspector, signal);
      } catch (error) {
        if (signal?.aborted === true) throw abortError(signal);
        if (error instanceof WorkspaceProviderTimeoutError) {
          throw providerRemovalError("resolution-timeout", 504, boundedErrorMessage(error), error);
        }
        throw providerRemovalError(
          "resolution-failed",
          502,
          `Server plugin ${contribution.pluginId} could not resolve workspaces for removal: ${boundedErrorMessage(error)}`,
          error,
        );
      }

      const current = validated.find(({ workspace }) => workspace.id === workspaceId);
      if (current === undefined) {
        throw providerRemovalError(
          "workspace-not-found",
          404,
          `Workspace ${workspaceId} is stale or unavailable for removal`,
        );
      }
      const callback = contribution.provider.prepareRemove?.bind(contribution.provider);
      if (callback === undefined || current.workspace.removal === undefined) {
        throw providerRemovalError(
          "removal-unavailable",
          409,
          `Server plugin ${contribution.pluginId} does not advertise removal for workspace ${workspaceId}`,
        );
      }

      const workspaces = Object.freeze(validated.map(({ workspace }) => workspace));
      return Object.freeze({
        ownerPluginId: contribution.pluginId,
        target: current.workspace,
        workspaces,
        prepare: async () => {
          let value: unknown;
          try {
            value = await runBoundedProviderOperation(
              contribution.pluginId,
              "prepareRemove",
              this.providerTimeoutMs,
              (operationSignal) => callback(Object.freeze({
                project: input,
                workspace: current.providerWorkspace,
                signal: operationSignal,
              })),
              signal,
            );
          } catch (error) {
            if (signal?.aborted === true) throw abortError(signal);
            if (error instanceof WorkspaceProviderTimeoutError) {
              throw providerRemovalError("preparation-timeout", 504, boundedErrorMessage(error), error);
            }
            throw providerRemovalError(
              "preparation-failed",
              409,
              `Server plugin ${contribution.pluginId} rejected workspace removal: ${boundedErrorMessage(error)}`,
              error,
            );
          }
          return parseWorkspaceRemovePlan(value, contribution.pluginId);
        },
      });
    }

    const failedProbe = diagnostics.find(({ code }) => code === "probe-failed");
    if (failedProbe !== undefined) {
      throw providerRemovalError(
        "resolution-failed",
        502,
        `Workspace owner resolution failed before removal: ${boundedErrorMessage(failedProbe.message)}`,
      );
    }
    throw providerRemovalError("owner-unavailable", 409, `No workspace provider currently owns project ${input.id}`);
  }

  private async dispatchRequest(request: WorkspaceProviderRequest, dispatchSignal: AbortSignal): Promise<JsonValue> {
    const pluginId = request.pluginId;
    if (!isPiWebPluginId(pluginId)) {
      throw providerRequestError("inactive-plugin", 409, `Server plugin is not active: ${pluginId}`);
    }

    const operation = parseRequestOperation(request.operation);
    const moduleRevision = parseRequestRevision(request.moduleRevision, operation);
    const activeContribution = this.contributions.find((contribution) => contribution.pluginId === pluginId);
    if (activeContribution === undefined) {
      throw providerRequestError("inactive-plugin", 409, `Server plugin ${pluginId} is not active for workspace backend operation ${operation}`);
    }
    if (activeContribution.moduleRevision !== moduleRevision) {
      throw providerRequestError(
        "stale-plugin-revision",
        409,
        `Server plugin ${pluginId} backend revision is stale for operation ${operation}; reload after the session daemon restarts`,
      );
    }
    if (request.workspaceId === "") {
      throw providerRequestError("workspace-not-found", 404, `Workspace not found for server plugin ${pluginId} operation ${operation}`);
    }

    let input: JsonValue;
    try {
      input = cloneBoundedPluginBackendJson(request.input, `Server plugin ${pluginId} operation ${operation} input`);
    } catch (error) {
      throw providerRequestError("invalid-input", 400, boundedErrorMessage(error), error);
    }

    const project = snapshotProject(request.project);
    const diagnostics: WorkspaceProviderDiagnostic[] = [];
    for (const tier of ["primary", "fallback"] as const) {
      const selection = await this.selectInTier(project, tier, diagnostics, dispatchSignal);
      if (selection.kind === "none") continue;
      if (selection.kind === "conflict") {
        throw providerRequestError(
          "owner-conflict",
          409,
          `Workspace owner conflict prevents server plugin ${pluginId} operation ${operation}: ${selection.pluginIds.join(", ")}`,
        );
      }
      if (selection.contribution.pluginId !== pluginId) {
        throw providerRequestError(
          "owner-mismatch",
          409,
          `Server plugin ${pluginId} does not own project ${project.id}; current owner is ${selection.contribution.pluginId}`,
        );
      }

      const validated = await this.listRequestWorkspaces(project, selection.contribution, operation, dispatchSignal);
      const target = validated.find(({ workspace }) => workspace.id === request.workspaceId);
      if (target === undefined) {
        throw providerRequestError(
          "workspace-not-found",
          404,
          `Workspace ${request.workspaceId} is stale or unavailable for server plugin ${pluginId} operation ${operation}`,
        );
      }
      const callback = selection.contribution.provider.request?.bind(selection.contribution.provider);
      if (callback === undefined) {
        throw providerRequestError(
          "operation-unavailable",
          501,
          `Server plugin ${pluginId} does not provide workspace backend operations`,
        );
      }

      let result: unknown;
      try {
        result = await runBoundedProviderOperation(
          pluginId,
          "request",
          this.providerTimeoutMs,
          (signal) => callback(Object.freeze({
            project,
            workspace: target.providerWorkspace,
            operation,
            input,
            signal,
          })),
          dispatchSignal,
        );
      } catch (error) {
        if (error instanceof WorkspaceProviderTimeoutError) {
          throw providerRequestError("request-timeout", 504, boundedErrorMessage(error), error);
        }
        throw providerRequestError(
          "request-failed",
          502,
          `Server plugin ${pluginId} operation ${operation} failed: ${boundedErrorMessage(error)}`,
          error,
        );
      }

      try {
        return cloneBoundedPluginBackendJson(
          result,
          `Server plugin ${pluginId} operation ${operation} result`,
          PLUGIN_BACKEND_RESPONSE_JSON_MAX_BYTES,
        );
      } catch (error) {
        throw providerRequestError("invalid-result", 502, boundedErrorMessage(error), error);
      }
    }

    const failedProbe = diagnostics.find((diagnostic) => diagnostic.pluginId === pluginId && diagnostic.code === "probe-failed");
    if (failedProbe !== undefined) {
      throw providerRequestError(
        "resolution-failed",
        502,
        `Server plugin ${pluginId} owner resolution failed for operation ${operation}: ${boundedErrorMessage(failedProbe.message)}`,
      );
    }
    throw providerRequestError(
      "owner-mismatch",
      409,
      `Server plugin ${pluginId} does not own project ${project.id}`,
    );
  }

  private async listRequestWorkspaces(
    project: ProjectInput,
    contribution: ServerPluginProviderContribution,
    operation: string,
    dispatchSignal: AbortSignal,
  ): Promise<ValidatedProviderWorkspace[]> {
    try {
      const listed: unknown = await runBoundedProviderOperation(
        contribution.pluginId,
        "list",
        this.providerTimeoutMs,
        (signal) => contribution.provider.list(project, signal),
        dispatchSignal,
      );
      return await validateProviderWorkspaces(project, contribution, listed, this.pathInspector, dispatchSignal);
    } catch (error) {
      if (dispatchSignal.aborted) throw abortError(dispatchSignal);
      if (error instanceof WorkspaceProviderTimeoutError) {
        throw providerRequestError("resolution-timeout", 504, boundedErrorMessage(error), error);
      }
      throw providerRequestError(
        "resolution-failed",
        502,
        `Server plugin ${contribution.pluginId} could not resolve workspaces for operation ${operation}: ${boundedErrorMessage(error)}`,
        error,
      );
    }
  }

  private async selectInTier(
    project: ProjectInput,
    tier: ProviderTier,
    diagnostics: WorkspaceProviderDiagnostic[],
    dispatchSignal?: AbortSignal,
  ): Promise<TierSelection> {
    const candidates = this.contributions.filter(({ provider }) => (provider.fallback === true) === (tier === "fallback"));
    const claimants: ServerPluginProviderContribution[] = [];

    for (const contribution of candidates) {
      try {
        const claim = await runBoundedProviderOperation(
          contribution.pluginId,
          "probe",
          this.providerTimeoutMs,
          (signal) => contribution.provider.probe(project, signal),
          dispatchSignal,
        );
        if (!isProviderClaim(claim)) {
          throw new WorkspaceProviderContractError(`Workspace provider ${contribution.pluginId} returned an invalid probe result`);
        }
        if (claim === "claim") claimants.push(contribution);
      } catch (error) {
        if (dispatchSignal?.aborted === true) throw abortError(dispatchSignal);
        const message = errorMessage(error);
        diagnostics.push(freezeDiagnostic({
          code: "probe-failed",
          message,
          tier,
          pluginId: contribution.pluginId,
        }));
        this.options.logger.warn(
          { err: error, projectId: project.id, pluginId: contribution.pluginId, tier, operation: "probe" },
          "workspace provider probe failed",
        );
      }
    }

    if (claimants.length === 0) return { kind: "none" };
    if (claimants.length === 1) {
      const contribution = claimants[0];
      if (contribution === undefined) throw new Error("Workspace provider claimant disappeared");
      return { kind: "winner", contribution };
    }
    return Object.freeze({
      kind: "conflict",
      pluginIds: Object.freeze(claimants.map(({ pluginId }) => pluginId)),
    });
  }

  private async resolveWinner(
    project: ProjectInput,
    tier: ProviderTier,
    contribution: ServerPluginProviderContribution,
    diagnostics: WorkspaceProviderDiagnostic[],
  ): Promise<WorkspaceProviderAuthorityResolution> {
    try {
      const listed: unknown = await runBoundedProviderOperation(
        contribution.pluginId,
        "list",
        this.providerTimeoutMs,
        (signal) => contribution.provider.list(project, signal),
      );
      const validated = await validateProviderWorkspaces(project, contribution, listed, this.pathInspector);
      return Object.freeze({
        status: "provider",
        projectId: project.id,
        ownerPluginId: contribution.pluginId,
        workspaces: Object.freeze(validated.map(({ workspace }) => workspace)),
        diagnostics: Object.freeze([...diagnostics]),
      });
    } catch (error) {
      const message = errorMessage(error);
      diagnostics.push(freezeDiagnostic({
        code: "list-failed",
        message,
        tier,
        pluginId: contribution.pluginId,
      }));
      this.options.logger.warn(
        { err: error, projectId: project.id, pluginId: contribution.pluginId, tier, operation: "list" },
        "workspace provider listing failed after claim",
      );
      return degradedResolution(project, diagnostics, contribution.pluginId);
    }
  }
}

async function validateProviderWorkspaces(
  project: ProjectInput,
  contribution: ServerPluginProviderContribution,
  value: unknown,
  pathInspector: WorkspacePathInspector,
  signal?: AbortSignal,
): Promise<ValidatedProviderWorkspace[]> {
  if (!Array.isArray(value)) {
    throw new WorkspaceProviderContractError(`Workspace provider ${contribution.pluginId} list result must be an array`);
  }

  const keys = new Set<string>();
  const paths = new Set<string>();
  const workspaces: ValidatedProviderWorkspace[] = [];
  let mainCount = 0;

  for (const [index, rawWorkspace] of value.entries()) {
    throwIfAborted(signal);
    const label = `Workspace provider ${contribution.pluginId} result ${String(index + 1)}`;
    const candidate = parseProviderWorkspace(rawWorkspace, label);
    if (keys.has(candidate.key)) throw new WorkspaceProviderContractError(`${label} has duplicate key: ${candidate.key}`);
    keys.add(candidate.key);

    const path = normalizeAbsolutePath(candidate.path, `${label} path`);
    if (paths.has(path)) throw new WorkspaceProviderContractError(`${label} has duplicate path: ${path}`);
    paths.add(path);
    if (!(await pathInspector(path))) throw new WorkspaceProviderContractError(`${label} path is not an accessible directory: ${path}`);
    throwIfAborted(signal);

    if (candidate.isMain) mainCount += 1;

    const metadata = candidate.publicMetadata === undefined
      ? undefined
      : cloneJsonObject(candidate.publicMetadata, `${label} publicMetadata`);
    const data = candidate.data === undefined
      ? undefined
      : cloneJsonValue(candidate.data, new Set<object>(), `${label} data`);
    const removal = candidate.removal === undefined ? undefined : parseRemoval(candidate.removal, `${label} removal`);
    if (removal !== undefined && contribution.provider.prepareRemove === undefined) {
      throw new WorkspaceProviderContractError(`${label} advertises removal without a prepareRemove capability`);
    }
    const publicRemoval = removal === undefined
      ? undefined
      : hostRemovalPresentation(project, contribution, candidate.key, path, removal);
    const provider = Object.freeze({
      pluginId: contribution.pluginId,
      capabilities: Object.freeze({
        request: contribution.provider.request !== undefined,
        remove: removal !== undefined,
      }),
      ...(metadata === undefined ? {} : { metadata }),
    });
    const workspace: WorkspaceListing = {
      id: workspaceIdFor(project.id, candidate.key),
      projectId: project.id,
      path,
      label: candidate.label,
      isMain: candidate.isMain,
      provider,
      ...(publicRemoval === undefined ? {} : { removal: publicRemoval }),
    };
    const providerWorkspace: Readonly<ProviderWorkspace> = Object.freeze({
      key: candidate.key,
      path,
      label: candidate.label,
      isMain: candidate.isMain,
      ...(data === undefined ? {} : { data }),
      ...(metadata === undefined ? {} : { publicMetadata: metadata }),
      ...(removal === undefined ? {} : { removal }),
    });
    workspaces.push(Object.freeze({ workspace: Object.freeze(workspace), providerWorkspace }));
  }

  if (mainCount !== 1) {
    throw new WorkspaceProviderContractError(`Workspace provider ${contribution.pluginId} must return exactly one main workspace`);
  }
  return workspaces;
}

function parseProviderWorkspace(value: unknown, label: string): ParsedProviderWorkspace {
  if (!isRecord(value)) throw new WorkspaceProviderContractError(`${label} must be an object`);
  const key = value["key"];
  const path = value["path"];
  const workspaceLabel = value["label"];
  const isMain = value["isMain"];
  if (typeof key !== "string" || key === "") throw new WorkspaceProviderContractError(`${label} key must be a non-empty string`);
  if (typeof path !== "string" || path === "") throw new WorkspaceProviderContractError(`${label} path must be a non-empty string`);
  if (typeof workspaceLabel !== "string" || workspaceLabel === "") throw new WorkspaceProviderContractError(`${label} label must be a non-empty string`);
  if (typeof isMain !== "boolean") throw new WorkspaceProviderContractError(`${label} isMain must be a boolean`);

  return {
    key,
    path,
    label: workspaceLabel,
    isMain,
    ...(value["data"] === undefined ? {} : { data: value["data"] }),
    ...(value["publicMetadata"] === undefined ? {} : { publicMetadata: value["publicMetadata"] }),
    ...(value["removal"] === undefined ? {} : { removal: value["removal"] }),
  };
}

function parseRemoval(value: unknown, label: string): ProviderWorkspaceRemovalPresentation {
  if (!isRecord(value)) throw new WorkspaceProviderContractError(`${label} must be an object`);
  const actionLabel = value["actionLabel"];
  const confirmation = value["confirmation"];
  if (typeof actionLabel !== "string" || actionLabel === "") throw new WorkspaceProviderContractError(`${label} actionLabel must be a non-empty string`);
  if (typeof confirmation !== "string" || confirmation === "") throw new WorkspaceProviderContractError(`${label} confirmation must be a non-empty string`);
  return Object.freeze({ actionLabel, confirmation });
}

function hostRemovalPresentation(
  project: ProjectInput,
  contribution: ServerPluginProviderContribution,
  providerKey: string,
  path: string,
  removal: ProviderWorkspaceRemovalPresentation,
): WorkspaceRemovalHostState {
  const digest = createHash("sha256").update(JSON.stringify([
    contribution.pluginId,
    contribution.moduleRevision,
    project.id,
    providerKey,
    path,
    removal.actionLabel,
    removal.confirmation,
  ])).digest("base64url");
  return Object.freeze({ ...removal, precondition: `v1.${digest}` });
}

function workspaceResolutionKey(project: ProjectInput): string {
  return JSON.stringify([project.id, project.name, project.path]);
}

function snapshotProject(project: Project): ProjectInput {
  if (typeof project.id !== "string" || project.id === "") throw new Error("Project id must be a non-empty string");
  if (typeof project.name !== "string" || project.name === "") throw new Error("Project name must be a non-empty string");
  return Object.freeze({
    id: project.id,
    name: project.name,
    path: normalizeAbsolutePath(project.path, "Project path"),
  });
}

function degradedResolution(
  project: ProjectInput,
  diagnostics: WorkspaceProviderDiagnostic[],
  ownerPluginId?: string,
): WorkspaceProviderAuthorityResolution {
  return Object.freeze({
    status: "degraded",
    projectId: project.id,
    ...(ownerPluginId === undefined ? {} : { ownerPluginId }),
    workspaces: Object.freeze([folderWorkspace(project)]),
    diagnostics: Object.freeze([...diagnostics]),
  });
}

function folderWorkspace(project: ProjectInput): WorkspaceListing {
  return Object.freeze({
    id: workspaceIdFor(project.id, project.path),
    projectId: project.id,
    path: project.path,
    label: project.name,
    isMain: true,
  });
}

function normalizeAbsolutePath(path: string, label: string): string {
  if (!isAbsolute(path)) throw new WorkspaceProviderContractError(`${label} must be absolute`);
  return resolve(path);
}

async function pathIsDirectory(path: string): Promise<boolean> {
  const value = await stat(path).catch(() => undefined);
  return value?.isDirectory() === true;
}

async function runBoundedProviderOperation<T>(
  pluginId: string,
  operation: ProviderOperation,
  timeoutMs: number,
  callback: (signal: AbortSignal) => T | Promise<T>,
  parentSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const abortFromParent = (): void => {
    if (parentSignal !== undefined) controller.abort(abortError(parentSignal));
  };
  if (parentSignal?.aborted === true) abortFromParent();
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true });

  const timeoutError = new WorkspaceProviderTimeoutError(`Workspace provider ${pluginId} ${operation} timed out after ${String(timeoutMs)}ms`);
  const timeout = setTimeout(() => { controller.abort(timeoutError); }, timeoutMs);
  timeout.unref();
  const deadline = controller.signal.aborted
    ? Promise.reject(abortError(controller.signal))
    : new Promise<never>((_resolve, rejectPromise) => {
        controller.signal.addEventListener("abort", () => { rejectPromise(abortError(controller.signal)); }, { once: true });
      });
  const result = controller.signal.aborted
    ? new Promise<T>(() => { /* parent deadline already won */ })
    : Promise.resolve().then(() => callback(controller.signal));
  try {
    return await Promise.race([result, deadline]);
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", abortFromParent);
    if (!controller.signal.aborted) controller.abort(new DOMException("Workspace provider operation completed", "AbortError"));
  }
}

function freezeDiagnostic(diagnostic: WorkspaceProviderDiagnostic): WorkspaceProviderDiagnostic {
  const pluginIds = diagnostic.pluginIds === undefined ? undefined : Object.freeze([...diagnostic.pluginIds]);
  return Object.freeze({
    ...diagnostic,
    ...(pluginIds === undefined ? {} : { pluginIds }),
  });
}

function cloneJsonObject(value: unknown, label: string): JsonObject {
  if (!isRecord(value)) throw new WorkspaceProviderContractError(`${label} must be a JSON object`);
  const cloned = cloneJsonRecord(value, new Set<object>(), label);
  return cloned;
}

function cloneJsonRecord(value: Record<string, unknown>, ancestors: Set<object>, label: string): JsonObject {
  if (ancestors.has(value)) throw new WorkspaceProviderContractError(`${label} must not contain cycles`);
  ancestors.add(value);
  const output: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(value)) {
    Object.defineProperty(output, key, {
      value: cloneJsonValue(child, ancestors, label),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  ancestors.delete(value);
  Object.freeze(output);
  return output;
}

function cloneJsonValue(value: unknown, ancestors: Set<object>, label: string): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new WorkspaceProviderContractError(`${label} must contain only finite JSON numbers`);
    return value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new WorkspaceProviderContractError(`${label} must not contain cycles`);
    ancestors.add(value);
    const output = value.map((child) => cloneJsonValue(child, ancestors, label));
    ancestors.delete(value);
    Object.freeze(output);
    return output;
  }
  if (isRecord(value)) return cloneJsonRecord(value, ancestors, label);
  throw new WorkspaceProviderContractError(`${label} must contain only JSON values`);
}

function parseRequestOperation(value: string): string {
  try {
    return requirePluginBackendOperation(value);
  } catch (error) {
    throw providerRequestError("invalid-operation", 400, boundedErrorMessage(error), error);
  }
}

function parseRequestRevision(value: string, operation: string): string {
  try {
    return requirePluginBackendRevision(value);
  } catch (error) {
    throw providerRequestError(
      "stale-plugin-revision",
      409,
      `Plugin backend revision is unavailable for operation ${operation}: ${boundedErrorMessage(error)}`,
      error,
    );
  }
}

function providerRequestError(
  code: WorkspaceProviderRequestErrorCode,
  statusCode: number,
  message: string,
  cause?: unknown,
): WorkspaceProviderRequestError {
  return new WorkspaceProviderRequestError(code, statusCode, message, cause === undefined ? {} : { cause });
}

function providerRemovalError(
  code: WorkspaceProviderRemovalErrorCode,
  statusCode: number,
  message: string,
  cause?: unknown,
): WorkspaceProviderRemovalError {
  return new WorkspaceProviderRemovalError(code, statusCode, message, cause === undefined ? {} : { cause });
}

function parseWorkspaceRemovePlan(value: unknown, pluginId: string): WorkspaceRemovePlan {
  if (!isRecord(value)) {
    throw providerRemovalError("invalid-plan", 502, `Server plugin ${pluginId} returned an invalid workspace removal plan`);
  }
  const title = value["title"];
  const command = value["command"];
  if (typeof title !== "string" || title.trim() === "") {
    throw providerRemovalError("invalid-plan", 502, `Server plugin ${pluginId} removal plan title must be a non-empty string`);
  }
  if (typeof command !== "string" || command.trim() === "") {
    throw providerRemovalError("invalid-plan", 502, `Server plugin ${pluginId} removal plan command must be a non-empty string`);
  }
  return Object.freeze({ title, command });
}

function boundedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 2_048 ? message : `${message.slice(0, 2_045)}...`;
}

function isProviderClaim(value: unknown): value is ProviderClaim {
  return value === "claim" || value === "pass";
}

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error("Workspace provider operation aborted", { cause: reason });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw abortError(signal);
}

function positiveInteger(value: number | undefined, fallback: number, key: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) throw new Error(`${key} must be a positive integer`);
  return resolved;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class WorkspaceProviderContractError extends Error {
  override name = "WorkspaceProviderContractError";
}

class WorkspaceProviderTimeoutError extends Error {
  override name = "TimeoutError";
}
