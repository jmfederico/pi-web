export type MachineKind = "local" | "remote";
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject {
    readonly [key: string]: JsonValue;
}
export interface WorkspaceProviderCapabilities {
    readonly request: boolean;
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
export interface TerminalCommandRun {
    id: string;
    origin: string;
    projectId: string;
    workspaceId: string;
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
export interface TerminalCommandRunHandle {
    run: TerminalCommandRun;
    completed: Promise<TerminalCommandRun>;
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
export interface PiWebComponentStatus {
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
