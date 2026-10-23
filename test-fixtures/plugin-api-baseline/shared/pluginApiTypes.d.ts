export type MachineKind = "local" | "remote";
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject {
    readonly [key: string]: JsonValue;
}
export type PluginBackendScope = {
    readonly kind: "machine";
} | {
    readonly kind: "project";
    readonly projectId: string;
} | {
    readonly kind: "workspace";
    readonly projectId: string;
    readonly workspaceId: string;
};
/** Exact package-paired backend on the captured machine. */
export interface PluginBackend {
    readonly machineId: string;
    forScope(scope: PluginBackendScope): PluginPeer;
}
export interface PluginPeerRequestOptions {
    /** Cancels this bounded request through local or federated host transport. */
    readonly signal?: AbortSignal;
}
/** Callbacks and cancellation for one bounded package-peer channel. */
export interface PluginPeerChannelOptions {
    /** Cancels the channel open or closes the live channel through every host hop. */
    readonly signal?: AbortSignal;
    /** Receives one plugin-authored JSON frame after the channel is ready. */
    readonly onData: (data: JsonValue) => void;
}
export interface PluginPeerChannelClose {
    readonly code: number;
    readonly reason: string;
    readonly wasClean: boolean;
    /** Attributed host or server-plugin failure when one preceded the close. */
    readonly error?: Readonly<{
        code: string;
        message: string;
    }>;
}
export interface PluginPeerChannel {
    readonly closed: Promise<PluginPeerChannelClose>;
    /** Queue one bounded JSON frame or throw. Success means queue acceptance, not remote receipt. */
    send(data: JsonValue): void;
    close(reason?: string): void;
}
/**
 * Exact revision-paired path to this package's active server entry.
 * A peer supplies a request handler, a channel handler, or both, but never neither.
 */
export type PluginPeer = {
    request(operation: string, input: JsonValue, options?: PluginPeerRequestOptions): Promise<JsonValue>;
    openChannel?(operation: string, input: JsonValue, options: PluginPeerChannelOptions): Promise<PluginPeerChannel>;
} | {
    request?: undefined;
    openChannel(operation: string, input: JsonValue, options: PluginPeerChannelOptions): Promise<PluginPeerChannel>;
};
/** Explicitly browser-public session data, keyed by owning package/plugin namespace. */
export type SessionUiMetadata = Readonly<Record<string, JsonObject>>;
/**
 * Typed token for one exact host/plugin capability version. The provider id
 * and package-local id together with the version form the stable capability
 * identity; matching keys do not imply matching parsers. `parse` validates and
 * may snapshot values at provider, declared-requirement, and resolution boundaries.
 * Parsers must be pure (no input mutation or lifecycle side effects) and tolerate
 * repeated calls; invocation counts and returned object identity are not guaranteed.
 * A resolver's parser receives the provider-parsed value, not the discarded result
 * of declared-requirement validation.
 */
export interface PluginCapability<Value = unknown, Version extends number = number> {
    readonly pluginId: string;
    readonly id: string;
    readonly version: Version;
    readonly parse: (value: unknown) => Value;
}
/** One capability value declaratively published by its owning plugin. */
export interface PluginCapabilityProvision<Value = unknown, Version extends number = number> {
    readonly capability: PluginCapability<Value, Version>;
    readonly value: Value;
}
export interface WorkspaceProviderCapabilities {
    /** True only when this specific workspace advertises removal. */
    readonly remove: boolean;
}
/** Public identity and browser-visible data for the plugin that owns a workspace. */
export interface WorkspaceProviderMetadata {
    readonly pluginId: string;
    readonly capabilities: WorkspaceProviderCapabilities;
    readonly metadata?: JsonObject;
}
/** Provider-authored removal wording exposed to browser plugins. */
export interface WorkspaceRemovalPresentation {
    readonly actionLabel: string;
    readonly confirmation: string;
}
export interface FileTreeEntry {
    name: string;
    path: string;
    type: "file" | "directory" | "symlink";
    size?: number;
    modifiedAt?: string;
}
export interface FileTreeResponse {
    path: string;
    entries: FileTreeEntry[];
    scannedAt: string;
    truncated: boolean;
}
export type FileContentMediaType = "image" | "html" | "pdf" | "markdown";
export interface FileContentResponse {
    path: string;
    language?: string;
    mediaType?: FileContentMediaType;
    mimeType?: string;
    encoding: "utf8";
    size: number;
    modifiedAt: string;
    content: string;
    truncated: boolean;
    binary: boolean;
}
export interface WriteWorkspaceFileOptions {
    createDirs?: boolean;
    overwrite?: boolean;
}
export interface WriteWorkspaceFileResponse {
    path: string;
    size: number;
    modifiedAt: string;
    created: boolean;
}
export interface DeleteWorkspaceFileResponse {
    path: string;
    existed: boolean;
}
export interface MoveWorkspaceFileOptions {
    createDirs?: boolean;
    overwrite?: boolean;
}
export interface MoveWorkspaceFileResponse {
    fromPath: string;
    toPath: string;
    size: number;
    modifiedAt: string;
}
export type TerminalCommandRunStatus = "queued" | "running" | "succeeded" | "failed";
interface TerminalCommandRunFields {
    id: string;
    origin: string;
    terminalId: string;
    title: string;
    command: string;
    status: TerminalCommandRunStatus;
    exitCode?: number;
    createdAt: string;
    startedAt?: string;
    completedAt?: string;
    metadata: Record<string, string>;
}
export interface TerminalCommandRun extends TerminalCommandRunFields {
    scope?: "workspace";
    projectId: string;
    workspaceId: string;
}
export interface MaintenanceTerminalCommandRun extends TerminalCommandRunFields {
    scope: "maintenance";
    projectId?: never;
    workspaceId?: never;
}
export type AnyTerminalCommandRun = TerminalCommandRun | MaintenanceTerminalCommandRun;
export interface TerminalCommandRunHandle<Run extends AnyTerminalCommandRun = TerminalCommandRun> {
    run: Run;
    completed: Promise<Run>;
}
export type PiWebServiceComponent = "web" | "sessiond";
export type PiWebStatusSeverity = "info" | "warning" | "error";
export type PiWebInstallationKind = "pi-package" | "npm-global" | "local" | "docker" | "unknown";
export type PiWebDockerMode = "runtime" | "dev";
export interface PiWebInstallationInfo {
    kind: PiWebInstallationKind;
    path?: string;
    source?: string;
    scope?: "user" | "project";
    npmRoot?: string;
    dockerMode?: PiWebDockerMode;
}
export interface PiWebRuntimeIdentity {
    name: "node" | "bun";
    version: string;
}
export interface PiWebComponentStatus {
    /** Actual JavaScript engine of the reporting process, absent on older peers. */
    runtime?: PiWebRuntimeIdentity;
    component: PiWebServiceComponent;
    label: string;
    runtimeVersion?: string;
    installedVersion?: string;
    /** Version of the Pi coding agent library loaded by this component's process; omitted when the component does not report it. */
    piVersion?: string;
    stale: boolean;
    available: boolean;
    installation?: PiWebInstallationInfo;
    error?: string;
}
export interface PiWebReleaseStatus {
    packageName: string;
    latestVersion?: string;
    updateAvailable: boolean;
    checkedAt?: string;
    skipped?: boolean;
    error?: string;
}
export interface PiWebStatusMessage {
    id: string;
    severity: PiWebStatusSeverity;
    title: string;
    body: string;
    command?: string;
}
export interface PiWebVersionResponse {
    packageName: string;
    generatedAt: string;
    components: {
        web: PiWebComponentStatus;
        sessiond: PiWebComponentStatus;
    };
}
export interface PiWebStatusResponse extends PiWebVersionResponse {
    release: PiWebReleaseStatus;
    commands: {
        update?: string;
        restart?: string;
        restartWeb?: string;
        restartSessiond?: string;
        status?: string;
    };
    messages: PiWebStatusMessage[];
}
export {};
