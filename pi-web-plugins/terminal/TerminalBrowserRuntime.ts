import type { WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import { SessionStorageTerminalSelectionMemory, terminalSelectionScope, type TerminalSelectionMemory } from "./terminalSelection";
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
  private badgeTarget: { state: WorkspaceRuntimeState; context: WorkspacePanelContext; url: string | undefined } | undefined;

  constructor(
    readonly selection: TerminalSelectionMemory = new SessionStorageTerminalSelectionMemory(),
    private readonly now: () => number = () => Date.now(),
    private readonly setTimer: SetTimer = (handler, timeout) => globalThis.setTimeout(handler, timeout),
    private readonly clearTimer: ClearTimer = (timer) => { globalThis.clearTimeout(timer); },
  ) {}

  activeTerminalBadge(context: WorkspacePanelContext): number | string | undefined {
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

  async invalidate(context: WorkspacePanelContext): Promise<void> {
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

  async refresh(context: WorkspacePanelContext): Promise<void> {
    this.requireActive();
    const peer = context.peer;
    if (peer === undefined) throw new Error("Required Terminal peer is unavailable");
    const state = this.workspaceState(context);
    if (state.refresh !== undefined) return state.refresh;
    const controller = new AbortController();
    const refresh = new TerminalPeerClient(peer).list(controller.signal).then((terminals) => {
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

  updateTerminals(context: WorkspacePanelContext, terminals: readonly TerminalInfo[]): void {
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

  workspaceScope(context: WorkspacePanelContext): string {
    return JSON.stringify([context.machine.id, context.workspace.projectId, context.workspace.id, context.workspace.path]);
  }

  selectionScope(context: WorkspacePanelContext): string {
    // Preserve the legacy persisted-selection key while keeping live browser
    // state and channel ownership scoped by authoritative workspace identity.
    return terminalSelectionScope(context.machine.id, context.workspace.path);
  }

  routedTerminalId(context: WorkspacePanelContext): string | undefined {
    return navigationValue(context, "terminal");
  }

  selectedTerminalId(context: WorkspacePanelContext): string | undefined {
    return this.routedTerminalId(context) ?? this.selection.latestTerminalId(this.selectionScope(context));
  }

  autoStartRequest(context: WorkspacePanelContext): string | undefined {
    return navigationValue(context, "start");
  }

  selectTerminal(context: WorkspacePanelContext, terminalId: string | undefined, options?: { replace?: boolean | undefined }): boolean {
    // WorkspacePanelNavigationV1 is void-returning for portable plugins. The
    // PI WEB host returns false internally when a retained context is stale;
    // legacy/third-party undefined results remain accepted.
    const navigationResult: unknown = context.navigation?.set("terminal", terminalId, options);
    if (navigationResult === false) return false;
    const scope = this.selectionScope(context);
    if (terminalId === undefined) this.selection.forgetWorkspace(scope);
    else this.selection.rememberTerminal(scope, terminalId);
    context.host.requestRender();
    return true;
  }

  forgetTerminal(terminalId: string): void {
    if (!this.disposed) this.selection.forgetTerminal(terminalId);
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

  private workspaceState(context: WorkspacePanelContext): WorkspaceRuntimeState {
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

function navigationValue(context: WorkspacePanelContext, key: string): string | undefined {
  const value = context.navigation?.query[key];
  const first = typeof value === "string" ? value : value?.[0];
  return first === undefined || first === "" ? undefined : first;
}
