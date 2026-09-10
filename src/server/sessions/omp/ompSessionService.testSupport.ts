import type { GlobalSessionEvent, SessionInfo, SessionRef, SessionUiEvent } from "../../../shared/apiTypes.js";
import { SessionEventHub } from "../../realtime/sessionEventHub.js";

/**
 * Purpose-built capturing hub for OMP tests. Deliberately NOT the
 * `CapturingSessionEventHub` from `../piSessionService.testSupport.js`: that
 * file pulls in the full Pi SDK (`@earendil-works/pi-coding-agent`,
 * `@earendil-works/pi-ai`) for unrelated Pi fixtures, and OMP-only tests must
 * not gain a dependency on the Pi SDK merely to capture published events.
 *
 * Mirrors the real `SessionEventHub.publish` per-session seq watermark so
 * `streamSnapshot` tests can assert `seq` without a separate manual seam.
 */
export class CapturingSessionEventHub extends SessionEventHub {
  readonly sessionEvents: { sessionId: string; event: SessionUiEvent }[] = [];
  readonly globalEvents: GlobalSessionEvent[] = [];
  // Named distinctly from the base class's own private `seqBySession`:
  // TypeScript treats two classes each declaring a private field of the
  // same name as incompatible declarations (TS2415/TS4114), even though
  // private members are not otherwise inherited/visible across the boundary.
  private readonly capturedSeqBySession = new Map<string, number>();

  override publish(sessionId: string, event: SessionUiEvent): void {
    const seq = (this.capturedSeqBySession.get(sessionId) ?? 0) + 1;
    this.capturedSeqBySession.set(sessionId, seq);
    this.sessionEvents.push({ sessionId, event: { ...event, seq } });
  }

  override publishGlobal(event: GlobalSessionEvent): void {
    this.globalEvents.push(event);
  }

  override currentSeq(sessionId: string): number {
    return this.capturedSeqBySession.get(sessionId) ?? 0;
  }

  /** Published session-scoped events for one session id, in publish order. */
  eventsFor(sessionId: string): SessionUiEvent[] {
    return this.sessionEvents.filter((entry) => entry.sessionId === sessionId).map((entry) => entry.event);
  }
}

/** One inbound OMP RPC command/frame, as sent through `request()` or `send()`. */
export interface OmpRpcFrame {
  id?: string;
  type: string;
  [key: string]: unknown;
}

/**
 * Structural mirror of the real `OmpRpcClient` (owned by `ompRpcClient.ts`,
 * per the cross-slice brief item 2). Defined locally rather than imported so
 * this test file's red run does not depend on that sibling file existing yet
 * — both are tests-only deliverables in this wave. The production
 * `ompSessionService.ts` should depend on the real exported class instead.
 */
export interface OmpRpcClientLike {
  start(): Promise<void>;
  request<T = unknown>(command: OmpRpcFrame): Promise<T>;
  send(frame: OmpRpcFrame): void;
  close(): Promise<void>;
  readonly alive: boolean;
}

export interface OmpRpcClientOptions {
  cwd: string;
  agentDir: string;
  command?: string;
  sessionFile?: string;
  env?: NodeJS.ProcessEnv;
  onEvent?: (frame: Record<string, unknown>) => void;
}

export type OmpRpcHandler = (command: OmpRpcFrame) => unknown;

/** Error shape `OmpRpcClient.request()` is confirmed (OmpTransportStore, 2026-09-10) to reject with on a `success:false` response. */
export class FakeOmpRpcCommandError extends Error {
  constructor(
    message: string,
    readonly command: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "FakeOmpRpcCommandError";
  }
}

/**
 * Fake transport boundary standing in for the real `OmpRpcClient`. Scripted
 * per command `type` via {@link on}; unhandled event frames are delivered
 * through {@link emit} exactly as the real `onEvent` callback would receive
 * them (agent lifecycle, message deltas, tool events, extension UI requests).
 */
export class FakeOmpRpcClient implements OmpRpcClientLike {
  readonly sent: OmpRpcFrame[] = [];
  readonly requested: OmpRpcFrame[] = [];
  private readonly handlers = new Map<string, OmpRpcHandler>();
  private startError: Error | undefined;
  private startedFlag = false;
  private closedFlag = false;

  constructor(readonly options: OmpRpcClientOptions) {}

  get alive(): boolean {
    return this.startedFlag && !this.closedFlag;
  }

  get closed(): boolean {
    return this.closedFlag;
  }

  get started(): boolean {
    return this.startedFlag;
  }

  /** Register a fake response (or thrown error) for one RPC command type. */
  on(type: string, handler: OmpRpcHandler): this {
    this.handlers.set(type, handler);
    return this;
  }

  /** Register a fixed success `data` payload for one RPC command type. */
  onSuccess(type: string, data: unknown): this {
    return this.on(type, () => data);
  }

  /** Register a `success:false`-style rejection for one RPC command type. */
  onFailure(type: string, message: string, code?: string): this {
    return this.on(type, () => {
      throw new FakeOmpRpcCommandError(message, type, code);
    });
  }

  /** Make `start()` reject, simulating a spawn/readiness failure. */
  failStart(error: Error): void {
    this.startError = error;
  }

  start(): Promise<void> {
    if (this.startError !== undefined) return Promise.reject(this.startError);
    this.startedFlag = true;
    return Promise.resolve();
  }

  async request<T = unknown>(command: OmpRpcFrame): Promise<T> {
    this.requested.push(command);
    const handler = this.handlers.get(command.type);
    if (handler === undefined) {
      throw new Error(`FakeOmpRpcClient: no fake handler registered for OMP RPC command "${command.type}"`);
    }
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- generic RPC response boundary: the fake handler's return has no runtime schema tying it to the caller's requested `T`, same as the real transport's `request<T>()`.
    return (await handler(command)) as T;
  }

  send(frame: OmpRpcFrame): void {
    this.sent.push(frame);
  }

  close(): Promise<void> {
    this.closedFlag = true;
    this.startedFlag = false;
    return Promise.resolve();
  }

  /** Deliver an unsolicited event frame (agent_start, message_update, extension_ui_request, ...). */
  emit(frame: Record<string, unknown>): void {
    this.options.onEvent?.(frame);
  }
}

export interface FakeOmpRpcClientFactory {
  (options: OmpRpcClientOptions): OmpRpcClientLike;
  readonly clients: readonly FakeOmpRpcClient[];
}

/**
 * Build an injectable `createRpcClient` factory. `configure` runs against
 * every spawned fake before it is handed back, so tests can pre-register
 * command handlers (e.g. `get_state`) that every spawned session needs.
 */
export function fakeRpcClientFactory(configure?: (client: FakeOmpRpcClient) => void): FakeOmpRpcClientFactory {
  const clients: FakeOmpRpcClient[] = [];
  function factory(options: OmpRpcClientOptions): OmpRpcClientLike {
    const client = new FakeOmpRpcClient(options);
    configure?.(client);
    clients.push(client);
    return client;
  }
  factory.clients = clients;
  Object.defineProperty(factory, "clients", { value: clients });
  return factory;
}

/**
 * Structural mirror of the real, read-only `OmpSessionStore` (owned by
 * `ompSessionStore.ts`, brief item 3). Defined locally for the same
 * red-run-independence reason as {@link OmpRpcClientLike}.
 */
export interface OmpSessionStoreLike {
  list(cwd: string): Promise<SessionInfo[]>;
  /** Every known OMP session across every cwd, for cleanup when projectCwds is omitted. */
  listAll(): Promise<SessionInfo[]>;
  resolve(ref: SessionRef): Promise<{ path: string; nativeId: string }>;
  messages(ref: SessionRef): Promise<unknown[]>;
}

interface FakeOmpSessionRecord {
  nativeId: string;
  cwd: string;
  path: string;
  info: SessionInfo;
  messages?: unknown[];
}

/** Fake standing in for the real `OmpSessionStore`'s read-only session-tree scan. */
export class FakeOmpSessionStore implements OmpSessionStoreLike {
  private readonly byId = new Map<string, FakeOmpSessionRecord>();

  seed(record: FakeOmpSessionRecord): this {
    this.byId.set(ompSessionId(record.nativeId), record);
    return this;
  }

  list(cwd: string): Promise<SessionInfo[]> {
    return Promise.resolve([...this.byId.values()].filter((record) => record.cwd === cwd).map((record) => record.info));
  }

  listAll(): Promise<SessionInfo[]> {
    return Promise.resolve([...this.byId.values()].map((record) => record.info));
  }

  resolve(ref: SessionRef): Promise<{ path: string; nativeId: string }> {
    try {
      const record = this.find(ref);
      return Promise.resolve({ path: record.path, nativeId: record.nativeId });
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  messages(ref: SessionRef): Promise<unknown[]> {
    try {
      return Promise.resolve(this.find(ref).messages ?? []);
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private find(ref: SessionRef): FakeOmpSessionRecord {
    const record = this.byId.get(ref.id);
    if (record === undefined) throw new Error(`No OMP session found for id ${ref.id}`);
    if (record.cwd !== ref.cwd) throw new Error(`OMP session ${ref.id} belongs to workspace ${record.cwd}, not ${ref.cwd}`);
    return record;
  }
}

/** The `omp:<native-uuid>` id convention the OMP service/store own (contract item 1). */
export function ompSessionId(nativeId: string): string {
  return `omp:${nativeId}`;
}

export const TEST_AGENT_DIR = "/tmp/pi-web-omp-test-agent";
export const TEST_NATIVE_ID_A = "a1a1a1a1-0000-4000-8000-000000000001";
export const TEST_NATIVE_ID_B = "b2b2b2b2-0000-4000-8000-000000000002";

export function ompRef(nativeId: string, cwd = "/workspace"): SessionRef {
  return { id: ompSessionId(nativeId), cwd };
}

export function sessionInfo(nativeId: string, cwd = "/workspace", patch: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: ompSessionId(nativeId),
    cwd,
    path: `${cwd}/.omp/sessions/${nativeId}.jsonl`,
    persisted: true,
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:01:00.000Z",
    messageCount: 0,
    firstMessage: "",
    ...patch,
  };
}

/**
 * `SessionStatus.capabilities` shape confirmed with the Selection/UI slice
 * owner (BackendSelectionUi, 2026-09-10): every flag absent means fully
 * capable, so Pi sessions (which never set this field) need no changes.
 * Duplicated locally rather than imported from `apiTypes.ts` because that
 * type lands as part of the UI slice's own tests-only pass in this same
 * wave; production `ompSessionService.ts` should import the real type once
 * both land.
 */
export interface SessionCapabilities {
  askUser?: boolean;
  queueClear?: boolean;
  warnings?: boolean;
  modelScope?: boolean;
  treeNavigate?: boolean;
  treeFork?: boolean;
  interactiveCommands?: boolean;
  detachParent?: boolean;
  shellStreaming?: boolean;
  cycleModelBackward?: boolean;
}

/** Operations without an equivalent command in OMP's rpc-ui protocol. */
export const OMP_CAPABILITIES: Required<SessionCapabilities> = {
  askUser: false,
  queueClear: false,
  warnings: false,
  modelScope: false,
  treeNavigate: false,
  treeFork: false,
  interactiveCommands: false,
  detachParent: false,
  shellStreaming: false,
  cycleModelBackward: false,
};

/**
 * Native OMP `new_session` success payload: `data: {cancelled: boolean}`.
 * A fresh session MUST check
 * this before trusting the follow-up identity call — accepting a cancelled
 * `new_session` as fresh would silently attach to whatever session the
 * process auto-loaded instead.
 */
export const NEW_SESSION_ACCEPTED = { cancelled: false };
export const NEW_SESSION_CANCELLED = { cancelled: true };

/**
 * Native `get_session_stats` success payload, patchable per test.
 * This (not `get_state`) reports the definitive native
 * `sessionId`/`sessionFile` right after `new_session` succeeds and after
 * resuming a persisted session; `get_state` is used separately for live
 * status once a session is already known.
 */
export function sessionStatsPayload(nativeId: string, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: nativeId,
    sessionFile: `/workspace/.omp/sessions/${nativeId}.jsonl`,
    totalMessages: 0,
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    ...patch,
  };
}

/** A `get_state` success payload with sensible defaults, patchable per test. */
export function getStatePayload(nativeId: string, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: { provider: "anthropic", id: "claude-sonnet-4-5" },
    thinkingLevel: "medium",
    isStreaming: false,
    isCompacting: false,
    steeringMode: "one-at-a-time",
    followUpMode: "one-at-a-time",
    interruptMode: "immediate",
    sessionId: nativeId,
    sessionFile: `/workspace/.omp/sessions/${nativeId}.jsonl`,
    sessionName: undefined,
    fastModeEnabled: false,
    tokensPerSecond: null,
    fastModeActive: false,
    autoCompactionEnabled: true,
    messageCount: 0,
    queuedMessageCount: 0,
    ...patch,
  };
}
