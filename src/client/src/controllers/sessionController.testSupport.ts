import { afterEach, beforeEach, vi } from "vitest";
import type { MessagePage, SessionInfo, SessionRef, SessionStatus, Workspace } from "../api";
import { machineSessionKey } from "../machineKeys";
import type { SessionUiEvent } from "../sessionSocket";
import type { SessionEventSocket } from "./sessionController";

export { api as defaultApi } from "../api";
export type { MessagePage, PromptAttachment, SessionActivity, SessionInfo, SessionRef, SessionStatus, SessionStreamSnapshot, Workspace } from "../api";
export type { AppState } from "../appState";

export class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

export class FakeSocket implements SessionEventSocket {
  readonly connectedSessionIds: string[] = [];

  connect(session: SessionRef): void {
    this.connectedSessionIds.push(session.id);
  }

  setHandler(): void {
    // Test socket does not emit events.
  }

  close(): void {
    // No-op.
  }
}

export class EmitSocket implements SessionEventSocket {
  readonly connectedSessionIds: string[] = [];
  private handler: ((event: SessionUiEvent) => void) | undefined;
  private onInitialOpen: (() => void) | undefined;

  connect(
    session: SessionRef,
    onEvent: (event: SessionUiEvent) => void,
    _onReconnect?: () => void,
    _machineId?: string,
    onInitialOpen?: () => void,
  ): void {
    this.connectedSessionIds.push(session.id);
    this.handler = onEvent;
    this.onInitialOpen = onInitialOpen;
  }

  setHandler(onEvent: (event: SessionUiEvent) => void): void {
    this.handler = onEvent;
  }

  emit(event: SessionUiEvent): void {
    this.handler?.(event);
  }

  open(): void {
    this.onInitialOpen?.();
  }

  close(): void {
    this.handler = undefined;
    this.onInitialOpen = undefined;
  }
}

export const workspace: Workspace = {
  id: "workspace-1",
  projectId: "project-1",
  path: "/repo",
  label: "repo",
  isMain: true,
  isGitRepo: true,
  isGitWorktree: false,
};

export const oldSession: SessionInfo = {
  id: "old-session",
  path: "/tmp/old-session.jsonl",
  cwd: "/repo",
  created: "2026-05-15T00:00:00.000Z",
  modified: "2026-05-15T00:00:00.000Z",
  messageCount: 0,
  firstMessage: "",
};

export const replacementSession: SessionInfo = {
  ...oldSession,
  id: "new-session",
  path: "/tmp/new-session.jsonl",
};

export const emptyPage: MessagePage = { messages: [], start: 0, total: 0 };

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolveDeferred: ((value: T) => void) | undefined;
  let rejectDeferred: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolveDeferred = resolve;
    rejectDeferred = reject;
  });
  if (resolveDeferred === undefined || rejectDeferred === undefined) throw new Error("Deferred promise was not initialized");
  return { promise, resolve: resolveDeferred, reject: rejectDeferred };
}

export function status(sessionId: string): SessionStatus {
  return {
    sessionId,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    pendingMessageCount: 0,
    queuedMessages: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
  };
}

const framesById = new Map<number, () => void>();
let nextFrameId = 1;

// The controller coalesces status/activity/transcript updates behind
// requestAnimationFrame. The node test environment has no rAF, so install a
// controllable one: callbacks are queued and only run when a test drives a
// frame, mirroring how the browser defers them until paint.
beforeEach(() => {
  framesById.clear();
  nextFrameId = 1;
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
    const id = nextFrameId++;
    framesById.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { framesById.delete(id); });
});

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(globalThis, "localStorage", { value: undefined, configurable: true });
});

export function runPendingAnimationFrames(): void {
  const frames = Array.from(framesById.values());
  framesById.clear();
  for (const frame of frames) frame();
}

export function sessionKey(sessionId: string): string {
  return machineSessionKey("local", sessionId);
}

export function sessionLookupId(session: string | SessionRef): string {
  return typeof session === "string" ? session : session.id;
}
