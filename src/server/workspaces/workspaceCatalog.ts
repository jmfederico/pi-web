import type { ServerPluginSafeStart } from "../../serverPluginRecovery.js";
import type { WorkspaceListing, WorkspaceProviderAuthorityResolution } from "../../shared/apiTypes.js";
import type {
  ServerPluginHealthInspection,
  ServerPluginRuntimeRecord,
} from "../plugins/serverPluginRuntime.js";
import type { PiWebPluginCatalogDiagnostic } from "../piWebPluginCatalog.js";

export const WORKSPACE_PROVIDER_RUNTIME_PROTOCOL_VERSION = 1;

/** Web-side port for sessiond's authoritative, live workspace catalog. */
export interface WorkspaceCatalog {
  /** Preserve the daemon authority's provider-neutral ownership and diagnostics. */
  resolveProject(projectId: string): Promise<WorkspaceProviderAuthorityResolution>;
  /** Explicit workspace-only adapter for filesystem/session consumers. */
  list(projectId: string): Promise<WorkspaceListing[]>;
  resolve(projectId: string, workspaceId: string): Promise<WorkspaceListing>;
}

/** Immutable sessiond startup snapshot used to reconcile desired web plugins. */
export interface WorkspaceProviderRuntimeSnapshot {
  protocolVersion: typeof WORKSPACE_PROVIDER_RUNTIME_PROTOCOL_VERSION;
  safeStart?: ServerPluginSafeStart;
  records: readonly ServerPluginRuntimeRecord[];
  health: readonly ServerPluginHealthInspection[];
  diagnostics: readonly PiWebPluginCatalogDiagnostic[];
}

export interface WorkspaceProviderRuntimeReader {
  providerRuntime(): Promise<WorkspaceProviderRuntimeSnapshot>;
}

export function createWorkspaceProviderRuntimeSnapshot(
  records: readonly ServerPluginRuntimeRecord[],
  health: readonly ServerPluginHealthInspection[],
  safeStart?: ServerPluginSafeStart,
  diagnostics: readonly PiWebPluginCatalogDiagnostic[] = [],
): WorkspaceProviderRuntimeSnapshot {
  return Object.freeze({
    protocolVersion: WORKSPACE_PROVIDER_RUNTIME_PROTOCOL_VERSION,
    ...(safeStart === undefined ? {} : { safeStart }),
    records: Object.freeze(records.map((record) => Object.freeze({ ...record }))),
    health: Object.freeze(health.map((inspection) => Object.freeze({
      ...inspection,
      health: Object.freeze({ ...inspection.health }),
    }))),
    diagnostics: Object.freeze(diagnostics.map((diagnostic) => Object.freeze({ ...diagnostic }))),
  });
}

export class WorkspaceCatalogUnavailableError extends Error {
  override name = "WorkspaceCatalogUnavailableError";
}

export class WorkspaceCatalogProtocolError extends Error {
  override name = "WorkspaceCatalogProtocolError";
}

export class WorkspaceCatalogRequestError extends Error {
  override name = "WorkspaceCatalogRequestError";

  constructor(message: string, readonly statusCode: number) {
    super(message);
  }
}

/** Preserve route-specific legacy status codes while making authority failures explicit. */
export function workspaceCatalogHttpStatus(error: unknown, fallbackStatus: number): number {
  if (error instanceof WorkspaceCatalogUnavailableError) return 503;
  if (error instanceof WorkspaceCatalogProtocolError) return 502;
  if (error instanceof WorkspaceCatalogRequestError) {
    if (error.statusCode === 503) return 503;
    if (error.statusCode >= 500) return 502;
  }
  return fallbackStatus;
}
