import { css, html, LitElement, unsafeCSS } from "lit";
import { property, query, state } from "lit/decorators.js";
import { html as staticHtml, unsafeStatic } from "lit/static-html.js";
import { styleMap, type StyleInfo } from "lit/directives/style-map.js";
import { Terminal, type ITerminalOptions, type ITheme } from "@xterm/xterm";
import { FitAddon, type ITerminalDimensions } from "@xterm/addon-fit";
import xtermStyles from "@xterm/xterm/css/xterm.css?inline";
import type { TerminalCommandRun, WorkspaceBackendChannel, WorkspaceBackendChannelClose, WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import { writeClipboardText } from "./clipboard";
import { selectFallbackTerminal, selectPreferredTerminal } from "./terminalSelection";
import { TerminalBackendClient, terminalChannelFailureMessage, terminalInputFrames, type TerminalClientFrame, type TerminalInfo, type TerminalServerFrame, type TerminalSize } from "./terminalProtocol";
import { createTerminalCopySnapshot, DEFAULT_TERMINAL_ANSI_THEME, type TerminalCopyRunStyle, type TerminalCopySnapshot } from "./terminalCopySnapshot";
import { createTerminalSoftKeysDefaultEnvironmentMedia, hasTerminalSoftKeysPreference, initialTerminalSoftKeysEnabled, isTerminalSoftKeysDefaultEnvironment, writeTerminalSoftKeysPreference } from "./terminalSoftKeysPreference";
import type { TerminalBrowserRuntime } from "./TerminalBrowserRuntime";
import type { TerminalSoftKeyInputOptions } from "./TerminalSoftKeys";

const TERMINAL_OPTIONS_BASE: ITerminalOptions = {
  cursorBlink: true,
  convertEol: true,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  fontSize: 13,
};

const DEFAULT_TERMINAL_SIZE: TerminalSize = { cols: 100, rows: 30 };
const COMMAND_RUN_POLL_INTERVAL_MS = 1000;
const CHANNEL_RECONNECT_DELAYS_MS = [250, 500, 1_000, 2_000, 5_000] as const;
const WORKSPACE_LOAD_RETRY_DELAYS_MS = [1_000, 2_000, 5_000] as const;

interface ScopedPanelOperation {
  readonly context: WorkspacePanelContext;
  readonly runtime: TerminalBrowserRuntime;
  readonly scope: string;
  readonly generation: number;
  readonly controller: AbortController;
}

interface TerminalReplayInputSuppression {
  readonly generation: number;
  readonly terminalId: string;
  readonly terminal: Terminal;
}

export class TerminalPanel extends LitElement {
  @property({ attribute: false }) context: WorkspacePanelContext | undefined;
  @property({ attribute: false }) runtime: TerminalBrowserRuntime | undefined;
  @property({ attribute: false }) softKeysElementName = "pi-web-terminal-soft-keys-terminal";
  @query(".terminal-host") private terminalHost?: HTMLDivElement | null;
  @query(".terminal-copy-content") private terminalCopyContent?: HTMLPreElement | null;
  @query(".terminal-copy-selector") private terminalCopySelector?: HTMLTextAreaElement | null;
  @state() private terminals: TerminalInfo[] = [];
  @state() private commandRuns: TerminalCommandRun[] = [];
  @state() private selectedId: string | undefined;
  @state() private loading = false;
  @state() private error: string | undefined;
  @state() private connectionError: string | undefined;
  @state() private visible = false;
  @state() private cancellingRunIds: string[] = [];
  @state() private continuingTerminalIds: string[] = [];
  @state() private defaultSoftKeysEnvironment = false;
  @state() private softKeysEnabled = initialTerminalSoftKeysEnabled();
  @state() private copySnapshot: TerminalCopySnapshot | undefined;
  @state() private copyStatus: string | undefined;

  private terminal: Terminal | undefined;
  private fitAddon: FitAddon | undefined;
  private channel: WorkspaceBackendChannel | undefined;
  private channelAbort: AbortController | undefined;
  private channelGeneration = 0;
  private channelReconnectAttempt = 0;
  private channelReconnectTimer: number | undefined;
  private loadAbort: AbortController | undefined;
  private loadRetryTimer: number | undefined;
  private loadRetryAttempt = 0;
  private commandRunLoadAbort: AbortController | undefined;
  private readonly operationAborts = new Set<AbortController>();
  private workspaceGeneration = 0;
  private resizeObserver: ResizeObserver | undefined;
  private intersectionObserver: IntersectionObserver | undefined;
  private themeObserver: MutationObserver | undefined;
  private replayInputSuppression: TerminalReplayInputSuppression | undefined;
  private observedRuntime: TerminalBrowserRuntime | undefined;
  private observedWorkspaceScope: string | undefined;
  private loadedWorkspaceScope: string | undefined;
  private consumedAutoStartRequest: string | undefined;
  private requestedAutoStartRequest: string | undefined;
  private routedTerminalId: string | undefined;
  private requestedTerminalId: string | undefined;
  private pendingTerminalNavigation: { context: WorkspacePanelContext; terminalId: string | undefined } | undefined;
  private commandRunPollTimer: number | undefined;
  private readonly softKeysDefaultEnvironmentMedia = createTerminalSoftKeysDefaultEnvironmentMedia();
  private softKeysPreferenceStored = hasTerminalSoftKeysPreference();
  private readonly onSoftKeysDefaultEnvironmentChange = () => {
    this.syncDefaultSoftKeysEnvironment();
  };

  override connectedCallback(): void {
    super.connectedCallback();
    this.syncDefaultSoftKeysEnvironment();
    this.softKeysDefaultEnvironmentMedia?.addEventListener("change", this.onSoftKeysDefaultEnvironmentChange);
    this.themeObserver = new MutationObserver(() => { this.applyTerminalTheme(); });
    this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
  }

  override firstUpdated(): void {
    if (typeof IntersectionObserver === "undefined") {
      this.visible = true;
      return;
    }
    this.intersectionObserver = new IntersectionObserver((entries) => {
      this.visible = entries[0]?.isIntersecting === true;
    });
    this.intersectionObserver.observe(this);
  }

  override disconnectedCallback(): void {
    this.intersectionObserver?.disconnect();
    this.intersectionObserver = undefined;
    this.themeObserver?.disconnect();
    this.themeObserver = undefined;
    this.softKeysDefaultEnvironmentMedia?.removeEventListener("change", this.onSoftKeysDefaultEnvironmentChange);
    this.workspaceGeneration += 1;
    this.cancelWorkspaceRequests();
    this.cancellingRunIds = [];
    this.continuingTerminalIds = [];
    this.updateCommandRunPolling(false);
    this.disposeTerminalView();
    super.disconnectedCallback();
  }

  private syncDefaultSoftKeysEnvironment(): void {
    const nextDefaultEnvironment = isTerminalSoftKeysDefaultEnvironment(this.softKeysDefaultEnvironmentMedia);
    const previousSoftKeysEnabled = this.softKeysEnabled;
    this.defaultSoftKeysEnvironment = nextDefaultEnvironment;
    if (!this.softKeysPreferenceStored) this.softKeysEnabled = nextDefaultEnvironment;
    if (this.softKeysEnabled !== previousSoftKeysEnabled) this.scheduleFitAndNotify();
  }

  private scheduleFitAndNotify(): void {
    void this.updateComplete.then(() => { this.fitAndNotify(); });
  }

  override willUpdate(): void {
    const context = this.context;
    const runtime = this.runtime;
    const workspaceScope = context === undefined || runtime === undefined ? undefined : runtime.workspaceScope(context);
    let routedTerminalId = context === undefined || runtime === undefined ? undefined : runtime.routedTerminalId(context);
    let requestedTerminalId = context === undefined || runtime === undefined ? undefined : runtime.selectedTerminalId(context);
    const requestedAutoStart = context === undefined || runtime === undefined ? undefined : runtime.autoStartRequest(context);
    const pendingTerminalNavigation = this.pendingTerminalNavigation;
    if (context !== undefined && pendingTerminalNavigation?.context === context) {
      routedTerminalId = pendingTerminalNavigation.terminalId;
      requestedTerminalId = pendingTerminalNavigation.terminalId;
    } else if (pendingTerminalNavigation !== undefined) {
      this.pendingTerminalNavigation = undefined;
    }
    if (workspaceScope !== this.observedWorkspaceScope || runtime !== this.observedRuntime) {
      this.workspaceGeneration += 1;
      this.cancelWorkspaceRequests();
      this.observedRuntime = runtime;
      this.observedWorkspaceScope = workspaceScope;
      this.loadedWorkspaceScope = undefined;
      this.consumedAutoStartRequest = undefined;
      this.requestedAutoStartRequest = requestedAutoStart;
      this.routedTerminalId = routedTerminalId;
      this.requestedTerminalId = requestedTerminalId;
      this.pendingTerminalNavigation = undefined;
      this.terminals = [];
      this.commandRuns = [];
      this.selectedId = undefined;
      this.cancellingRunIds = [];
      this.continuingTerminalIds = [];
      this.loading = false;
      this.error = undefined;
      this.connectionError = undefined;
      this.loadRetryAttempt = 0;
      this.updateCommandRunPolling(false);
      this.disposeTerminalView();
      return;
    }
    if (routedTerminalId !== this.routedTerminalId || requestedTerminalId !== this.requestedTerminalId) {
      this.routedTerminalId = routedTerminalId;
      this.requestedTerminalId = requestedTerminalId;
      this.applyRequestedTerminalSelection();
    }
    if (requestedAutoStart !== this.requestedAutoStartRequest) this.requestedAutoStartRequest = requestedAutoStart;
  }

  override updated(): void {
    if (!this.visible) {
      this.updateCommandRunPolling(false);
      this.disposeTerminalView();
      return;
    }
    if (this.hasPendingCommandRuns()) this.updateCommandRunPolling(true);
    this.loadVisibleWorkspaceTerminals();
    if (this.shouldReloadForRequestedTerminal()) void this.loadTerminals();
    this.applyAutoStartRequest();
    this.ensureTerminalView();
  }

  private loadVisibleWorkspaceTerminals(): void {
    const scope = this.observedWorkspaceScope;
    if (!this.visible
      || scope === undefined
      || scope === this.loadedWorkspaceScope
      || this.loading
      || this.loadRetryTimer !== undefined) return;
    void this.loadTerminals();
  }

  private async loadTerminals(): Promise<void> {
    const context = this.context;
    const runtime = this.runtime;
    const scope = this.observedWorkspaceScope;
    const generation = this.workspaceGeneration;
    if (context === undefined || runtime === undefined || scope === undefined || runtime.workspaceScope(context) !== scope) return;
    this.clearWorkspaceLoadRetryTimer();
    this.loadAbort?.abort();
    const controller = new AbortController();
    this.loadAbort = controller;
    this.loading = true;
    this.error = undefined;
    try {
      const client = this.backendClient(context);
      const [terminals, commandRuns] = await Promise.all([
        client.list(controller.signal),
        client.listCommandRuns({}, controller.signal),
      ]);
      if (!this.workspaceIsCurrent(scope, generation, runtime) || controller.signal.aborted) return;
      this.loadedWorkspaceScope = scope;
      this.loadRetryAttempt = 0;
      this.terminals = terminals;
      this.commandRuns = commandRuns;
      runtime.updateTerminals(context, terminals);
      this.selectPreferredLoadedTerminal({ replaceUrl: true });
      this.updateCommandRunPolling(this.hasPendingCommandRuns(commandRuns));
      const shouldAutoStart = this.consumeAutoStart(scope);
      if (terminals.length === 0 && shouldAutoStart) await this.startTerminal();
    } catch (error) {
      if (!controller.signal.aborted && this.workspaceIsCurrent(scope, generation, runtime)) {
        this.loadedWorkspaceScope = undefined;
        this.error = errorMessage(error);
        this.scheduleWorkspaceLoadRetry(scope, generation, runtime);
      }
    } finally {
      if (this.loadAbort === controller) this.loadAbort = undefined;
      if (!controller.signal.aborted && this.workspaceIsCurrent(scope, generation, runtime)) this.loading = false;
    }
  }

  private applyRequestedTerminalSelection(): void {
    if (this.requestedTerminalId !== undefined && !this.terminals.some((terminal) => terminal.id === this.requestedTerminalId)) return;
    this.selectPreferredLoadedTerminal({ replaceUrl: true });
  }

  private applyAutoStartRequest(): void {
    const scope = this.observedWorkspaceScope;
    if (scope === undefined || scope !== this.loadedWorkspaceScope || this.loading) return;
    const shouldAutoStart = this.consumeAutoStart(scope);
    if (shouldAutoStart && this.terminals.length === 0) void this.startTerminal();
  }

  private consumeAutoStart(scope: string): boolean {
    const request = this.requestedAutoStartRequest;
    if (request === undefined) return false;
    const key = JSON.stringify([scope, request]);
    const shouldAutoStart = this.consumedAutoStartRequest !== key;
    this.consumedAutoStartRequest = key;
    this.requestedAutoStartRequest = undefined;
    this.context?.navigation?.set("start", undefined, { replace: true });
    return shouldAutoStart;
  }

  private shouldReloadForRequestedTerminal(): boolean {
    return this.visible
      && this.observedWorkspaceScope !== undefined
      && this.observedWorkspaceScope === this.loadedWorkspaceScope
      && this.requestedTerminalId !== undefined
      && !this.loading
      && this.loadRetryTimer === undefined
      && !this.terminals.some((terminal) => terminal.id === this.requestedTerminalId);
  }

  private scheduleWorkspaceLoadRetry(scope: string, generation: number, runtime: TerminalBrowserRuntime): void {
    if (this.loadRetryTimer !== undefined) return;
    const delay = WORKSPACE_LOAD_RETRY_DELAYS_MS[Math.min(this.loadRetryAttempt, WORKSPACE_LOAD_RETRY_DELAYS_MS.length - 1)] ?? 5_000;
    this.loadRetryAttempt += 1;
    this.loadRetryTimer = window.setTimeout(() => {
      this.loadRetryTimer = undefined;
      if (!this.visible || !this.workspaceIsCurrent(scope, generation, runtime)) return;
      void this.loadTerminals();
    }, delay);
  }

  private clearWorkspaceLoadRetryTimer(): void {
    if (this.loadRetryTimer === undefined) return;
    window.clearTimeout(this.loadRetryTimer);
    this.loadRetryTimer = undefined;
  }

  private cancelWorkspaceRequests(): void {
    this.loadAbort?.abort();
    this.loadAbort = undefined;
    this.loading = false;
    this.clearWorkspaceLoadRetryTimer();
    for (const controller of this.operationAborts) controller.abort();
    this.operationAborts.clear();
    this.commandRunLoadAbort = undefined;
  }

  private workspaceIsCurrent(scope: string, generation: number, runtime: TerminalBrowserRuntime): boolean {
    const context = this.context;
    return generation === this.workspaceGeneration
      && runtime === this.runtime
      && context !== undefined
      && this.observedWorkspaceScope === scope
      && runtime.workspaceScope(context) === scope;
  }

  private beginScopedOperation(): ScopedPanelOperation | undefined {
    const context = this.context;
    const runtime = this.runtime;
    const scope = this.observedWorkspaceScope;
    const generation = this.workspaceGeneration;
    if (context === undefined || runtime === undefined || scope === undefined || !this.workspaceIsCurrent(scope, generation, runtime)) return undefined;
    const controller = new AbortController();
    this.operationAborts.add(controller);
    return { context, runtime, scope, generation, controller };
  }

  private operationIsCurrent(operation: ScopedPanelOperation): boolean {
    return !operation.controller.signal.aborted
      && this.workspaceIsCurrent(operation.scope, operation.generation, operation.runtime);
  }

  private finishScopedOperation(operation: ScopedPanelOperation): void {
    this.operationAborts.delete(operation.controller);
    if (this.commandRunLoadAbort === operation.controller) this.commandRunLoadAbort = undefined;
  }

  private selectPreferredLoadedTerminal(options?: { replaceUrl?: boolean | undefined }): void {
    const context = this.context;
    const runtime = this.runtime;
    if (context === undefined || runtime === undefined) return;
    const latestTerminalId = runtime.selection.latestTerminalId(runtime.selectionScope(context));
    let terminal = selectPreferredTerminal(this.terminals, {
      targetTerminalId: this.requestedTerminalId,
      latestTerminalId,
    });
    if (terminal === undefined && this.requestedTerminalId !== undefined) terminal = selectFallbackTerminal(this.terminals);
    const selectedTerminalId = terminal?.id;
    this.selectTerminalIdInView(selectedTerminalId);
    this.requestedTerminalId = selectedTerminalId;
    if (selectedTerminalId !== this.routedTerminalId || selectedTerminalId !== latestTerminalId) {
      this.publishTerminalSelection(context, runtime, selectedTerminalId, { replace: options?.replaceUrl === true });
    }
  }

  private selectTerminalIdInView(id: string | undefined): void {
    if (this.selectedId === id) return;
    this.selectedId = id;
    this.disposeTerminalView();
  }

  private async startTerminal(): Promise<void> {
    const operation = this.beginScopedOperation();
    if (operation === undefined) return;
    this.error = undefined;
    try {
      const size = this.measureTerminalSize() ?? DEFAULT_TERMINAL_SIZE;
      const terminal = await this.backendClient(operation.context).create(size, operation.controller.signal);
      if (!this.operationIsCurrent(operation)) return;
      this.terminals = [...this.terminals, terminal];
      operation.runtime.updateTerminals(operation.context, this.terminals);
      this.selectTerminal(terminal.id);
    } catch (error) {
      if (this.operationIsCurrent(operation)) this.error = errorMessage(error);
    } finally {
      this.finishScopedOperation(operation);
    }
  }

  private async closeTerminal(id: string, event: Event): Promise<void> {
    event.stopPropagation();
    const operation = this.beginScopedOperation();
    if (operation === undefined) return;
    try {
      await this.backendClient(operation.context).close(id, operation.controller.signal);
      if (!this.operationIsCurrent(operation)) return;
      const next = this.terminals.filter((terminal) => terminal.id !== id);
      this.terminals = next;
      operation.runtime.forgetTerminal(operation.context, id);
      operation.runtime.updateTerminals(operation.context, next);
      if (this.selectedId === id || this.requestedTerminalId === id) {
        const nextSelectedId = selectFallbackTerminal(next)?.id;
        this.selectTerminalIdInView(nextSelectedId);
        this.publishTerminalSelection(operation.context, operation.runtime, nextSelectedId, { replace: true });
      }
    } catch (error) {
      if (this.operationIsCurrent(operation)) this.error = errorMessage(error);
    } finally {
      this.finishScopedOperation(operation);
    }
  }

  private selectTerminal(id: string): void {
    const context = this.context;
    const runtime = this.runtime;
    if (context === undefined || runtime === undefined) return;
    if (this.selectedId !== id) this.selectTerminalIdInView(id);
    this.publishTerminalSelection(context, runtime, id);
  }

  private publishTerminalSelection(
    context: WorkspacePanelContext,
    runtime: TerminalBrowserRuntime,
    terminalId: string | undefined,
    options?: { replace?: boolean | undefined },
  ): void {
    this.pendingTerminalNavigation = { context, terminalId };
    this.routedTerminalId = terminalId;
    this.requestedTerminalId = terminalId;
    runtime.selectTerminal(context, terminalId, options);
  }

  private selectedTerminalInfo(): TerminalInfo | undefined {
    return this.terminals.find((terminal) => terminal.id === this.selectedId);
  }

  private selectedCommandRun(): TerminalCommandRun | undefined {
    const commandRunId = this.selectedTerminalInfo()?.commandRunId;
    if (commandRunId === undefined) return undefined;
    return this.commandRuns.find((run) => run.id === commandRunId);
  }

  private async loadCommandRuns(): Promise<void> {
    this.commandRunLoadAbort?.abort();
    const operation = this.beginScopedOperation();
    if (operation === undefined) return;
    this.commandRunLoadAbort = operation.controller;
    try {
      const commandRuns = await this.backendClient(operation.context).listCommandRuns({}, operation.controller.signal);
      if (!this.operationIsCurrent(operation)) return;
      this.commandRuns = commandRuns;
      this.cancellingRunIds = this.cancellingRunIds.filter((runId) => commandRuns.some((run) => run.id === runId && isCommandRunPending(run)));
    } catch (error) {
      if (this.operationIsCurrent(operation)) this.error = errorMessage(error);
    } finally {
      const shouldPoll = this.operationIsCurrent(operation) && this.visible && this.hasPendingCommandRuns();
      this.finishScopedOperation(operation);
      this.updateCommandRunPolling(shouldPoll);
    }
  }

  private updateCommandRunPolling(shouldPoll: boolean): void {
    if (shouldPoll && this.visible && this.commandRunPollTimer === undefined && this.commandRunLoadAbort === undefined) {
      this.commandRunPollTimer = window.setTimeout(() => {
        this.commandRunPollTimer = undefined;
        void this.loadCommandRuns();
      }, COMMAND_RUN_POLL_INTERVAL_MS);
      return;
    }
    if (!shouldPoll && this.commandRunPollTimer !== undefined) {
      window.clearTimeout(this.commandRunPollTimer);
      this.commandRunPollTimer = undefined;
    }
  }

  private hasPendingCommandRuns(commandRuns = this.commandRuns): boolean {
    return commandRuns.some(isCommandRunPending);
  }

  private async cancelCommandRun(run: TerminalCommandRun): Promise<void> {
    if (!isCommandRunPending(run) || this.cancellingRunIds.includes(run.id)) return;
    const operation = this.beginScopedOperation();
    if (operation === undefined) return;
    this.error = undefined;
    this.cancellingRunIds = [...this.cancellingRunIds, run.id];
    try {
      await this.backendClient(operation.context).cancelCommandRun(run.id, operation.controller.signal);
      if (!this.operationIsCurrent(operation)) return;
      await this.loadCommandRuns();
    } catch (error) {
      if (this.operationIsCurrent(operation)) this.error = errorMessage(error);
    } finally {
      if (this.operationIsCurrent(operation)) this.cancellingRunIds = this.cancellingRunIds.filter((runId) => runId !== run.id);
      this.finishScopedOperation(operation);
    }
  }

  private async continueTerminal(id: string): Promise<void> {
    if (this.continuingTerminalIds.includes(id)) return;
    const operation = this.beginScopedOperation();
    if (operation === undefined) return;
    this.error = undefined;
    this.continuingTerminalIds = [...this.continuingTerminalIds, id];
    try {
      const terminal = await this.backendClient(operation.context).continue(id, operation.controller.signal);
      if (!this.operationIsCurrent(operation)) return;
      this.terminals = this.terminals.map((item) => item.id === id ? terminal : item);
      operation.runtime.updateTerminals(operation.context, this.terminals);
      if (this.channel === undefined) this.disposeTerminalView();
      this.fitAndNotify();
      this.terminal?.focus();
    } catch (error) {
      if (this.operationIsCurrent(operation)) this.error = errorMessage(error);
    } finally {
      if (this.operationIsCurrent(operation)) this.continuingTerminalIds = this.continuingTerminalIds.filter((terminalId) => terminalId !== id);
      this.finishScopedOperation(operation);
    }
  }

  private ensureTerminalView(): void {
    const context = this.context;
    const terminalHost = this.terminalHostElement();
    if (!this.visible || this.terminal !== undefined || this.selectedId === undefined || terminalHost === undefined || context === undefined) return;
    const terminal = new Terminal(terminalOptions(this));
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(terminalHost);
    this.terminal = terminal;
    this.fitAddon = fitAddon;
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => { this.fitAndNotify(); });
      this.resizeObserver.observe(terminalHost);
    }
    terminal.onData((data) => { this.handleTerminalData(terminal, data); });
    const initialSize = this.fitTerminal();
    this.connectChannel(context, this.selectedId, terminal, initialSize);
    requestAnimationFrame(() => { this.fitAndNotify(); });
    terminal.focus();
  }

  private connectChannel(
    context: WorkspacePanelContext,
    terminalId: string,
    terminal: Terminal,
    initialSize: TerminalSize | undefined,
    resetAfterReconnect = false,
  ): void {
    const generation = ++this.channelGeneration;
    this.channelAbort?.abort();
    const controller = new AbortController();
    this.channelAbort = controller;
    const bufferedFrames: TerminalServerFrame[] = [];
    let readyForFrames = !resetAfterReconnect;
    void this.backendClient(context).attach({
      terminalId,
      ...(initialSize === undefined ? {} : { size: initialSize }),
      signal: controller.signal,
      onFrame: (frame) => {
        if (readyForFrames) this.handleChannelFrame(generation, frame, terminalId, terminal);
        else bufferedFrames.push(frame);
      },
    }).then((channel) => {
      if (!this.channelIsCurrent(generation, terminalId, terminal) || controller.signal.aborted) {
        channel.close("Terminal view changed");
        return;
      }
      this.channel = channel;
      if (resetAfterReconnect) {
        this.replayInputSuppression = undefined;
        terminal.reset();
      }
      readyForFrames = true;
      for (const frame of bufferedFrames) this.handleChannelFrame(generation, frame, terminalId, terminal);
      this.channelReconnectAttempt = 0;
      this.connectionError = undefined;
      this.fitAndNotify();
      void channel.closed.then((close) => { this.handleChannelClosed(generation, terminalId, terminal, close); });
    }).catch((error: unknown) => {
      if (controller.signal.aborted || !this.channelIsCurrent(generation, terminalId, terminal)) return;
      this.connectionError = `Terminal connection failed: ${errorMessage(error)}`;
      this.scheduleChannelReconnect(terminalId, terminal);
    });
  }

  private handleChannelFrame(generation: number, frame: TerminalServerFrame, terminalId: string, terminal: Terminal): void {
    if (!this.channelIsCurrent(generation, terminalId, terminal)) return;
    if (frame.type === "output") {
      this.writeTerminalOutput(generation, terminalId, terminal, frame);
      return;
    }
    if (frame.type === "exit") {
      terminal.writeln(`\r\n[process exited${frame.exitCode === undefined ? "" : ` with code ${String(frame.exitCode)}`}]`);
      this.terminals = this.terminals.map((item) => item.id === terminalId ? { ...item, exited: true, ...(frame.exitCode === undefined ? {} : { exitCode: frame.exitCode }) } : item);
      if (this.context !== undefined && this.runtime !== undefined) this.runtime.updateTerminals(this.context, this.terminals);
      void this.loadCommandRuns();
      return;
    }
    terminal.writeln(`\r\n[terminal error: ${frame.message}]`);
  }

  private handleChannelClosed(generation: number, terminalId: string, terminal: Terminal, close: WorkspaceBackendChannelClose): void {
    if (!this.channelIsCurrent(generation, terminalId, terminal)) return;
    this.channel = undefined;
    const failure = terminalChannelFailureMessage(close);
    if (failure === undefined) {
      void this.refreshAfterCleanChannelClose(generation, terminalId, terminal);
      return;
    }
    this.connectionError = `Terminal connection closed: ${failure}`;
    terminal.writeln(`\r\n[terminal connection closed: ${failure}]`);
    this.scheduleChannelReconnect(terminalId, terminal);
  }

  private async refreshAfterCleanChannelClose(generation: number, terminalId: string, terminal: Terminal): Promise<void> {
    await this.loadTerminals();
    if (!this.channelIsCurrent(generation, terminalId, terminal) || this.channel !== undefined) return;
    const context = this.context;
    const terminalInfo = this.terminals.find((candidate) => candidate.id === terminalId);
    if (context === undefined || terminalInfo === undefined || terminalInfo.exited) return;
    this.connectChannel(context, terminalId, terminal, this.fitTerminal(), true);
  }

  private scheduleChannelReconnect(terminalId: string, terminal: Terminal): void {
    if (!this.visible || terminal !== this.terminal || terminalId !== this.selectedId || this.context === undefined) return;
    if (this.channelReconnectTimer !== undefined) window.clearTimeout(this.channelReconnectTimer);
    const delay = CHANNEL_RECONNECT_DELAYS_MS[Math.min(this.channelReconnectAttempt, CHANNEL_RECONNECT_DELAYS_MS.length - 1)] ?? 5_000;
    this.channelReconnectAttempt += 1;
    this.channelReconnectTimer = window.setTimeout(() => {
      this.channelReconnectTimer = undefined;
      const context = this.context;
      if (context === undefined || !this.visible || terminal !== this.terminal || terminalId !== this.selectedId) return;
      this.connectChannel(context, terminalId, terminal, this.fitTerminal(), true);
    }, delay);
  }

  private channelIsCurrent(generation: number, terminalId: string, terminal: Terminal): boolean {
    return generation === this.channelGeneration && terminal === this.terminal && terminalId === this.selectedId;
  }

  private handleTerminalData(terminal: Terminal, data: string): void {
    const suppression = this.replayInputSuppression;
    if (terminal !== this.terminal
      || this.copySnapshot !== undefined
      || suppression?.terminal === terminal) return;
    this.sendTerminalInput(data);
  }

  private writeTerminalOutput(
    generation: number,
    terminalId: string,
    terminal: Terminal,
    frame: Extract<TerminalServerFrame, { type: "output" }>,
  ): void {
    if (!frame.replay) {
      terminal.write(frame.data);
      return;
    }
    let suppression = this.replayInputSuppression;
    if (suppression?.generation !== generation
      || suppression.terminalId !== terminalId
      || suppression.terminal !== terminal) {
      suppression = { generation, terminalId, terminal };
      this.replayInputSuppression = suppression;
    }
    terminal.write(frame.data, frame.replayComplete ? () => {
      if (this.replayInputSuppression === suppression
        && this.channelIsCurrent(generation, terminalId, terminal)) {
        this.replayInputSuppression = undefined;
      }
    } : undefined);
  }

  private fitAndNotify(): void {
    const size = this.fitTerminal();
    if (size === undefined) return;
    this.send({ type: "resize", ...size });
  }

  private fitTerminal(): TerminalSize | undefined {
    if (this.fitAddon === undefined || this.terminal === undefined) return undefined;
    const dimensions = this.fitAddon.proposeDimensions();
    const size = terminalSizeFromDimensions(dimensions);
    if (size === undefined) return undefined;
    this.fitAddon.fit();
    return size;
  }

  private measureTerminalSize(): TerminalSize | undefined {
    const currentSize = this.fitTerminal();
    if (currentSize !== undefined) return currentSize;
    const terminalHost = this.terminalHostElement();
    if (this.terminal !== undefined || terminalHost === undefined) return undefined;

    const measuringTerminal = new Terminal(terminalOptions(this));
    const measuringFitAddon = new FitAddon();
    measuringTerminal.loadAddon(measuringFitAddon);
    measuringTerminal.open(terminalHost);
    const size = terminalSizeFromDimensions(measuringFitAddon.proposeDimensions());
    measuringTerminal.dispose();
    return size;
  }

  private terminalHostElement(): HTMLDivElement | undefined {
    const terminalHost = this.terminalHost;
    return terminalHost instanceof HTMLDivElement ? terminalHost : undefined;
  }

  private applyTerminalTheme(): void {
    if (this.terminal !== undefined) this.terminal.options.theme = terminalTheme(this);
  }

  private sendTerminalInput(data: string): void {
    const filtered = filterTerminalInput(data);
    for (const frame of terminalInputFrames(filtered)) {
      if (!this.send(frame)) return;
    }
  }

  private sendSoftKeyInput(data: string, options: TerminalSoftKeyInputOptions): void {
    if (this.copySnapshot !== undefined) return;
    this.sendTerminalInput(data);
    if (options.refocus) this.focusTerminal();
  }

  private focusTerminal(): void {
    const terminal = this.terminal;
    if (terminal === undefined) return;
    terminal.focus();
    requestAnimationFrame(() => { terminal.focus(); });
  }

  private send(message: TerminalClientFrame): boolean {
    const channel = this.channel;
    if (channel === undefined) return false;
    try {
      channel.send(message);
      return true;
    } catch (error) {
      this.connectionError = `Terminal send failed: ${errorMessage(error)}`;
      return false;
    }
  }

  private disposeTerminalView(): void {
    this.channelGeneration += 1;
    if (this.channelReconnectTimer !== undefined) window.clearTimeout(this.channelReconnectTimer);
    this.channelReconnectTimer = undefined;
    this.channelReconnectAttempt = 0;
    this.channelAbort?.abort();
    this.channelAbort = undefined;
    this.channel?.close("Terminal view disposed");
    this.channel = undefined;
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    this.replayInputSuppression = undefined;
    this.terminal?.dispose();
    this.terminal = undefined;
    this.fitAddon = undefined;
    this.copySnapshot = undefined;
    this.copyStatus = undefined;
    this.connectionError = undefined;
  }

  private backendClient(context: WorkspacePanelContext): TerminalBackendClient {
    if (context.backend === undefined) throw new Error("Required Terminal paired backend is unavailable");
    return new TerminalBackendClient(context.backend);
  }

  private renderCommandRunNotice() {
    const run = this.selectedCommandRun();
    if (run === undefined) return null;
    const terminal = this.selectedTerminalInfo();
    if (isCommandRunPending(run)) {
      const cancelling = this.cancellingRunIds.includes(run.id);
      return html`
        <section class="command-run-notice running">
          <div>
            <strong>${run.title}</strong>
            <p>Command is running. Press <kbd>Ctrl</kbd>+<kbd>C</kbd> or use the button to cancel.</p>
            <code>${run.command}</code>
          </div>
          <button class="danger" ?disabled=${cancelling} @click=${() => { void this.cancelCommandRun(run); }}>${cancelling ? "Cancel sent…" : "Cancel command"}</button>
        </section>
      `;
    }
    if (terminal?.exited === true) {
      const continuing = this.continuingTerminalIds.includes(terminal.id);
      return html`
        <section class=${`command-run-notice ${run.status}`}>
          <div>
            <strong>${commandRunCompletionLabel(run)}</strong>
            <p>Output is preserved. Continue in a shell to inspect or run follow-up commands.</p>
            <code>${run.command}</code>
          </div>
          <button ?disabled=${continuing} @click=${() => { void this.continueTerminal(terminal.id); }}>${continuing ? "Starting shell…" : "Continue in shell"}</button>
        </section>
      `;
    }
    return null;
  }

  private enterCopyMode(): void {
    if (this.copySnapshot !== undefined) return;
    this.captureCopySnapshot();
  }

  private refreshCopyMode(): void {
    if (this.copySnapshot === undefined) return;
    this.captureCopySnapshot();
  }

  private captureCopySnapshot(): void {
    const terminal = this.terminal;
    if (terminal === undefined) return;
    const snapshot = createTerminalCopySnapshot(terminal.buffer.active, terminal.cols, {
      theme: terminal.options.theme,
      drawBoldTextInBrightColors: terminal.options.drawBoldTextInBrightColors,
    });
    this.copySnapshot = snapshot;
    this.copyStatus = undefined;
    terminal.blur();
    void this.updateComplete.then(() => {
      const selector = this.terminalCopySelector;
      if (selector === null || selector === undefined) return;
      const sourceScrollRange = Math.max(0, snapshot.physicalLineCount - terminal.rows);
      const sourceScrollTop = Math.min(sourceScrollRange, snapshot.viewportLine);
      const scrollRatio = sourceScrollRange === 0 ? 0 : sourceScrollTop / sourceScrollRange;
      selector.scrollTop = scrollRatio * Math.max(0, selector.scrollHeight - selector.clientHeight);
      this.syncCopySnapshotScroll();
    });
  }

  private exitCopyMode(): void {
    if (this.copySnapshot === undefined) return;
    this.copySnapshot = undefined;
    this.copyStatus = undefined;
  }

  // iOS WebKit offsets native selection hit-testing in a scrolled generic
  // overflow container. A textarea owns selection and scrolling while the
  // synchronized, noninteractive pre preserves the terminal's ANSI styling.
  // Keep its caret visible: iOS hides native selection handles with the caret.
  private syncCopySnapshotScroll(): void {
    const selector = this.terminalCopySelector;
    const content = this.terminalCopyContent;
    if (selector === null || selector === undefined || content === null || content === undefined) return;
    const selectorVerticalRange = Math.max(0, selector.scrollHeight - selector.clientHeight);
    const contentVerticalRange = Math.max(0, content.scrollHeight - content.clientHeight);
    const selectorHorizontalRange = Math.max(0, selector.scrollWidth - selector.clientWidth);
    const contentHorizontalRange = Math.max(0, content.scrollWidth - content.clientWidth);
    content.scrollTop = normalizedScrollOffset(selector.scrollTop, selectorVerticalRange, contentVerticalRange);
    content.scrollLeft = normalizedScrollOffset(selector.scrollLeft, selectorHorizontalRange, contentHorizontalRange);
  }

  private async copyAllSnapshotText(): Promise<void> {
    const text = this.copySnapshot?.text ?? "";
    if (text === "") {
      this.copyStatus = "No terminal output to copy.";
      return;
    }
    this.copyStatus = await writeClipboardText(text) ? "Copied all terminal output." : "Unable to copy terminal output.";
  }

  private renderCopyModeToggle() {
    if (this.selectedId === undefined) return null;
    const active = this.copySnapshot !== undefined;
    return html`
      <button
        type="button"
        class=${active ? "copy-mode-toggle selected" : "copy-mode-toggle"}
        title=${active ? "Return to the interactive terminal" : "Select and copy terminal output"}
        aria-label=${active ? "Close terminal copy mode" : "Open terminal copy mode"}
        aria-pressed=${String(active)}
        @click=${() => { if (active) this.exitCopyMode(); else this.enterCopyMode(); }}
      >
        <span>${active ? "Done" : "Select"}</span>
      </button>
    `;
  }

  private renderCopyModeToolbar() {
    const snapshot = this.copySnapshot;
    if (snapshot === undefined) return null;
    return html`
      <div class="terminal-copy-toolbar" role="toolbar" aria-label="Terminal copy controls">
        <span aria-live="polite">${this.copyStatus ?? "Snapshot · long-press and select text"}</span>
        <small>${snapshot.physicalLineCount} ${snapshot.physicalLineCount === 1 ? "row" : "rows"}</small>
        <button type="button" @click=${() => { this.refreshCopyMode(); }}>Refresh</button>
        <button type="button" @click=${() => { void this.copyAllSnapshotText(); }}>Copy all</button>
      </div>
    `;
  }

  private renderCopyMode() {
    const snapshot = this.copySnapshot;
    if (snapshot === undefined) return null;
    return html`
      <section class="terminal-copy-view" aria-label="Terminal copy mode">
        ${this.copyToolbarReplacesSoftKeys() ? null : this.renderCopyModeToolbar()}
        <div class="terminal-copy-layers">
          <pre class="terminal-copy-content" aria-hidden="true">${snapshot.lines.map((line, index) => html`${index === 0 ? null : "\n"}${line.runs.map((run) => html`<span style=${styleMap(terminalCopyRunStyle(run.style))}>${run.text}</span>`)}`)}</pre>
          <textarea
            class="terminal-copy-selector"
            readonly
            inputmode="none"
            wrap="soft"
            spellcheck="false"
            autocapitalize="off"
            autocomplete="off"
            aria-label="Selectable terminal output"
            .value=${snapshot.text}
            @scroll=${() => { this.syncCopySnapshotScroll(); }}
          ></textarea>
        </div>
      </section>
    `;
  }

  private selectedTerminalAcceptsInput(): boolean {
    const terminal = this.selectedTerminalInfo();
    return terminal !== undefined && !terminal.exited;
  }

  private copyToolbarReplacesSoftKeys(): boolean {
    return this.copySnapshot !== undefined && this.selectedTerminalAcceptsInput() && this.softKeysEnabled;
  }

  private renderTerminalAccessoryBar() {
    if (this.copySnapshot !== undefined) return this.copyToolbarReplacesSoftKeys() ? this.renderCopyModeToolbar() : null;
    return this.shouldShowSoftKeys() ? this.renderSoftKeys() : null;
  }

  private shouldShowSoftKeys(): boolean {
    return this.selectedTerminalAcceptsInput() && this.softKeysEnabled;
  }

  private shouldShowSoftKeysToggle(): boolean {
    return this.copySnapshot === undefined && this.selectedTerminalAcceptsInput();
  }

  private toggleSoftKeys(): void {
    if (this.copySnapshot !== undefined) return;
    this.softKeysEnabled = !this.softKeysEnabled;
    this.softKeysPreferenceStored = true;
    writeTerminalSoftKeysPreference(this.softKeysEnabled);
    this.scheduleFitAndNotify();
  }

  private renderSoftKeysToggle() {
    if (!this.shouldShowSoftKeysToggle()) return null;
    return html`
      <button
        type="button"
        class=${this.softKeysEnabled ? "soft-keys-toggle selected" : "soft-keys-toggle"}
        title=${this.softKeysEnabled ? "Hide terminal soft keys" : "Show terminal soft keys"}
        aria-label=${this.softKeysEnabled ? "Hide terminal soft keys" : "Show terminal soft keys"}
        aria-pressed=${String(this.softKeysEnabled)}
        @click=${() => { this.toggleSoftKeys(); }}
      >
        <svg class="keyboard-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <rect x="3" y="5" width="18" height="14" rx="2"></rect>
          <path d="M7 9h.01M10 9h.01M13 9h.01M16 9h.01M7 12h.01M10 12h.01M13 12h.01M16 12h.01M8 16h8"></path>
        </svg>
        <span>Keys</span>
      </button>
    `;
  }

  private renderSoftKeys() {
    const softKeysTag = unsafeStatic(this.softKeysElementName);
    return staticHtml`
      <${softKeysTag}
        class="terminal-soft-keys"
        .modes=${this.terminal?.modes}
        .refocusOnClick=${!this.defaultSoftKeysEnvironment}
        .onInput=${(data: string, options: TerminalSoftKeyInputOptions) => { this.sendSoftKeyInput(data, options); }}
      ></${softKeysTag}>
    `;
  }

  override render() {
    return html`
      <section class="terminal-shell">
        <div class="terminal-tabs">
          ${this.renderCopyModeToggle()}
          ${this.renderSoftKeysToggle()}
          ${this.terminals.map((terminal) => html`
            <button class=${this.selectedId === terminal.id ? "selected" : ""} @click=${() => { this.selectTerminal(terminal.id); }}>
              <span>${terminal.name}${terminal.exited ? " · exited" : ""}</span>
              <small @click=${(event: Event) => { void this.closeTerminal(terminal.id, event); }}>×</small>
            </button>
          `)}
          <button class="new" ?disabled=${this.context === undefined} @click=${() => { void this.startTerminal(); }}>+ Shell</button>
        </div>
        ${this.error === undefined ? null : html`<p class="error">${this.error}</p>`}
        ${this.connectionError === undefined ? null : html`<p class="error">${this.connectionError}</p>`}
        ${this.renderCommandRunNotice()}
        ${this.renderTerminalAccessoryBar()}
        ${this.loading ? html`<p class="muted">Loading terminals…</p>` : null}
        <div class="terminal-stage">
          <div class=${this.copySnapshot === undefined ? "terminal-host" : "terminal-host copying"} ?inert=${this.copySnapshot !== undefined}></div>
          ${this.renderCopyMode()}
        </div>
      </section>
    `;
  }

  static override styles = [unsafeCSS(xtermStyles), css`
    :host { flex: 1 1 auto; min-height: 0; display: flex; }
    .terminal-shell { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; overflow: hidden; background: var(--pi-terminal-bg); }
    .terminal-tabs { flex: 0 0 auto; display: flex; gap: 6px; align-items: center; padding: 6px; border-bottom: 1px solid var(--pi-border-muted); background: var(--pi-bg); overflow: auto; }
    .terminal-tabs > button { box-sizing: border-box; height: 30px; line-height: 16px; }
    /* Desktop xterm already has mouse selection and hardware keys; keep touch controls to touch/narrow layouts. */
    .copy-mode-toggle, .soft-keys-toggle, .terminal-soft-keys { display: none; }
    .copy-mode-toggle.selected { display: inline-flex; }
    @media (pointer: coarse), (max-width: 760px) {
      .copy-mode-toggle, .soft-keys-toggle { display: inline-flex; }
      .terminal-soft-keys { display: block; }
    }
    button { display: inline-flex; align-items: center; gap: 6px; min-width: 0; max-width: 180px; border: 1px solid var(--pi-border); border-radius: 7px; background: var(--pi-surface); color: var(--pi-text); padding: 5px 7px; cursor: pointer; }
    button.selected { border-color: var(--pi-accent); background: var(--pi-selection-bg); }
    button.new { flex: 0 0 auto; color: var(--pi-muted); }
    .soft-keys-toggle { flex: 0 0 auto; }
    .soft-keys-toggle .keyboard-icon { display: block; flex: 0 0 auto; width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; pointer-events: none; }
    button span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    button small { color: var(--pi-muted); font-size: 14px; line-height: 1; }
    button small:hover { color: var(--pi-danger); }
    button.danger { color: var(--pi-danger); }
    button:disabled { opacity: .5; cursor: not-allowed; }
    .command-run-notice { flex: 0 0 auto; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 8px 10px; border-bottom: 1px solid var(--pi-border-muted); background: var(--pi-surface); color: var(--pi-text); }
    .command-run-notice.running { border-color: var(--pi-warning-border); }
    .command-run-notice.succeeded { border-color: var(--pi-success-border); }
    .command-run-notice.failed { border-color: var(--pi-danger); }
    .command-run-notice p { margin: 3px 0; color: var(--pi-muted); }
    .command-run-notice code { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--pi-text-secondary); font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .command-run-notice kbd { border: 1px solid var(--pi-border); border-radius: 4px; background: var(--pi-bg); padding: 0 4px; font: 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .command-run-notice button { justify-self: end; max-width: none; }
    .terminal-stage { position: relative; flex: 1 1 auto; min-height: 0; overflow: hidden; background: var(--pi-terminal-bg); }
    .terminal-host { position: absolute; inset: 0; padding: 6px; box-sizing: border-box; overflow: hidden; }
    .terminal-host.copying { visibility: hidden; pointer-events: none; }
    .terminal-copy-view { position: absolute; inset: 0; display: flex; flex-direction: column; min-height: 0; background: var(--pi-terminal-bg); color: var(--pi-terminal-text); }
    .terminal-copy-toolbar { box-sizing: border-box; flex: 0 0 auto; display: flex; align-items: center; gap: 8px; min-width: 0; min-height: 47px; padding: 6px; border-bottom: 1px solid var(--pi-border-muted); background: var(--pi-bg); color: var(--pi-muted); font: 12px system-ui, sans-serif; }
    .terminal-copy-toolbar > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .terminal-copy-toolbar small { margin-left: auto; white-space: nowrap; color: var(--pi-dim); }
    .terminal-copy-toolbar button { flex: 0 0 auto; width: auto; min-height: 34px; padding: 6px 9px; font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .terminal-copy-layers { flex: 1 1 auto; min-height: 0; display: grid; overflow: hidden; background: var(--pi-terminal-bg); }
    /* xterm renders the configured 13px terminal font in 17px-high cells. */
    .terminal-copy-content, .terminal-copy-selector { grid-area: 1 / 1; box-sizing: border-box; min-width: 0; min-height: 0; width: 100%; height: 100%; margin: 0; padding: 6px; border: 0; border-radius: 0; font: 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; line-height: 17px; letter-spacing: normal; font-variant-ligatures: none; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-all; }
    .terminal-copy-content { overflow: auto; pointer-events: none; background: var(--pi-terminal-bg); color: var(--pi-terminal-text); -webkit-user-select: none; user-select: none; }
    .terminal-copy-selector { z-index: 1; overflow: auto; resize: none; outline: none; appearance: none; background: transparent; color: transparent; caret-color: var(--pi-accent); -webkit-text-fill-color: transparent; cursor: text; -webkit-user-select: text; user-select: text; -webkit-touch-callout: default; touch-action: auto; }
    .terminal-copy-selector::selection { background: var(--pi-terminal-selection); color: transparent; -webkit-text-fill-color: transparent; }
    .terminal-host .xterm { height: 100%; cursor: text; position: relative; user-select: none; }
    .terminal-host .xterm.focus, .terminal-host .xterm:focus { outline: none; }
    .terminal-host .xterm-helpers { position: absolute; top: 0; z-index: 5; }
    /* Hide the helper textarea without using !important on the positional properties (left/top/width/height/z-index). xterm sets those inline during IME/dead-key composition (e.g. "~" on a Swedish layout) so the composition is positioned at the cursor and committed correctly; forcing them here would pin the textarea off-screen with zero size and break composition. */
    .terminal-host .xterm-helper-textarea { position: absolute; left: -9999em; top: 0; width: 0; height: 0; padding: 0 !important; border: 0 !important; margin: 0 !important; opacity: 0 !important; z-index: -5; white-space: nowrap !important; overflow: hidden !important; resize: none !important; outline: 0 !important; appearance: none !important; }
    /* The composition view shows pending dead-key/IME input. Without these rules it renders as a static block in the top-left corner instead of overlaying the cursor. */
    .terminal-host .composition-view { position: absolute; display: none; white-space: nowrap; z-index: 1; background: var(--pi-terminal-bg, #000); color: var(--pi-terminal-text, #fff); }
    .terminal-host .composition-view.active { display: block; }
    .terminal-host .xterm-viewport { position: absolute; inset: 0; overflow-y: scroll; cursor: default; background-color: var(--pi-terminal-bg); }
    .terminal-host .xterm-screen { position: relative; }
    .terminal-host .xterm-screen canvas { position: absolute; left: 0; top: 0; }
    .terminal-host .xterm-char-measure-element { display: inline-block; visibility: hidden; position: absolute; top: 0; left: -9999em; line-height: normal; }
    .terminal-host .xterm-accessibility:not(.debug), .terminal-host .xterm-message { position: absolute; inset: 0; z-index: 10; color: transparent; pointer-events: none; }
    .terminal-host .xterm-accessibility-tree:not(.debug) *::selection { color: transparent; }
    .terminal-host .xterm-accessibility-tree { font-family: monospace; user-select: text; white-space: pre; }
    .terminal-host .xterm-accessibility-tree > div { transform-origin: left; width: fit-content; }
    .terminal-host .live-region { position: absolute; left: -9999px; width: 1px; height: 1px; overflow: hidden; }
    .error { flex: 0 0 auto; margin: 0; padding: 8px; color: var(--pi-danger); border-bottom: 1px solid var(--pi-border); background: var(--pi-surface); }
    .muted { margin: 10px; color: var(--pi-muted); }
    .xterm { height: 100%; }
  `];
}

function normalizedScrollOffset(sourceOffset: number, sourceRange: number, targetRange: number): number {
  if (sourceRange <= 0 || targetRange <= 0) return 0;
  return Math.min(1, Math.max(0, sourceOffset / sourceRange)) * targetRange;
}

function dimTerminalCopyColor(color: string): string {
  return /^#[\da-f]{6}$/i.test(color) ? `${color}80` : `color-mix(in srgb, ${color} 50%, transparent)`;
}

function terminalCopyRunStyle(style: TerminalCopyRunStyle): StyleInfo {
  const decorations = [
    style.underline ? "underline" : undefined,
    style.strikethrough ? "line-through" : undefined,
    style.overline ? "overline" : undefined,
  ].filter((decoration): decoration is string => decoration !== undefined).join(" ");
  return {
    color: style.invisible ? "transparent" : style.dim ? dimTerminalCopyColor(style.foreground) : style.foreground,
    backgroundColor: style.background,
    fontWeight: style.bold ? "700" : undefined,
    fontStyle: style.italic ? "italic" : undefined,
    textDecorationLine: decorations === "" ? undefined : decorations,
  };
}

function isCommandRunPending(run: TerminalCommandRun): boolean {
  return run.status === "queued" || run.status === "running";
}

function commandRunCompletionLabel(run: TerminalCommandRun): string {
  if (run.status === "succeeded") return `Command succeeded${run.exitCode === undefined ? "" : ` with exit code ${String(run.exitCode)}`}`;
  return `Command failed${run.exitCode === undefined ? "" : ` with exit code ${String(run.exitCode)}`}`;
}

export function filterTerminalInput(data: string): string {
  // Xterm can emit focus-in/focus-out sequences when replayed output leaves focus
  // tracking enabled. Bash/readline treats those sequences as typed text, which
  // leaves stray characters on the prompt after reconnecting to an active shell.
  return data.replaceAll("\x1b[I", "").replaceAll("\x1b[O", "");
}

function terminalOptions(element: HTMLElement): ITerminalOptions {
  return { ...TERMINAL_OPTIONS_BASE, theme: terminalTheme(element) };
}

function terminalTheme(element: HTMLElement): ITheme {
  return {
    ...DEFAULT_TERMINAL_ANSI_THEME,
    background: themeColor(element, "--pi-terminal-bg", "#05070a"),
    foreground: themeColor(element, "--pi-terminal-text", "#e6edf3"),
    cursor: themeColor(element, "--pi-accent", "#58a6ff"),
    selectionBackground: themeColor(element, "--pi-terminal-selection", "#264f78"),
  };
}

function themeColor(element: HTMLElement, name: string, fallback: string): string {
  const value = getComputedStyle(element).getPropertyValue(name).trim();
  return value === "" ? fallback : value;
}

function terminalSizeFromDimensions(dimensions: ITerminalDimensions | undefined): TerminalSize | undefined {
  if (dimensions === undefined || !isValidTerminalSize(dimensions.cols, dimensions.rows)) return undefined;
  return { cols: Math.floor(dimensions.cols), rows: Math.floor(dimensions.rows) };
}

function isValidTerminalSize(cols: number, rows: number): boolean {
  return Number.isFinite(cols) && Number.isFinite(rows) && cols > 0 && rows > 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
