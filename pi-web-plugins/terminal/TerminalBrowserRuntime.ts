import { terminalBindings, type TerminalContext } from "./TerminalContext";
import type { AnyTerminalCommandRun } from "@jmfederico/pi-web/plugin-api";
import { SessionStorageTerminalSelectionMemory, type TerminalSelectionMemory } from "./terminalSelection";
import { TerminalSelectionController, terminalContextScope, selectionMemoryScope } from "./TerminalSelectionController";
import { TerminalPeerClient, type TerminalInfo } from "./terminalProtocol";

const ACTIVE_TERMINAL_REFRESH_MS = 1_000;
const ACTIVE_TERMINAL_FAILURE_RETRY_MS = 5_000;
type TimerId = ReturnType<typeof globalThis.setTimeout>;
type SetTimer = (handler: () => void, timeout: number) => TimerId;
type ClearTimer = (timer: TimerId) => void;

interface WorkspaceRuntimeState {
  activeCount?: number;
  refreshFailed: boolean;
  refreshedAt: number;
  retryAt: number;
  refresh: Promise<void> | undefined;
  refreshController: AbortController | undefined;
  wakeAt: number;
  wakeTimer: TimerId | undefined;
  requestRender: () => void;
}

/** Browser-product state shared by this activation's panel, badge, and facade. */
export class TerminalBrowserRuntime {
  private readonly workspaces = new Map<string, WorkspaceRuntimeState>();
  private disposed = false;
  readonly selectionController: TerminalSelectionController;
  private badgeTarget: { state: WorkspaceRuntimeState; context: TerminalContext; url: string | undefined } | undefined;

  constructor(
    readonly selection: TerminalSelectionMemory = new SessionStorageTerminalSelectionMemory(),
    private readonly now: () => number = () => Date.now(),
    private readonly setTimer: SetTimer = (handler, timeout) => globalThis.setTimeout(handler, timeout),
    private readonly clearTimer: ClearTimer = (timer) => { globalThis.clearTimeout(timer); },
  ) { this.selectionController = new TerminalSelectionController(selection); }

  activeTerminalBadge(context: TerminalContext): number | string | undefined {
    if (this.disposed) return undefined;
    const state = this.workspaceState(context);
    if (this.badgeTarget?.state !== state) this.resetBadgePolling();
    this.badgeTarget = { state, context, url: browserUrl() };
    const now = this.now();
    if (typeof document !== "undefined" && document.hidden) {
      this.scheduleBadgeWake(state, now + ACTIVE_TERMINAL_REFRESH_MS);
    } else if (now >= state.retryAt && now - state.refreshedAt >= ACTIVE_TERMINAL_REFRESH_MS) {
      void this.refresh(context).catch(() => undefined);
    } else {
      this.scheduleBadgeWake(state, Math.max(state.retryAt, state.refreshedAt + ACTIVE_TERMINAL_REFRESH_MS));
    }
    if (state.refreshFailed) return "!";
    return state.activeCount === undefined || state.activeCount === 0 ? undefined : state.activeCount;
  }

  async invalidate(context: TerminalContext): Promise<void> {
    this.requireActive();
    const state = this.workspaceState(context);
    state.refreshedAt = 0;
    try {
      await this.refresh(context);
    } finally {
      // Route-only history restoration does not otherwise mutate app state.
      // Always render so a mounted panel observes the restored query even when
      // the active-terminal badge count stayed the same.
      if (!this.disposed) context.host.requestRender();
    }
  }

  async refresh(context: TerminalContext): Promise<void> {
    this.requireActive();
    const state = this.workspaceState(context);
    if (state.refresh !== undefined) return state.refresh;
    const controller = new AbortController();
    const refresh = this.listTerminals(context, controller.signal).then((terminals) => {
      this.updateTerminals(context, terminals);
    }).catch((error: unknown) => {
      if (this.disposed || controller.signal.aborted) throw error;
      const changed = !state.refreshFailed;
      state.refreshFailed = true;
      state.retryAt = this.now() + ACTIVE_TERMINAL_FAILURE_RETRY_MS;
      this.scheduleBadgeWake(state, state.retryAt);
      if (changed) state.requestRender();
      throw error;
    }).finally(() => {
      if (state.refresh === refresh) {
        state.refresh = undefined;
        state.refreshController = undefined;
      }
    });
    state.refresh = refresh;
    state.refreshController = controller;
    return refresh;
  }

  async listTerminals(context: TerminalContext, signal?: AbortSignal): Promise<TerminalInfo[]> {
    const bindings = terminalBindings(context);
    if (bindings.length === 0) throw new Error("Required Terminal peer is unavailable");
    return (await Promise.all(bindings.map((binding) => new TerminalPeerClient(binding).list(signal)))).flat();
  }

  async listCommandRuns(context: TerminalContext, signal?: AbortSignal): Promise<AnyTerminalCommandRun[]> {
    return (await Promise.all(terminalBindings(context).map((binding) => new TerminalPeerClient(binding).listCommandRuns({}, signal)))).flat();
  }

  updateTerminals(context: TerminalContext, terminals: readonly TerminalInfo[]): void {
    if (this.disposed) return;
    const state = this.workspaceState(context);
    const activeCount = terminals.reduce((count, terminal) => count + (terminal.exited ? 0 : 1), 0);
    const changed = state.activeCount !== activeCount || state.refreshFailed;
    state.activeCount = activeCount;
    state.refreshFailed = false;
    state.refreshedAt = this.now();
    state.retryAt = 0;
    this.scheduleBadgeWake(state, state.refreshedAt + ACTIVE_TERMINAL_REFRESH_MS);
    if (changed) state.requestRender();
  }

  workspaceScope(context: TerminalContext): string { return terminalContextScope(context); }
  selectionScope(context: TerminalContext): string { return selectionMemoryScope(context); }
  routedTerminalId(context: TerminalContext): string | undefined { return this.selectionController.routed(context); }
  requestMaintenanceTerminal(machineId: string, terminalId: string): void {
    this.requireActive();
    this.selectionController.requestMaintenanceTerminal(machineId, terminalId);
  }
  selectedTerminalId(context: TerminalContext): string | undefined { return this.selectionController.requested(context); }
  autoStartRequest(context: TerminalContext): string | undefined { return this.selectionController.autoStartRequest(context); }
  selectTerminal(context: TerminalContext, terminalId: string | undefined, options?: { replace?: boolean | undefined; scope?: "maintenance" | "workspace" | undefined }): boolean {
    return this.selectionController.select(context, terminalId, options);
  }
  forgetTerminal(terminalId: string): void {
    if (!this.disposed) this.selectionController.forgetTerminal(terminalId);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.resetBadgePolling();
    for (const state of this.workspaces.values()) {
      state.refreshController?.abort(new DOMException("Terminal browser runtime disposed", "AbortError"));
      state.refreshController = undefined;
    }
    this.workspaces.clear();
    this.selectionController.dispose();
  }

  // Changing the badge target stops polling, not the activation's lifetime.
  private resetBadgePolling(): void {
    this.badgeTarget = undefined;
    for (const state of this.workspaces.values()) {
      if (state.wakeTimer !== undefined) this.clearTimer(state.wakeTimer);
      state.wakeTimer = undefined;
      state.wakeAt = 0;
    }
  }

  private requireActive(): void {
    if (this.disposed) throw new DOMException("Terminal browser runtime disposed", "AbortError");
  }

  private workspaceState(context: TerminalContext): WorkspaceRuntimeState {
    const key = this.workspaceScope(context);
    const existing = this.workspaces.get(key);
    if (existing !== undefined) {
      existing.requestRender = () => { context.host.requestRender(); };
      return existing;
    }
    const state: WorkspaceRuntimeState = {
      refreshFailed: false,
      refreshedAt: 0,
      retryAt: 0,
      refresh: undefined,
      refreshController: undefined,
      wakeAt: 0,
      wakeTimer: undefined,
      requestRender: () => { context.host.requestRender(); },
    };
    this.workspaces.set(key, state);
    return state;
  }

  private scheduleBadgeWake(state: WorkspaceRuntimeState, wakeAt: number): void {
    if (this.badgeTarget?.state !== state || !Number.isFinite(wakeAt)) return;
    if (state.wakeTimer !== undefined && state.wakeAt === wakeAt) return;
    if (state.wakeTimer !== undefined) this.clearTimer(state.wakeTimer);
    state.wakeAt = wakeAt;
    state.wakeTimer = this.setTimer(() => {
      state.wakeTimer = undefined;
      state.wakeAt = 0;
      const target = this.badgeTarget;
      if (target?.state !== state) return;
      // Host contexts contain state snapshots, and activations can outlive a
      // machine/workspace switch. Only a fresh badge read renews the URL scope.
      if (target.url !== browserUrl()) {
        this.resetBadgePolling();
        return;
      }
      if (typeof document !== "undefined" && document.hidden) {
        this.scheduleBadgeWake(state, this.now() + ACTIVE_TERMINAL_REFRESH_MS);
        return;
      }
      const nextRefreshAt = Math.max(state.retryAt, state.refreshedAt + ACTIVE_TERMINAL_REFRESH_MS);
      if (this.now() < nextRefreshAt) {
        this.scheduleBadgeWake(state, nextRefreshAt);
        return;
      }
      void this.refresh(target.context).catch(() => undefined);
    }, Math.max(0, wakeAt - this.now()));
  }
}

function browserUrl(): string | undefined {
  return typeof window === "undefined" ? undefined : window.location.href;
}
