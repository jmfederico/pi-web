import type { PluginCapability } from "./pluginApiTypes.js";
import type { PluginCatalogReadOptions, PluginSessionSelection, PluginSessionSnapshot } from "./pluginCatalogTypes.js";
export interface PluginSessionActivityExecution {
    readonly id: string;
    readonly kind: "subsession";
    readonly parentSessionId: string;
    readonly sessionId: string;
    readonly status: "working" | "idle" | "failed" | "unknown";
    readonly canStop: boolean;
    readonly canOpenSession: true;
}
export interface PluginSessionActivityV1Snapshot {
    readonly session: PluginSessionSnapshot;
    readonly lifecycle: "starting" | "active" | "archived";
    readonly runtimeLoaded: boolean;
    readonly activity: "working" | "waiting" | "idle" | "unknown";
    readonly status: {
        readonly persisted: boolean | null;
        readonly isStreaming: boolean | null;
        readonly isCompacting: boolean | null;
        readonly isBashRunning: boolean | null;
        readonly pendingMessageCount: number | null;
        readonly messageCount: number | null;
        readonly queueState: {
            readonly available: boolean;
            readonly reason?: "runtime_not_loaded";
            readonly steeringCount?: number;
            readonly followUpCount?: number;
            readonly compactionFollowUpCount?: number;
        };
        readonly telemetry: {
            readonly available: boolean;
            readonly reason?: "runtime_not_loaded";
            readonly tokens?: {
                readonly input: number;
                readonly output: number;
                readonly cacheRead: number;
                readonly cacheWrite: number;
                readonly total: number;
            };
            readonly cost?: number;
            readonly contextUsage?: {
                readonly tokens: number | null;
                readonly contextWindow: number;
                readonly percent: number | null;
            };
        };
    };
    readonly relatedExecutions: {
        readonly supportedKinds: readonly ["subsession"];
        readonly unsupportedKinds: readonly ["background-agent", "terminal", "process"];
        readonly truncated: boolean;
        readonly executions: readonly PluginSessionActivityExecution[];
        readonly workingCount: number;
        readonly totalCount: number;
    };
}
export interface PluginSessionActivityV1 {
    readonly version: 1;
    readonly inspect: (selection: PluginSessionSelection, options?: PluginCatalogReadOptions) => Promise<PluginSessionActivityV1Snapshot>;
}
export declare const PI_WEB_HOST_PI_SESSION_ACTIVITY_CAPABILITY: PluginCapability<PluginSessionActivityV1, 1>;
