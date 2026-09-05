import type { JsonObject, JsonPrimitive, JsonValue, WorkspaceProviderMetadata, WorkspaceRemovalPresentation } from "./shared/pluginApiTypes.js";
export type { JsonObject, JsonPrimitive, JsonValue, WorkspaceProviderMetadata, WorkspaceRemovalPresentation, };
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
    /** Record a host-attributed application notice when this capability is available. */
    readonly notices?: ServerPluginNoticeReporterV1;
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
export type ServerPluginNoticeSeverity = "info" | "warning" | "error";
/** Plugin-authored notice data. The host supplies the immutable source identity. */
export interface ServerPluginNoticeInput {
    readonly severity: ServerPluginNoticeSeverity;
    readonly message: string;
    readonly context?: JsonObject;
}
/** Optional versioned capability for recording host-owned server notices. */
export interface ServerPluginNoticeReporterV1 {
    readonly version: 1;
    readonly record: (input: ServerPluginNoticeInput) => void;
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
    /** Serve bounded requests and optional duplex channels from this package's paired browser entry. */
    pairedBackend?: PairedPluginBackendV1;
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
/** JSON request capability for this package's matching browser entry. */
export interface PairedPluginBackendV1 {
    readonly version: 1;
    request(context: PairedPluginRequestContext): MaybePromise<JsonValue>;
    /** Open one finite-lived, host-bounded duplex channel. */
    openChannel?(context: PairedPluginChannelOpenContext): MaybePromise<PairedPluginChannel>;
}
/** Channel instance returned by `openChannel()` after the host validates scope. */
export interface PairedPluginChannel {
    /** Consume one browser-authored JSON frame in accepted order within a host-bounded invocation. */
    receive(data: JsonValue, signal: AbortSignal): MaybePromise<void>;
    /**
     * Optional plugin-owned completion signal. Resolve it only after the final
     * send; the host boundedly drains accepted transport work before physical
     * close and admission release.
     */
    readonly closed?: PromiseLike<void>;
    /** Release channel resources once after disconnect, failure, expiry, shutdown, or plugin completion. */
    close?(context: PairedPluginChannelCloseContext): MaybePromise<void>;
}
export interface PairedPluginChannelCloseContext {
    readonly code: number;
    readonly reason: string;
    /** Signal for this bounded close invocation, not the already-ended channel lifetime. */
    readonly signal: AbortSignal;
}
/** Host-resolved, browser-visible workspace projection without provider-private data. */
export interface PairedPluginWorkspace {
    readonly id: string;
    readonly projectId: string;
    readonly path: string;
    readonly label: string;
    readonly isMain: boolean;
    readonly provider?: WorkspaceProviderMetadata;
}
/**
 * Every value is host-derived, cloned, and frozen. The signal belongs only to
 * this callback and is aborted when the request times out, is cancelled, or
 * settles.
 */
export interface PairedPluginRequestContext {
    readonly project: ProjectInput;
    readonly workspace: PairedPluginWorkspace;
    readonly operation: string;
    readonly input: JsonValue;
    readonly signal: AbortSignal;
}
/**
 * Host-resolved channel scope. `signal` remains live for the channel lifetime
 * and is aborted on disconnect, failure, expiry, or shutdown. `send()` clones
 * and bounds one JSON frame synchronously; it throws and closes the channel on
 * invalid data or host queue overflow.
 */
export interface PairedPluginChannelOpenContext {
    readonly project: ProjectInput;
    readonly workspace: PairedPluginWorkspace;
    readonly operation: string;
    readonly input: JsonValue;
    readonly signal: AbortSignal;
    readonly send: (data: JsonValue) => void;
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
