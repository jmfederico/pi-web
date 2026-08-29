import { isAbsolute, resolve } from "node:path";
import type { JsonValue, ProjectInput, WorkspaceBackendRequestContext, WorkspaceSnapshot } from "../../server-plugin-api.js";
import type { Project, WorkspaceProviderAuthorityResolution } from "../../shared/apiTypes.js";
import { isPiWebPluginId } from "../../shared/pluginIds.js";
import {
  cloneBoundedPluginBackendJson,
  PLUGIN_BACKEND_DISPATCH_TIMEOUT_MS,
  PLUGIN_BACKEND_RESPONSE_JSON_MAX_BYTES,
  requirePluginBackendOperation,
  requirePluginBackendRevision,
} from "../../shared/pluginBackendProtocol.js";
import type { ServerPluginWorkspaceBackendContribution } from "../plugins/serverPluginRuntime.js";
import {
  WorkspaceProviderRequestError,
  type WorkspaceProviderRegistry,
  type WorkspaceProviderRequest,
} from "./workspaceProviderRegistry.js";

export interface PluginWorkspaceAuthority {
  resolve(project: Project): Promise<WorkspaceProviderAuthorityResolution>;
}

export interface PluginWorkspaceBackendDispatchResult {
  value: JsonValue;
  workspaceTopologyChanged: boolean;
}

export interface PluginWorkspaceBackendRegistryOptions {
  contributions: readonly ServerPluginWorkspaceBackendContribution[];
  authority: PluginWorkspaceAuthority;
  providers: Pick<WorkspaceProviderRegistry, "request">;
  requestTimeoutMs?: number;
}

/** Dispatches auxiliary backends without weakening provider ownership rules. */
export class PluginWorkspaceBackendRegistry {
  private readonly contributions: readonly ServerPluginWorkspaceBackendContribution[];
  private readonly requestTimeoutMs: number;

  constructor(private readonly options: PluginWorkspaceBackendRegistryOptions) {
    this.contributions = Object.freeze([...options.contributions].sort((left, right) => left.pluginId.localeCompare(right.pluginId)));
    this.requestTimeoutMs = positiveInteger(options.requestTimeoutMs, PLUGIN_BACKEND_DISPATCH_TIMEOUT_MS, "requestTimeoutMs");
  }

  workspaceTopologyMayChange(pluginId: string): boolean {
    return !this.contributions.some((contribution) => contribution.pluginId === pluginId);
  }

  async request(request: WorkspaceProviderRequest): Promise<PluginWorkspaceBackendDispatchResult> {
    const auxiliary = this.contributions.find(({ pluginId }) => pluginId === request.pluginId);
    if (auxiliary === undefined) {
      return { value: await this.options.providers.request(request), workspaceTopologyChanged: true };
    }
    const value = await runBounded(
      auxiliary.pluginId,
      this.requestTimeoutMs,
      (signal) => this.dispatchAuxiliary(auxiliary, request, signal),
    );
    return { value, workspaceTopologyChanged: false };
  }

  private async dispatchAuxiliary(
    contribution: ServerPluginWorkspaceBackendContribution,
    request: WorkspaceProviderRequest,
    signal: AbortSignal,
  ): Promise<JsonValue> {
    const pluginId = requireActivePluginId(request.pluginId);
    const operation = parseOperation(request.operation);
    const revision = parseRevision(request.moduleRevision, operation);
    if (contribution.moduleRevision !== revision) {
      throw requestError("stale-plugin-revision", 409, `Server plugin ${pluginId} backend revision is stale for operation ${operation}; reload after the session daemon restarts`);
    }
    if (request.workspaceId === "") throw requestError("workspace-not-found", 404, `Workspace not found for server plugin ${pluginId} operation ${operation}`);

    let input: JsonValue;
    try {
      input = cloneBoundedPluginBackendJson(request.input, `Server plugin ${pluginId} operation ${operation} input`);
    } catch (error) {
      throw requestError("invalid-input", 400, errorMessage(error), error);
    }

    const project = snapshotProject(request.project);
    let resolution: WorkspaceProviderAuthorityResolution;
    try {
      resolution = await this.options.authority.resolve(request.project);
    } catch (error) {
      throw requestError("resolution-failed", 502, `Workspace resolution failed for server plugin ${pluginId} operation ${operation}: ${errorMessage(error)}`, error);
    }
    if (signal.aborted) throw abortError(signal);
    if (resolution.status === "degraded") {
      throw requestError("resolution-failed", 409, `Workspace authority is degraded for server plugin ${pluginId} operation ${operation}`);
    }
    const current = resolution.workspaces.find(({ id }) => id === request.workspaceId);
    if (!current) {
      throw requestError("workspace-not-found", 404, `Workspace ${request.workspaceId} is stale or unavailable for server plugin ${pluginId} operation ${operation}`);
    }
    const workspace: WorkspaceSnapshot = Object.freeze({
      id: current.id,
      projectId: current.projectId,
      path: current.path,
      label: current.label,
      isMain: current.isMain,
    });
    const context: WorkspaceBackendRequestContext = Object.freeze({ project, workspace, operation, input, signal });

    let result: unknown;
    try {
      result = await contribution.backend.request(context);
    } catch (error) {
      throw requestError("request-failed", 502, `Server plugin ${pluginId} operation ${operation} failed: ${errorMessage(error)}`, error);
    }
    try {
      return cloneBoundedPluginBackendJson(result, `Server plugin ${pluginId} operation ${operation} result`, PLUGIN_BACKEND_RESPONSE_JSON_MAX_BYTES);
    } catch (error) {
      throw requestError("invalid-result", 502, errorMessage(error), error);
    }
  }
}

function snapshotProject(project: Project): ProjectInput {
  if (project.id === "" || project.name === "" || !isAbsolute(project.path)) throw new Error("Project snapshot is invalid");
  return Object.freeze({ id: project.id, name: project.name, path: resolve(project.path) });
}

function requireActivePluginId(value: string): string {
  if (!isPiWebPluginId(value)) throw requestError("inactive-plugin", 409, `Server plugin is not active: ${value}`);
  return value;
}

function parseOperation(value: string): string {
  try { return requirePluginBackendOperation(value); }
  catch (error) { throw requestError("invalid-operation", 400, errorMessage(error), error); }
}

function parseRevision(value: string, operation: string): string {
  try { return requirePluginBackendRevision(value); }
  catch (error) { throw requestError("stale-plugin-revision", 409, `Plugin backend revision is unavailable for operation ${operation}: ${errorMessage(error)}`, error); }
}

function requestError(code: ConstructorParameters<typeof WorkspaceProviderRequestError>[0], status: number, message: string, cause?: unknown): WorkspaceProviderRequestError {
  return new WorkspaceProviderRequestError(code, status, message, cause === undefined ? {} : { cause });
}

async function runBounded<T>(pluginId: string, timeoutMs: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timeoutError = new Error(`Server plugin ${pluginId} request timed out after ${String(timeoutMs)}ms`);
  timeoutError.name = "TimeoutError";
  const timeout = setTimeout(() => { controller.abort(timeoutError); }, timeoutMs);
  timeout.unref();
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener("abort", () => { reject(abortError(controller.signal)); }, { once: true });
      }),
    ]);
  } catch (error) {
    if (error === timeoutError) throw requestError("request-timeout", 504, timeoutError.message, error);
    throw error;
  } finally {
    clearTimeout(timeout);
    if (!controller.signal.aborted) controller.abort(new DOMException("Server plugin request completed", "AbortError"));
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Server plugin request aborted", { cause: signal.reason });
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function positiveInteger(value: number | undefined, fallback: number, key: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) throw new Error(`${key} must be a positive integer`);
  return resolved;
}
