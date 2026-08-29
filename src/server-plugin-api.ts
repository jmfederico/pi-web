import type { JsonObject, JsonPrimitive, JsonValue, WorkspaceRemovalPresentation } from "./shared/pluginApiTypes.js";

export type { JsonObject, JsonPrimitive, JsonValue, WorkspaceRemovalPresentation };

type MaybePromise<T> = T | Promise<T>;

/** Public server entry exported by a package's `serverModule`. */
export interface PiWebServerPlugin {
  apiVersion: 1;
  name: string;
  activate(context: ServerPluginActivationContext): MaybePromise<ServerPluginActivation>;
}

/** Host-owned frozen values supplied during server plugin activation. */
export interface ServerPluginActivationContext {
  readonly apiVersion: 1;
  readonly pluginId: string;
  readonly packageRoot: string;
  readonly logger: ServerPluginLogger;
  readonly settings: JsonObject;
  /**
   * Execute an argv-based command through host-owned output and time bounds.
   * The caller must forward the signal for its current bounded operation.
   */
  readonly execFile: (request: ServerPluginExecFileRequest) => Promise<ServerPluginExecFileResult>;
  /**
   * Signal for this activation invocation. It is aborted when activation times
   * out or settles; it is not a plugin-lifetime shutdown signal.
   */
  readonly signal: AbortSignal;
}

/** Host-owned logger supplied through the frozen activation context. */
export interface ServerPluginLogger {
  readonly debug: (message: string, details?: JsonObject) => void;
  readonly info: (message: string, details?: JsonObject) => void;
  readonly warn: (message: string, details?: JsonObject) => void;
  readonly error: (message: string, details?: JsonObject) => void;
}

export interface ServerPluginExecFileRequest {
  file: string;
  args?: readonly string[];
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  /** Environment keys removed after host defaults and plugin overrides merge. */
  unsetEnv?: readonly string[];
  /**
   * Optional payload piped to the command's standard input; no shell is
   * involved. Strings are UTF-8 encoded. The host enforces a byte cap, never
   * logs the payload or includes it in errors, and zeroes its retained copy
   * once the command settles. Empty payloads behave like an absent stdin.
   */
  stdin?: string | Uint8Array;
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

/**
 * Signals passed to lifecycle callbacks are scoped to that single invocation
 * and are aborted when it times out or settles. They are not plugin-lifetime
 * shutdown signals; the host invokes `stop()` explicitly during shutdown.
 */
export interface ServerPluginActivation {
  workspaceProvider?: WorkspaceProvider;
  /** Initialize resources within one host-bounded start invocation. */
  start?(signal: AbortSignal): MaybePromise<void>;
  /** Release resources within one host-bounded stop invocation. */
  stop?(signal: AbortSignal): MaybePromise<void>;
  /** Inspect health within one host-bounded health invocation. */
  health?(signal: AbortSignal): MaybePromise<ServerPluginHealth>;
}

export interface ServerPluginHealth {
  status: "healthy" | "degraded" | "unhealthy";
  message?: string;
  details?: JsonObject;
}

/**
 * Every signal supplied to a provider is scoped to that single callback
 * invocation. The host aborts it when the operation times out or settles; it
 * must not be retained as a plugin-lifetime shutdown signal.
 */
export interface WorkspaceProvider {
  /** Fallback providers are considered only after all primary providers pass. */
  fallback?: boolean;
  probe(project: ProjectInput, signal: AbortSignal): Promise<ProviderClaim>;
  list(project: ProjectInput, signal: AbortSignal): Promise<ProviderWorkspace[]>;
  request?(context: ProviderRequestContext): Promise<ProviderResponse>;
  /**
   * Opt-in raw binary counterpart of `request()`. Implement it when an
   * operation must receive a payload that is not JSON — for example a secret
   * that should travel as an opaque byte body instead of a logged,
   * history-prone JSON envelope. The host enforces a byte cap (1 MiB) before
   * dispatch, holds the body in memory only for the invocation, and never
   * logs, persists, or echoes it. The result remains a bounded JSON value.
   */
  requestBinary?(context: ProviderBinaryRequestContext): Promise<ProviderResponse>;
  prepareRemove?(context: ProviderRemoveContext): Promise<WorkspaceRemovePlan>;
}

export type ProviderClaim = "claim" | "pass";

export interface ProjectInput {
  readonly id: string;
  readonly name: string;
  readonly path: string;
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
  /**
   * Serializable data included in browser workspace responses. It is visible
   * to all browser code and API consumers, so it must never contain secrets.
   */
  publicMetadata?: JsonObject;
  removal?: WorkspaceRemovalPresentation;
}

export interface ProviderRequestContext {
  readonly project: ProjectInput;
  /** Host-validated, frozen projection of one listed provider workspace. */
  readonly workspace: Readonly<ProviderWorkspace>;
  readonly operation: string;
  readonly input: JsonValue;
  readonly signal: AbortSignal;
}

/** Provider-private JSON result returned through the host's scoped bridge. */
export type ProviderResponse = JsonValue;

export interface ProviderBinaryRequestContext {
  readonly project: ProjectInput;
  /** Host-validated, frozen projection of one listed provider workspace. */
  readonly workspace: Readonly<ProviderWorkspace>;
  readonly operation: string;
  /**
   * Bounded raw request body (at most 1 MiB). The host keeps it in memory for
   * this invocation only, never logs or persists it, and reports bound
   * failures by byte count only. Treat it as sensitive: do not log it, and
   * never echo it back through the JSON result, which crosses to browser
   * callers.
   */
  readonly body: Uint8Array;
  readonly signal: AbortSignal;
}

export interface ProviderRemoveContext {
  readonly project: ProjectInput;
  /** Host-validated, frozen projection of one listed provider workspace. */
  readonly workspace: Readonly<ProviderWorkspace>;
  readonly signal: AbortSignal;
}

/**
 * Plugin-authored plan for a visible host terminal run. Returning this plan
 * approves the operation; it does not mean removal has completed.
 */
export interface WorkspaceRemovePlan {
  /** Human-readable title for the host-owned terminal run. */
  title: string;
  /**
   * Shell source interpreted by the host's login shell. The host chooses a safe
   * current non-target workspace as the working directory, so any workspace
   * path used here must be the absolute `workspace.path` supplied in the
   * request and must be shell-quoted by the provider. Keep the removal in the
   * foreground: the host records completion when the shell exits, with exit 0
   * meaning the removal succeeded.
   */
  command: string;
}
