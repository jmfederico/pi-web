/** JSON values accepted across the PI WEB server-plugin boundary. */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

type MaybePromise<T> = T | Promise<T>;

/** Public server entry exported by a package's `serverModule`. */
export interface PiWebServerPlugin {
  apiVersion: 1;
  name: string;
  activate(context: ServerPluginActivationContext): MaybePromise<ServerPluginActivation>;
}

export interface ServerPluginActivationContext {
  apiVersion: 1;
  pluginId: string;
  packageRoot: string;
  logger: ServerPluginLogger;
  settings: JsonObject;
  /**
   * Execute an argv-based command through host-owned output and time bounds.
   * The caller must forward the signal for its current bounded operation.
   */
  execFile(request: ServerPluginExecFileRequest): Promise<ServerPluginExecFileResult>;
  /** Aborted when the host's activation deadline expires. */
  signal: AbortSignal;
}

export interface ServerPluginLogger {
  debug(message: string, details?: JsonObject): void;
  info(message: string, details?: JsonObject): void;
  warn(message: string, details?: JsonObject): void;
  error(message: string, details?: JsonObject): void;
}

export interface ServerPluginExecFileRequest {
  file: string;
  args?: readonly string[];
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  /** Environment keys removed after host defaults and plugin overrides merge. */
  unsetEnv?: readonly string[];
  /** Requested timeout; the host may apply a lower maximum. */
  timeoutMs?: number;
  signal: AbortSignal;
}

export interface ServerPluginExecFileResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface ServerPluginActivation {
  workspaceProvider?: WorkspaceProvider;
  start?(signal: AbortSignal): MaybePromise<void>;
  stop?(signal: AbortSignal): MaybePromise<void>;
  health?(signal: AbortSignal): MaybePromise<ServerPluginHealth>;
}

export interface ServerPluginHealth {
  status: "healthy" | "degraded" | "unhealthy";
  message?: string;
  details?: JsonObject;
}

export interface WorkspaceProvider {
  /** Fallback providers are considered only after all primary providers pass. */
  fallback?: boolean;
  probe(project: ProjectInput, signal: AbortSignal): Promise<ProviderClaim>;
  list(project: ProjectInput, signal: AbortSignal): Promise<ProviderWorkspace[]>;
  request?(context: ProviderRequestContext): Promise<ProviderResponse>;
  prepareRemove?(context: ProviderRemoveContext): Promise<WorkspaceRemovePlan>;
}

export type ProviderClaim = "claim" | "pass";

export interface ProjectInput {
  id: string;
  name: string;
  path: string;
}

export interface ProviderWorkspace {
  /** Provider-local stable key; the host derives the public workspace id. */
  key: string;
  /** Absolute workspace path. The host validates ownership and path invariants. */
  path: string;
  label: string;
  isMain: boolean;
  /** Opaque provider-private data returned to this provider during the resolution. */
  data?: JsonValue;
  /** Opaque serializable data exposed only to the owning browser plugin. */
  publicMetadata?: JsonObject;
  removal?: WorkspaceRemovalPresentation;
}

export interface ProviderRequestContext {
  project: ProjectInput;
  workspace: ProviderWorkspace;
  operation: string;
  input: JsonValue;
  signal: AbortSignal;
}

/** Provider-private JSON result returned through the host's scoped bridge. */
export type ProviderResponse = JsonValue;

export interface ProviderRemoveContext {
  project: ProjectInput;
  workspace: ProviderWorkspace;
  signal: AbortSignal;
}

/** Serializable provider wording advertised with a removable workspace. */
export interface WorkspaceRemovalPresentation {
  actionLabel: string;
  confirmation: string;
}

/** Host-validated plan run as a visible terminal command from a safe workspace. */
export interface WorkspaceRemovePlan {
  title: string;
  command: string;
}
