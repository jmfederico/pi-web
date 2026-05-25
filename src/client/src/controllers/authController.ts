import { api as defaultApi, type AuthProviderOption, type AuthType, type OAuthFlowState, type SessionStatus } from "../api";
import { selectedMachineId, type GetState, type SetState } from "./types";

export interface AuthControllerDependencies {
  api?: typeof defaultApi;
  pollIntervalMs?: number;
}

export class AuthController {
  private readonly api: typeof defaultApi;
  private readonly pollIntervalMs: number;
  private pollTimer: number | undefined;

  constructor(
    private readonly getState: GetState,
    private readonly setState: SetState,
    private readonly applyStatus: (status: SessionStatus) => void,
    deps: AuthControllerDependencies = {},
  ) {
    this.api = deps.api ?? defaultApi;
    this.pollIntervalMs = deps.pollIntervalMs ?? 1000;
  }

  dispose(): void {
    this.stopPolling();
  }

  handleSlashCommand(text: string): boolean {
    const parsed = parseAuthSlashCommand(text);
    if (parsed === undefined) return false;
    if (parsed.command === "login") void this.openLogin(parsed.providerId);
    else void this.openLogout(parsed.providerId);
    return true;
  }

  async openLogin(providerId?: string): Promise<void> {
    if (providerId !== undefined && providerId !== "") {
      await this.openLoginProvider(providerId);
      return;
    }
    this.setState({ authDialog: { step: "method" } });
  }

  async chooseLoginMethod(authType: AuthType): Promise<void> {
    try {
      const { providers } = await this.api.authProviders({ mode: "login", authType, machineId: selectedMachineId(this.getState()) });
      this.setState({ authDialog: { step: "providers", mode: "login", authType, providers } });
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  async selectLoginProvider(providerId: string, authType?: AuthType): Promise<void> {
    const dialog = this.getState().authDialog;
    if (dialog?.step !== "providers") return;
    const provider = dialog.providers.find((candidate) => candidate.id === providerId && (authType === undefined || candidate.authType === authType));
    if (provider === undefined) return;
    if (provider.authType === "oauth") await this.startOAuth(provider);
    else this.setState({ authDialog: { step: "apiKey", provider, value: "" } });
  }

  updateApiKey(value: string): void {
    const dialog = this.getState().authDialog;
    if (dialog?.step !== "apiKey") return;
    const clean = { ...dialog };
    delete clean.error;
    this.setState({ authDialog: { ...clean, value } });
  }

  async saveApiKey(): Promise<void> {
    const dialog = this.getState().authDialog;
    if (dialog?.step !== "apiKey") return;
    const key = dialog.value.trim();
    if (key === "") {
      this.setState({ authDialog: { ...dialog, error: "API key is required" } });
      return;
    }
    const clean = { ...dialog };
    delete clean.error;
    this.setState({ authDialog: { ...clean, saving: true } });
    try {
      await this.api.saveApiKey(dialog.provider.id, key, selectedMachineId(this.getState()));
      this.closeDialog();
      void this.refreshStatus();
    } catch (error) {
      this.setState({ authDialog: { ...dialog, saving: false, error: String(error) } });
    }
  }

  async openLogout(providerId?: string): Promise<void> {
    try {
      const { providers } = await this.api.authProviders({ mode: "logout", machineId: selectedMachineId(this.getState()) });
      if (providerId !== undefined && providerId !== "") {
        const provider = providers.find((candidate) => candidate.id === providerId);
        if (provider !== undefined && !this.rejectRemoteOAuth("logout", provider)) await this.logoutProvider(provider.id);
        else if (provider === undefined) this.setState({ error: `No stored credentials for ${providerId}` });
        return;
      }
      this.setState({ authDialog: { step: "logout", providers } });
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  async logoutProvider(providerId: string): Promise<void> {
    const dialog = this.getState().authDialog;
    const provider = dialog?.step === "logout" ? dialog.providers.find((candidate) => candidate.id === providerId) : undefined;
    if (provider !== undefined && this.rejectRemoteOAuth("logout", provider)) return;
    try {
      await this.api.logoutProvider(providerId, selectedMachineId(this.getState()));
      this.closeDialog();
      void this.refreshStatus();
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  updateOAuthInput(value: string): void {
    const dialog = this.getState().authDialog;
    if (dialog?.step !== "oauth") return;
    const clean = { ...dialog };
    delete clean.error;
    this.setState({ authDialog: { ...clean, inputValue: value } });
  }

  async respondOAuth(value?: string): Promise<void> {
    const dialog = this.getState().authDialog;
    if (dialog?.step !== "oauth") return;
    const request = dialog.flow.prompt ?? dialog.flow.select;
    if (request === undefined) return;
    const responseValue = value ?? dialog.inputValue ?? "";
    const clean = { ...dialog };
    delete clean.error;
    this.setState({ authDialog: { ...clean, responding: true } });
    try {
      const flow = await this.api.respondOAuthFlow(dialog.flow.flowId, request.requestId, responseValue, selectedMachineId(this.getState()));
      this.updateOAuthFlow(flow);
    } catch (error) {
      this.setState({ authDialog: { ...dialog, responding: false, error: String(error) } });
    }
  }

  async cancelOAuth(): Promise<void> {
    const dialog = this.getState().authDialog;
    if (dialog?.step !== "oauth") {
      this.closeDialog();
      return;
    }
    this.stopPolling();
    try {
      await this.api.cancelOAuthFlow(dialog.flow.flowId, selectedMachineId(this.getState()));
    } catch {
      // Best-effort cancel. The dialog closes either way.
    }
    this.closeDialog();
  }

  closeDialog(): void {
    this.stopPolling();
    this.setState({ authDialog: undefined });
  }

  private async openLoginProvider(providerId: string): Promise<void> {
    try {
      const { providers } = await this.api.authProviders({ mode: "login", machineId: selectedMachineId(this.getState()) });
      const exact = providers.filter((provider) => provider.id === providerId);
      if (exact.length === 0) {
        this.setState({ error: `Auth provider not found: ${providerId}` });
        return;
      }
      if (exact.length > 1) {
        this.setState({ authDialog: { step: "providers", mode: "login", providers: exact } });
        return;
      }
      const provider = exact[0];
      if (provider === undefined) return;
      if (provider.authType === "oauth") await this.startOAuth(provider);
      else this.setState({ authDialog: { step: "apiKey", provider, value: "" } });
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  private async startOAuth(provider: AuthProviderOption): Promise<void> {
    if (this.rejectRemoteOAuth("login", provider)) return;
    try {
      const flow = await this.api.startOAuthLogin(provider.id, selectedMachineId(this.getState()));
      this.updateOAuthFlow(flow);
      this.startPolling(flow.flowId);
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  private rejectRemoteOAuth(action: "login" | "logout", provider: AuthProviderOption): boolean {
    const machine = this.getState().selectedMachine;
    if (provider.authType !== "oauth" || machine?.kind !== "remote") return false;
    const where = machine.baseUrl ?? "that remote PI WEB instance";
    this.setState({ error: `OAuth ${action} for remote machines must be configured directly on ${where}.` });
    return true;
  }

  private updateOAuthFlow(flow: OAuthFlowState): void {
    if (flow.status === "complete") {
      this.stopPolling();
      this.closeDialog();
      void this.refreshStatus();
      return;
    }
    if (flow.status === "error" || flow.status === "cancelled") this.stopPolling();
    const existing = this.getState().authDialog;
    const previousInput = existing?.step === "oauth" && existing.flow.flowId === flow.flowId ? existing.inputValue ?? "" : "";
    const previousRequestId = existing?.step === "oauth" ? existing.flow.prompt?.requestId ?? existing.flow.select?.requestId : undefined;
    const newRequestId = flow.prompt?.requestId ?? flow.select?.requestId;
    const sameRequest = previousRequestId !== undefined && previousRequestId === newRequestId;
    const inputValue = sameRequest ? previousInput : "";
    const responding = sameRequest && existing?.step === "oauth" ? existing.responding === true : false;
    this.setState({ authDialog: { step: "oauth", flow, inputValue, responding } });
  }

  private startPolling(flowId: string): void {
    this.stopPolling();
    this.pollTimer = window.setInterval(() => { void this.poll(flowId); }, this.pollIntervalMs);
  }

  private stopPolling(): void {
    if (this.pollTimer === undefined) return;
    window.clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  private async poll(flowId: string): Promise<void> {
    const dialog = this.getState().authDialog;
    if (dialog?.step !== "oauth" || dialog.flow.flowId !== flowId) {
      this.stopPolling();
      return;
    }
    try {
      this.updateOAuthFlow(await this.api.oauthFlow(flowId, selectedMachineId(this.getState())));
    } catch (error) {
      this.stopPolling();
      this.setState({ authDialog: { ...dialog, error: String(error) } });
    }
  }

  private async refreshStatus(): Promise<void> {
    const sessionId = this.sessionId();
    if (sessionId === undefined) return;
    try {
      this.applyStatus(await this.api.status(sessionId, selectedMachineId(this.getState())));
    } catch {
      // Status refresh is opportunistic after login completes.
    }
  }

  private sessionId(): string | undefined {
    const session = this.getState().selectedSession;
    if (session === undefined || session.archived === true) return undefined;
    return session.id;
  }
}

export function parseAuthSlashCommand(text: string): { command: "login" | "logout"; providerId?: string } | undefined {
  const trimmed = text.trim();
  const match = /^\/(login|logout)(?:\s+(\S+))?\s*$/u.exec(trimmed);
  if (match === null) return undefined;
  const command = match[1];
  if (command !== "login" && command !== "logout") return undefined;
  const providerId = match[2];
  return providerId === undefined || providerId === "" ? { command } : { command, providerId };
}

export type { AuthDialogState } from "../appState";
