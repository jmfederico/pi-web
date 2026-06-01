import { css, html, LitElement, type PropertyValues } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { Terminal, type ITerminalOptions, type ITheme } from "@xterm/xterm";
import { FitAddon, type ITerminalDimensions } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { terminalSocket, terminalsApi, type TerminalCommandRun, type TerminalInfo, type Workspace } from "../api";
import { selectFallbackTerminal, selectPreferredTerminal } from "../controllers/terminalSelection";
import { createTerminalSoftKeysDefaultEnvironmentMedia, hasTerminalSoftKeysPreference, initialTerminalSoftKeysEnabled, isTerminalSoftKeysDefaultEnvironment, writeTerminalSoftKeysPreference } from "../terminalSoftKeysPreference";
import "./TerminalSoftKeys";
import type { TerminalSoftKeyInputOptions } from "./TerminalSoftKeys";

const TERMINAL_OPTIONS_BASE: ITerminalOptions = {
  cursorBlink: true,
  convertEol: true,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  fontSize: 13,
};

const DEFAULT_TERMINAL_SIZE: TerminalSize = { cols: 100, rows: 30 };
const COMMAND_RUN_POLL_INTERVAL_MS = 1000;

@customElement("terminal-panel")
export class TerminalPanel extends LitElement {
  @property({ attribute: false }) workspace: Workspace | undefined;
  @property() machineId = "local";
  @property({ attribute: false }) selectedTerminalId: string | undefined;
  @property({ type: Boolean }) autoStart = false;
  @property({ attribute: false }) onSelectTerminal: (terminalId: string | undefined, options?: { replace?: boolean | undefined }) => void = () => undefined;
  @query(".terminal-host") private terminalHost?: HTMLDivElement | null;
  @state() private terminals: TerminalInfo[] = [];
  @state() private commandRuns: TerminalCommandRun[] = [];
  @state() private selectedId: string | undefined;
  @state() private loading = false;
  @state() private error: string | undefined;
  @state() private visible = false;
  @state() private cancellingRunIds: string[] = [];
  @state() private continuingTerminalIds: string[] = [];
  @state() private defaultSoftKeysEnvironment = false;
  @state() private softKeysEnabled = initialTerminalSoftKeysEnabled();

  private terminal: Terminal | undefined;
  private fitAddon: FitAddon | undefined;
  private socket: WebSocket | undefined;
  private resizeObserver: ResizeObserver | undefined;
  private intersectionObserver: IntersectionObserver | undefined;
  private themeObserver: MutationObserver | undefined;
  private suppressTerminalInput = false;
  private observedCwd: string | undefined;
  private loadedCwd: string | undefined;
  private autoStartConsumedCwd: string | undefined;
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

  override willUpdate(changed: PropertyValues<this>): void {
    const cwd = this.workspace?.path;
    if (cwd !== this.observedCwd) {
      this.observedCwd = cwd;
      this.loadedCwd = undefined;
      this.autoStartConsumedCwd = undefined;
      this.terminals = [];
      this.commandRuns = [];
      this.selectedId = undefined;
      this.cancellingRunIds = [];
      this.continuingTerminalIds = [];
      this.updateCommandRunPolling(false);
      this.disposeTerminalView();
      return;
    }
    if (changed.has("selectedTerminalId")) {
      const previousTerminalId = changed.get("selectedTerminalId");
      if (previousTerminalId !== undefined && this.selectedTerminalId === undefined) {
        this.loadedCwd = undefined;
        this.selectTerminalIdInView(undefined);
        return;
      }
      this.applyRequestedTerminalSelection();
    }
  }

  override updated(changed: PropertyValues<this>): void {
    if (!this.visible) this.updateCommandRunPolling(false);
    else if (this.hasPendingCommandRuns()) this.updateCommandRunPolling(true);
    this.loadVisibleWorkspaceTerminals();
    if (changed.has("selectedTerminalId") && this.shouldReloadForRequestedTerminal()) void this.loadTerminals();
    this.ensureTerminalView();
  }

  private loadVisibleWorkspaceTerminals(): void {
    const cwd = this.workspace?.path;
    if (!this.visible || cwd === undefined || cwd === this.loadedCwd) return;
    this.loadedCwd = cwd;
    void this.loadTerminals();
  }

  private async loadTerminals(): Promise<void> {
    this.loading = true;
    this.error = undefined;
    try {
      const workspace = this.workspace;
      if (workspace === undefined) return;
      const shouldAutoStart = this.consumeAutoStart();
      const [terminals, commandRuns] = await Promise.all([
        terminalsApi.terminals(workspace.projectId, workspace.id, this.machineId),
        terminalsApi.listCommandRuns({ projectId: workspace.projectId, workspaceId: workspace.id }, this.machineId),
      ]);
      this.terminals = terminals;
      this.commandRuns = commandRuns;
      this.selectPreferredLoadedTerminal({ replaceUrl: true });
      this.updateCommandRunPolling(this.hasPendingCommandRuns(commandRuns));
      if (terminals.length === 0 && shouldAutoStart) await this.startTerminal();
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.loading = false;
    }
  }

  private applyRequestedTerminalSelection(): void {
    if (this.selectedTerminalId !== undefined && !this.terminals.some((terminal) => terminal.id === this.selectedTerminalId)) return;
    this.selectPreferredLoadedTerminal({ replaceUrl: true });
  }

  private consumeAutoStart(): boolean {
    const cwd = this.workspace?.path;
    if (!this.autoStart || cwd === undefined || this.autoStartConsumedCwd === cwd) return false;
    this.autoStartConsumedCwd = cwd;
    return true;
  }

  private shouldReloadForRequestedTerminal(): boolean {
    const cwd = this.workspace?.path;
    return this.visible
      && cwd !== undefined
      && cwd === this.loadedCwd
      && this.selectedTerminalId !== undefined
      && !this.loading
      && !this.terminals.some((terminal) => terminal.id === this.selectedTerminalId);
  }

  private selectPreferredLoadedTerminal(options?: { replaceUrl?: boolean | undefined }): void {
    let terminal = selectPreferredTerminal(this.terminals, { targetTerminalId: this.selectedTerminalId });
    if (terminal === undefined && this.selectedTerminalId !== undefined) terminal = selectFallbackTerminal(this.terminals);
    this.selectTerminalIdInView(terminal?.id);
    if (terminal?.id !== this.selectedTerminalId || (terminal === undefined && this.selectedTerminalId !== undefined)) {
      this.onSelectTerminal(terminal?.id, { replace: options?.replaceUrl === true });
    }
  }

  private selectTerminalIdInView(id: string | undefined): void {
    if (this.selectedId === id) return;
    this.selectedId = id;
    this.disposeTerminalView();
  }

  private async startTerminal(): Promise<void> {
    if (this.workspace === undefined) return;
    this.error = undefined;
    try {
      const size = this.measureTerminalSize() ?? DEFAULT_TERMINAL_SIZE;
      const terminal = await terminalsApi.startTerminal(this.workspace.projectId, this.workspace.id, size, this.machineId);
      this.terminals = [...this.terminals, terminal];
      this.selectTerminal(terminal.id);
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
  }

  private async closeTerminal(id: string, event: Event): Promise<void> {
    event.stopPropagation();
    try {
      if (this.workspace === undefined) return;
      await terminalsApi.closeTerminal(this.workspace.projectId, this.workspace.id, id, this.machineId);
      const next = this.terminals.filter((terminal) => terminal.id !== id);
      this.terminals = next;
      if (this.selectedId === id || this.selectedTerminalId === id) {
        const nextSelectedId = selectFallbackTerminal(next)?.id;
        this.selectTerminalIdInView(nextSelectedId);
        this.onSelectTerminal(nextSelectedId, { replace: true });
      }
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
  }

  private selectTerminal(id: string): void {
    if (this.selectedId !== id) this.selectTerminalIdInView(id);
    this.onSelectTerminal(id);
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
    const workspace = this.workspace;
    if (workspace === undefined) return;
    try {
      const commandRuns = await terminalsApi.listCommandRuns({ projectId: workspace.projectId, workspaceId: workspace.id }, this.machineId);
      this.commandRuns = commandRuns;
      this.cancellingRunIds = this.cancellingRunIds.filter((runId) => commandRuns.some((run) => run.id === runId && isCommandRunPending(run)));
      this.updateCommandRunPolling(this.hasPendingCommandRuns(commandRuns));
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
  }

  private updateCommandRunPolling(shouldPoll: boolean): void {
    if (shouldPoll && this.commandRunPollTimer === undefined) {
      this.commandRunPollTimer = window.setInterval(() => { void this.loadCommandRuns(); }, COMMAND_RUN_POLL_INTERVAL_MS);
      return;
    }
    if (!shouldPoll && this.commandRunPollTimer !== undefined) {
      window.clearInterval(this.commandRunPollTimer);
      this.commandRunPollTimer = undefined;
    }
  }

  private hasPendingCommandRuns(commandRuns = this.commandRuns): boolean {
    return commandRuns.some(isCommandRunPending);
  }

  private async cancelCommandRun(run: TerminalCommandRun): Promise<void> {
    if (!isCommandRunPending(run) || this.cancellingRunIds.includes(run.id)) return;
    this.error = undefined;
    this.cancellingRunIds = [...this.cancellingRunIds, run.id];
    try {
      await terminalsApi.cancelCommandRun(run.id, this.machineId);
      await this.loadCommandRuns();
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.cancellingRunIds = this.cancellingRunIds.filter((runId) => runId !== run.id);
    }
  }

  private async continueTerminal(id: string): Promise<void> {
    if (this.workspace === undefined || this.continuingTerminalIds.includes(id)) return;
    this.error = undefined;
    this.continuingTerminalIds = [...this.continuingTerminalIds, id];
    try {
      const terminal = await terminalsApi.continueTerminal(this.workspace.projectId, this.workspace.id, id, this.machineId);
      this.terminals = this.terminals.map((item) => item.id === id ? terminal : item);
      if (this.socket === undefined) this.disposeTerminalView();
      this.fitAndNotify();
      this.terminal?.focus();
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.continuingTerminalIds = this.continuingTerminalIds.filter((terminalId) => terminalId !== id);
    }
  }

  private ensureTerminalView(): void {
    const workspace = this.workspace;
    const terminalHost = this.terminalHostElement();
    if (!this.visible || this.terminal !== undefined || this.selectedId === undefined || terminalHost === undefined || workspace === undefined) return;
    const terminal = new Terminal(terminalOptions(this));
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(terminalHost);
    this.terminal = terminal;
    this.fitAddon = fitAddon;
    this.resizeObserver = new ResizeObserver(() => { this.fitAndNotify(); });
    this.resizeObserver.observe(terminalHost);
    terminal.onData((data) => {
      if (this.suppressTerminalInput) return;
      this.sendTerminalInput(data);
    });
    const initialSize = this.fitTerminal();
    this.connectSocket(workspace.projectId, workspace.id, this.selectedId, terminal, initialSize);
    requestAnimationFrame(() => { this.fitAndNotify(); });
    terminal.focus();
  }

  private connectSocket(projectId: string, workspaceId: string, terminalId: string, terminal: Terminal, initialSize: TerminalSize | undefined): void {
    const socket = terminalSocket(projectId, workspaceId, terminalId, initialSize, this.machineId);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    socket.addEventListener("open", () => { this.fitAndNotify(); });
    socket.addEventListener("message", (event) => {
      void this.handleSocketMessage(event.data, terminalId, terminal);
    });
    socket.addEventListener("close", () => {
      if (this.socket === socket) this.socket = undefined;
    });
  }

  private async handleSocketMessage(data: unknown, terminalId: string, terminal: Terminal): Promise<void> {
    try {
      const message = parseServerMessage(await socketDataToString(data));
      if (message.type === "output") {
        this.writeTerminalOutput(terminal, message.data, message.replay === true);
      }
      if (message.type === "exit") {
        terminal.writeln(`\r\n[process exited${message.exitCode === undefined ? "" : ` with code ${String(message.exitCode)}`}]`);
        this.terminals = this.terminals.map((item) => item.id === terminalId ? { ...item, exited: true, ...(message.exitCode === undefined ? {} : { exitCode: message.exitCode }) } : item);
        void this.loadCommandRuns();
      }
      if (message.type === "error") terminal.writeln(`\r\n[terminal error: ${message.message}]`);
    } catch (error) {
      terminal.writeln(`\r\n[terminal error: ${error instanceof Error ? error.message : String(error)}]`);
    }
  }

  private writeTerminalOutput(terminal: Terminal, data: string, replay: boolean): void {
    if (!replay) {
      terminal.write(data);
      return;
    }
    this.suppressTerminalInput = true;
    terminal.write(data, () => {
      this.suppressTerminalInput = false;
    });
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
    if (filtered !== "") this.send({ type: "input", data: filtered });
  }

  private sendSoftKeyInput(data: string, options: TerminalSoftKeyInputOptions): void {
    this.sendTerminalInput(data);
    if (options.refocus) this.focusTerminal();
  }

  private focusTerminal(): void {
    const terminal = this.terminal;
    if (terminal === undefined) return;
    terminal.focus();
    requestAnimationFrame(() => { terminal.focus(); });
  }

  private send(message: { type: "input"; data: string } | { type: "resize"; cols: number; rows: number }): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private disposeTerminalView(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    this.socket?.close();
    this.socket = undefined;
    this.terminal?.dispose();
    this.terminal = undefined;
    this.fitAddon = undefined;
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

  private selectedTerminalAcceptsInput(): boolean {
    const terminal = this.selectedTerminalInfo();
    return terminal !== undefined && !terminal.exited;
  }

  private shouldShowSoftKeys(): boolean {
    return this.selectedTerminalAcceptsInput() && this.softKeysEnabled;
  }

  private shouldShowSoftKeysToggle(): boolean {
    return this.selectedTerminalAcceptsInput();
  }

  private toggleSoftKeys(): void {
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
    return html`
      <terminal-soft-keys
        .modes=${this.terminal?.modes}
        .refocusOnClick=${!this.defaultSoftKeysEnvironment}
        .onInput=${(data: string, options: TerminalSoftKeyInputOptions) => { this.sendSoftKeyInput(data, options); }}
      ></terminal-soft-keys>
    `;
  }

  override render() {
    return html`
      <section class="terminal-shell">
        <div class="terminal-tabs">
          ${this.renderSoftKeysToggle()}
          ${this.terminals.map((terminal) => html`
            <button class=${this.selectedId === terminal.id ? "selected" : ""} @click=${() => { this.selectTerminal(terminal.id); }}>
              <span>${terminal.name}${terminal.exited ? " · exited" : ""}</span>
              <small @click=${(event: Event) => { void this.closeTerminal(terminal.id, event); }}>×</small>
            </button>
          `)}
          <button class="new" ?disabled=${this.workspace === undefined} @click=${() => { void this.startTerminal(); }}>+ Shell</button>
        </div>
        ${this.error === undefined ? null : html`<p class="error">${this.error}</p>`}
        ${this.renderCommandRunNotice()}
        ${this.shouldShowSoftKeys() ? this.renderSoftKeys() : null}
        ${this.loading ? html`<p class="muted">Loading terminals…</p>` : null}
        <div class="terminal-host"></div>
      </section>
    `;
  }

  static override styles = css`
    :host { flex: 1 1 auto; min-height: 0; display: flex; }
    .terminal-shell { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; overflow: hidden; background: var(--pi-terminal-bg); }
    .terminal-tabs { flex: 0 0 auto; display: flex; gap: 6px; align-items: center; padding: 6px; border-bottom: 1px solid var(--pi-border-muted); background: var(--pi-bg); overflow: auto; }
    button { display: inline-flex; align-items: center; gap: 6px; min-width: 0; max-width: 180px; border: 1px solid var(--pi-border); border-radius: 7px; background: var(--pi-surface); color: var(--pi-text); padding: 5px 7px; cursor: pointer; }
    button.selected { border-color: var(--pi-accent); background: var(--pi-selection-bg); }
    button.new { flex: 0 0 auto; color: var(--pi-muted); }
    .soft-keys-toggle { flex: 0 0 auto; }
    .soft-keys-toggle .keyboard-icon { flex: 0 0 auto; width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; pointer-events: none; }
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
    .terminal-host { flex: 1 1 auto; min-height: 0; padding: 6px; box-sizing: border-box; overflow: hidden; }
    .terminal-host .xterm { height: 100%; cursor: text; position: relative; user-select: none; }
    .terminal-host .xterm.focus, .terminal-host .xterm:focus { outline: none; }
    .terminal-host .xterm-helpers { position: absolute; top: 0; z-index: 5; }
    .terminal-host .xterm-helper-textarea { position: absolute !important; left: -9999em !important; top: 0 !important; width: 0 !important; height: 0 !important; min-width: 0 !important; min-height: 0 !important; padding: 0 !important; border: 0 !important; margin: 0 !important; opacity: 0 !important; z-index: -5 !important; white-space: nowrap !important; overflow: hidden !important; resize: none !important; outline: 0 !important; appearance: none !important; }
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
  `;
}

interface TerminalSize {
  cols: number;
  rows: number;
}

type ServerTerminalMessage =
  | { type: "output"; data: string; replay?: boolean }
  | { type: "exit"; exitCode?: number }
  | { type: "error"; message: string };

function isCommandRunPending(run: TerminalCommandRun): boolean {
  return run.status === "queued" || run.status === "running";
}

function commandRunCompletionLabel(run: TerminalCommandRun): string {
  if (run.status === "succeeded") return `Command succeeded${run.exitCode === undefined ? "" : ` with exit code ${String(run.exitCode)}`}`;
  return `Command failed${run.exitCode === undefined ? "" : ` with exit code ${String(run.exitCode)}`}`;
}

function parseServerMessage(data: string): ServerTerminalMessage {
  const value: unknown = JSON.parse(data);
  if (!isRecord(value)) return { type: "error", message: "Invalid terminal message" };
  const record = value;
  if (record["type"] === "output" && typeof record["data"] === "string") return { type: "output", data: record["data"], ...(typeof record["replay"] === "boolean" ? { replay: record["replay"] } : {}) };
  if (record["type"] === "exit") return { type: "exit", ...(typeof record["exitCode"] === "number" ? { exitCode: record["exitCode"] } : {}) };
  if (record["type"] === "error" && typeof record["message"] === "string") return { type: "error", message: record["message"] };
  return { type: "error", message: "Invalid terminal message" };
}

export function filterTerminalInput(data: string): string {
  // Xterm can emit focus-in/focus-out sequences when replayed output leaves focus
  // tracking enabled. Bash/readline treats those sequences as typed text, which
  // leaves stray characters on the prompt after reconnecting to an active shell.
  return data.replaceAll("\x1b[I", "").replaceAll("\x1b[O", "");
}

async function socketDataToString(data: unknown): Promise<string> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (data instanceof Blob) return await data.text();
  return String(data);
}

function terminalOptions(element: HTMLElement): ITerminalOptions {
  return { ...TERMINAL_OPTIONS_BASE, theme: terminalTheme(element) };
}

function terminalTheme(element: HTMLElement): ITheme {
  return {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
