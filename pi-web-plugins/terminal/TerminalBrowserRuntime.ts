import type { WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import { SessionStorageTerminalSelectionMemory, terminalSelectionScope, type TerminalSelectionMemory } from "./terminalSelection";
import { TerminalBackendClient, type TerminalInfo } from "./terminalProtocol";

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
  wakeAt: number;
  wakeTimer: TimerId | undefined;
  requestRender: () => void;
}

/** Browser-product state shared by this activation's panel, badge, and facade. */
export class TerminalBrowserRuntime {
  private readonly workspaces = new Map<string, WorkspaceRuntimeState>();

  constructor(
    readonly selection: TerminalSelectionMemory = new SessionStorageTerminalSelectionMemory(),
    private readonly now: () => number = () => Date.now(),
    private readonly setTimer: SetTimer = (handler, timeout) => globalThis.setTimeout(handler, timeout),
    private readonly clearTimer: ClearTimer = (timer) => { globalThis.clearTimeout(timer); },
  ) {}

  activeTerminalBadge(context: WorkspacePanelContext): number | string | undefined {
    const state = this.workspaceState(context);
    const now = this.now();
    if (now >= state.retryAt && now - state.refreshedAt >= ACTIVE_TERMINAL_REFRESH_MS) {
      void this.refresh(context).catch(() => undefined);
    } else {
      this.scheduleBadgeWake(state, Math.max(state.retryAt, state.refreshedAt + ACTIVE_TERMINAL_REFRESH_MS));
    }
    if (state.refreshFailed) return "!";
    return state.activeCount === undefined || state.activeCount === 0 ? undefined : state.activeCount;
  }

  async invalidate(context: WorkspacePanelContext): Promise<void> {
    const state = this.workspaceState(context);
    state.refreshedAt = 0;
    try {
      await this.refresh(context);
    } finally {
      // Route-only history restoration does not otherwise mutate app state.
      // Always render so a mounted panel observes the restored query even when
      // the active-terminal badge count stayed the same.
      context.host.requestRender();
    }
  }

  async refresh(context: WorkspacePanelContext): Promise<void> {
    const backend = context.backend;
    if (backend === undefined) throw new Error("Required Terminal paired backend is unavailable");
    const state = this.workspaceState(context);
    if (state.refresh !== undefined) return state.refresh;
    const refresh = new TerminalBackendClient(backend).list().then((terminals) => {
      this.updateTerminals(context, terminals);
    }).catch((error: unknown) => {
      state.refreshFailed = true;
      state.retryAt = this.now() + ACTIVE_TERMINAL_FAILURE_RETRY_MS;
      this.scheduleBadgeWake(state, state.retryAt);
      state.requestRender();
      throw error;
    }).finally(() => {
      if (state.refresh === refresh) state.refresh = undefined;
    });
    state.refresh = refresh;
    return refresh;
  }

  updateTerminals(context: WorkspacePanelContext, terminals: readonly TerminalInfo[]): void {
    const state = this.workspaceState(context);
    const activeCount = terminals.reduce((count, terminal) => count + (terminal.exited ? 0 : 1), 0);
    const changed = state.activeCount !== activeCount;
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

  selectTerminal(context: WorkspacePanelContext, terminalId: string | undefined, options?: { replace?: boolean | undefined }): void {
    const scope = this.selectionScope(context);
    if (terminalId === undefined) this.selection.forgetWorkspace(scope);
    else this.selection.rememberTerminal(scope, terminalId);
    context.navigation?.set("terminal", terminalId, options);
    context.host.requestRender();
  }

  forgetTerminal(context: WorkspacePanelContext, terminalId: string): void {
    this.selection.forgetTerminal(terminalId);
    if (this.selectedTerminalId(context) === terminalId) this.selectTerminal(context, undefined, { replace: true });
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
      wakeAt: 0,
      wakeTimer: undefined,
      requestRender: () => { context.host.requestRender(); },
    };
    this.workspaces.set(key, state);
    return state;
  }

  private scheduleBadgeWake(state: WorkspaceRuntimeState, wakeAt: number): void {
    if (!Number.isFinite(wakeAt)) return;
    if (state.wakeTimer !== undefined && state.wakeAt === wakeAt) return;
    if (state.wakeTimer !== undefined) this.clearTimer(state.wakeTimer);
    state.wakeAt = wakeAt;
    state.wakeTimer = this.setTimer(() => {
      state.wakeTimer = undefined;
      state.wakeAt = 0;
      state.requestRender();
    }, Math.max(0, wakeAt - this.now()));
  }
}

function navigationValue(context: WorkspacePanelContext, key: string): string | undefined {
  const value = context.navigation?.query[key];
  const first = typeof value === "string" ? value : value?.[0];
  return first === undefined || first === "" ? undefined : first;
}
