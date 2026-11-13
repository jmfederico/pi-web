import type { JsonValue } from "./pluginApiTypes.js";
/** Private native custom entries, never public session metadata. */
export declare const SESSION_STATE_CUSTOM_TYPE = "pi-web.session-state";
/** Fork boundary: historical entries remain transcript history, not live child state. */
export declare const SESSION_STATE_RESET_CUSTOM_TYPE = "pi-web.session-state-reset";
export declare const SESSION_STATE_MAX_BYTES: number;
export interface SessionStateData {
    readonly version: 1;
    readonly namespace: string;
    readonly value: JsonValue;
    readonly inherit: boolean;
}
export interface SessionStateEntry extends SessionStateData {
    readonly revision: string;
}
export interface SessionStateSnapshot {
    /** Missing when the namespace has never been written since the latest reset. */
    readonly value?: JsonValue;
    /** Native entry id; the empty string means absent. */
    readonly revision: string;
}
export interface SessionStateWrite {
    readonly value: JsonValue;
    readonly inherit: boolean;
    /** Required optimistic revision returned by read; empty string creates an absent namespace. */
    readonly revision: string;
}
export declare function validateSessionStateNamespace(namespace: string): void;
/** Detached bounded JSON envelope. Namespaces organize data, not authorization. */
export declare function createSessionStateData(namespace: string, value: unknown, inherit: boolean): SessionStateData;
/** Ignore unrelated entries; reject malformed recognized state rather than revive older values. */
export declare function parseSessionStateEntry(entry: unknown): SessionStateEntry | undefined;
/** Read entries in native append order (getEntries), not only the current branch. */
export declare function latestSessionStateEntries(entries: readonly unknown[]): SessionStateEntry[];
export declare function readSessionState(entries: readonly unknown[], namespace: string): SessionStateSnapshot;
