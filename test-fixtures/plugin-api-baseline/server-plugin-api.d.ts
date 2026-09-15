import type { JsonObject, JsonPrimitive, JsonValue, PluginCapability, PluginCapabilityProvision, WorkspaceProviderMetadata, WorkspaceRemovalPresentation } from "./shared/pluginApiTypes.js";
export type { JsonObject, JsonPrimitive, JsonValue, PluginCapability, PluginCapabilityProvision, WorkspaceProviderMetadata, WorkspaceRemovalPresentation, };
type MaybePromise<T> = T | Promise<T>;
/** Public server entry exported by a package's `serverModule`. */
export interface PiWebServerPlugin {
    apiVersion: 3;
    name: string;
    /** Exact capability versions that must be active before this plugin starts. */
    requires?: readonly PluginCapability[];
    activate(context: ServerPluginActivationContext): MaybePromise<ServerPluginActivation>;
}
/** Host-owned frozen values supplied during server plugin activation. */
export interface ServerPluginActivationContext {
    readonly apiVersion: 3;
    readonly pluginId: string;
    readonly packageRoot: string;
    /** Absolute plugin-specific persistent directory, created by the host before activation. Plugins own all file I/O and data formats. */
    readonly dataDirectory: string;
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
     * out or settles and must not be retained for lifetime cleanup.
     */
    readonly signal: AbortSignal;
    /**
     * Signal for the complete plugin lifetime. It is aborted as soon as host
     * ingress quiesces, before bounded disposal begins.
     */
    readonly lifetimeSignal: AbortSignal;
}
export type ServerPluginNoticeSeverity = "info" | "warning" | "error";
/** Browser-visibility selectors, matched only against the selected machine context; each id is at most 512 characters. */
export type ServerPluginNoticeScope = {
    readonly projectId: string;
    readonly workspaceId?: string;
    readonly sessionId?: string;
} | {
    readonly projectId?: string;
    readonly workspaceId: string;
    readonly sessionId?: string;
} | {
    readonly projectId?: string;
    readonly workspaceId?: string;
    readonly sessionId: string;
};
/** Plugin-authored notice data. The host supplies the immutable source identity. */
export interface ServerPluginNoticeInput {
    readonly severity: ServerPluginNoticeSeverity;
    /** Non-empty human-readable text, limited to 4 KiB of UTF-8. */
    readonly message: string;
    /** Omit for a global notice; a supplied scope must contain at least one id. */
    readonly scope?: ServerPluginNoticeScope;
    /** Detached metadata; keys never affect visibility. Limited to 16 KiB and JSON depth 32. */
    readonly context?: JsonObject;
}
/**
 * Optional versioned capability for recording host-owned server notices.
 * It remains live through activation, start, active operation, and shutdown
 * dependency cleanup, then is revoked before failed-start rollback or this
 * plugin's ordinary disposal begins.
 */
export interface ServerPluginNoticeReporterV1 {
    readonly version: 1;
    /** Throws after reporter revocation or when the complete input is invalid. */
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
/** Current host authority selected only by opaque project and workspace ids. */
export interface PiWebHostWorkspaceSelection {
    readonly projectId: string;
    readonly workspaceId: string;
}
/** Detached project and workspace projections resolved from current host authority. */
export interface PiWebHostWorkspaceAuthority {
    readonly project: ProjectInput;
    readonly workspace: ServerPluginPeerWorkspace;
}
/** Package-attributed resolver for current project/workspace authority. */
export interface PiWebHostWorkspacesV1 {
    readonly version: 1;
    /** Re-resolve both ids on every call; stale or mismatched selections reject. */
    readonly resolve: (selection: PiWebHostWorkspaceSelection) => Promise<PiWebHostWorkspaceAuthority>;
}
/** Exact workspaces v1 capability supplied separately for each declaring server plugin. */
export declare const PI_WEB_HOST_WORKSPACES_CAPABILITY: PluginCapability<PiWebHostWorkspacesV1, 1>;
/** Bounded input for one host-owned Pi session run in current workspace authority. */
export interface PiWebHostPiSessionRunInput {
    /** Opaque current project id, limited to 512 characters. */
    readonly projectId: string;
    /** Opaque current workspace id, limited to 512 characters. */
    readonly workspaceId: string;
    /** Non-empty initial prompt, limited to 64 KiB of UTF-8. */
    readonly prompt: string;
}
/** Detached final outcome for one host-owned Pi session run. */
export type PiWebHostPiSessionRunCompletion = {
    readonly status: "completed";
} | {
    readonly status: "failed";
    /** Non-empty host-projected failure text, limited to 4 KiB of UTF-8. */
    readonly error: string;
} | {
    readonly status: "cancelled";
};
/** Published host-owned conversation; creation does not open a messaging connection. */
export interface PiWebHostPiSessionCreated {
    readonly sessionId: string;
}
/** Host-owned conversation identity; initial completion never closes the session. */
export interface PiWebHostPiSessionRun extends PiWebHostPiSessionCreated {
    /** Initial submission outcome, including final provider errors; not later user turns. */
    readonly completion: Promise<PiWebHostPiSessionRunCompletion>;
}
/** Bounded initial-run admission. Plugin revocation cancels only unpublished startup. */
export interface PiWebHostPiSessionsV1 {
    readonly version: 1;
    /** Publish an observed session without a prompt; connect separately before companion kickoff. */
    readonly create: (input: PiWebHostWorkspaceSelection) => Promise<PiWebHostPiSessionCreated>;
    /** Re-resolve current authority, start one session, and admit its initial prompt. */
    readonly run: (input: PiWebHostPiSessionRunInput) => Promise<PiWebHostPiSessionRun>;
}
/** Exact PI sessions v1 capability supplied separately for each declaring server plugin. */
export declare const PI_WEB_HOST_PI_SESSIONS_CAPABILITY: PluginCapability<PiWebHostPiSessionsV1, 1>;
/** Exact hosted conversation on the selected machine; creation is separate. */
export interface PiWebHostPiSessionSelection extends PiWebHostWorkspaceSelection {
    readonly sessionId: string;
}
/** Ephemeral connection to one hosted session's native pi.events bus. */
export interface PiWebHostPiSessionConnection {
    /** Aborts on close, plugin disposal, or hosted runtime replacement/close. */
    readonly signal: AbortSignal;
    /** Subscribe before emitting: replies may arrive synchronously. No replay. */
    readonly on: (channel: string, handler: (data: unknown) => void | Promise<void>) => () => void;
    /** Native fire-and-forget delivery; not an acknowledgement or agent completion. */
    readonly emit: (channel: string, data: unknown) => void;
    /** Idempotent; detaches listeners without stopping the conversation. */
    readonly close: () => void;
}
export interface PiWebHostPiSessionEventsV1 {
    readonly version: 1;
    readonly connect: (selection: PiWebHostPiSessionSelection) => Promise<PiWebHostPiSessionConnection>;
}
/** Session-local package messaging, not an agent-control or SDK capability. */
export declare const PI_WEB_HOST_PI_SESSION_EVENTS_CAPABILITY: PluginCapability<PiWebHostPiSessionEventsV1, 1>;
/** Resolver containing only the exact capability requirements declared by a plugin. */
export interface ServerPluginCapabilityResolver {
    readonly resolve: <Value>(capability: PluginCapability<Value>) => Value;
}
/** Frozen values supplied once all declared dependencies are active. */
export interface ServerPluginStartContext {
    readonly capabilities: ServerPluginCapabilityResolver;
    /** Signal for this bounded start invocation, not the plugin lifetime. */
    readonly signal: AbortSignal;
}
/**
 * Signals passed to lifecycle callbacks are scoped to that single invocation
 * and are aborted when it times out or settles. Lifetime cancellation is
 * supplied separately during activation and precedes bounded disposal.
 */
export interface ServerPluginActivation {
    workspaceProvider?: WorkspaceProvider;
    /** Serve bounded requests and optional duplex channels from this package's paired browser entry. */
    peer?: ServerPluginPeer;
    /** Typed capability values owned by this plugin and published only after start succeeds. */
    provides?: readonly PluginCapabilityProvision[];
    /** Initialize resources after every exact declared capability requirement is active. */
    start?(context: ServerPluginStartContext): MaybePromise<void>;
    /** Release resources within one host-bounded disposal invocation. */
    dispose?(signal: AbortSignal): MaybePromise<void>;
    /** Inspect health within one host-bounded health invocation. */
    health?(signal: AbortSignal): MaybePromise<ServerPluginHealth>;
}
export interface ServerPluginHealth {
    status: "healthy" | "degraded" | "unhealthy";
    message?: string;
    details?: JsonObject;
}
/**
 * Capabilities for this package's matching browser entry. An activation may
 * supply a request handler, a channel handler, or both, but never neither.
 */
export type ServerPluginPeer = {
    request(context: ServerPluginPeerRequestContext): MaybePromise<JsonValue>;
    /** Open one finite-lived, host-bounded duplex channel. */
    openChannel?(context: ServerPluginPeerChannelOpenContext): MaybePromise<ServerPluginPeerChannel>;
} | {
    request?: undefined;
    /** Open one finite-lived, host-bounded duplex channel. */
    openChannel(context: ServerPluginPeerChannelOpenContext): MaybePromise<ServerPluginPeerChannel>;
};
/** Channel instance returned by `openChannel()` after the host validates scope. */
export interface ServerPluginPeerChannel {
    /** Consume one browser-authored JSON frame in accepted order within a host-bounded invocation. */
    receive(data: JsonValue, signal: AbortSignal): MaybePromise<void>;
    /**
     * Optional plugin-owned completion signal. Resolve it only after the final
     * send; the host boundedly drains accepted transport work before physical
     * close and admission release.
     */
    readonly closed?: PromiseLike<void>;
    /** Release channel resources once after disconnect, failure, expiry, shutdown, or plugin completion. */
    close?(context: ServerPluginPeerChannelCloseContext): MaybePromise<void>;
}
export interface ServerPluginPeerChannelCloseContext {
    readonly code: number;
    readonly reason: string;
    /** Signal for this bounded close invocation, not the already-ended channel lifetime. */
    readonly signal: AbortSignal;
}
/** Host-resolved, browser-visible workspace projection without provider-private data. */
export interface ServerPluginPeerWorkspace {
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
export interface ServerPluginPeerRequestContext {
    readonly project: ProjectInput;
    readonly workspace: ServerPluginPeerWorkspace;
    readonly operation: string;
    readonly input: JsonValue;
    readonly signal: AbortSignal;
}
/**
 * Host-resolved channel scope. `signal` remains live for the channel lifetime
 * and is aborted on disconnect, failure, expiry, or shutdown. `send()` clones
 * and bounds one JSON frame synchronously; success means queue acceptance, not
 * remote receipt. Invalid data or host queue overflow throws and closes the channel.
 */
export interface ServerPluginPeerChannelOpenContext {
    readonly project: ProjectInput;
    readonly workspace: ServerPluginPeerWorkspace;
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
