import { api as defaultApi, type AuthProviderOption, type AuthType, type OAuthFlowState, type SessionStatus } from "../api";
import type { AuthDialogState } from "../appState";
import { selectedMachineId, type GetState, type SetState } from "./types";

type OAuthDialogState = Extract<AuthDialogState, { step: "oauth" }>;

export interface AuthControllerDependencies {
  api?: typeof defaultApi;
  pollIntervalMs?: number;
}

export class AuthController {
  private readonly api: typeof defaultApi;
  private readonly pollIntervalMs: number;
  private oauthOperationGeneration = 0;
  private pollGeneration = 0;
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
    this.oauthOperationGeneration += 1;
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
    if (provider.authType === "oauth" || provider.loginFlow === "interactive") await this.startLoginFlow(provider);
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
    const operationGeneration = this.oauthOperationGeneration;
    const flowId = dialog.flow.flowId;
    const requestId = request.requestId;
    const responseValue = value ?? dialog.inputValue ?? "";
    const clean = { ...dialog };
    delete clean.error;
    this.setState({ authDialog: { ...clean, responding: true } });
    try {
      const flow = await this.api.respondOAuthFlow(flowId, requestId, responseValue, selectedMachineId(this.getState()));
      const current = this.currentOAuthDialog(operationGeneration, flowId);
      if (flow.flowId !== flowId || current === undefined || oauthRequestId(current.flow) !== requestId) return;
      this.updateOAuthFlow(flow);
    } catch (error) {
      const current = this.currentOAuthDialog(operationGeneration, flowId);
      if (current === undefined || oauthRequestId(current.flow) !== requestId) return;
      this.setState({ authDialog: { ...current, responding: false, error: String(error) } });
    }
  }

  async cancelOAuth(): Promise<void> {
    const dialog = this.getState().authDialog;
    if (dialog?.step !== "oauth") {
      this.closeDialog();
      return;
    }
    const flowId = dialog.flow.flowId;
    const machineId = selectedMachineId(this.getState());
    this.closeDialog();
    try {
      await this.api.cancelOAuthFlow(flowId, machineId);
    } catch {
      // Best-effort cancel. The dialog is already closed either way.
    }
  }

  closeDialog(): void {
    this.oauthOperationGeneration += 1;
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
      if (provider.authType === "oauth" || provider.loginFlow === "interactive") await this.startLoginFlow(provider);
      else this.setState({ authDialog: { step: "apiKey", provider, value: "" } });
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  private async startLoginFlow(provider: AuthProviderOption): Promise<void> {
    if (this.rejectRemoteOAuth("login", provider)) return;
    const operationGeneration = ++this.oauthOperationGeneration;
    this.stopPolling();
    try {
      const machineId = selectedMachineId(this.getState());
      const flow = provider.authType === "oauth"
        ? await this.api.startOAuthLogin(provider.id, machineId)
        : await this.api.startInteractiveApiKeyLogin(provider.id, machineId);
      if (operationGeneration !== this.oauthOperationGeneration) return;
      this.updateOAuthFlow(flow);
      if (flow.status === "running") this.startPolling(flow.flowId);
    } catch (error) {
      if (operationGeneration === this.oauthOperationGeneration) this.setState({ error: String(error) });
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
    if (flow.status === "error" || flow.status === "cancelled") {
      this.oauthOperationGeneration += 1;
      this.stopPolling();
    }
    const existing = this.getState().authDialog;
    const previousInput = existing?.step === "oauth" && existing.flow.flowId === flow.flowId ? existing.inputValue ?? "" : "";
    const previousRequestId = existing?.step === "oauth" ? oauthRequestId(existing.flow) : undefined;
    const newRequestId = oauthRequestId(flow);
    const sameRequest = previousRequestId !== undefined && previousRequestId === newRequestId;
    const inputValue = sameRequest ? previousInput : "";
    const responding = sameRequest && existing?.step === "oauth" ? existing.responding === true : false;
    this.setState({ authDialog: { step: "oauth", flow, inputValue, responding } });
  }

  private startPolling(flowId: string): void {
    this.stopPolling();
    const operationGeneration = this.oauthOperationGeneration;
    const pollGeneration = this.pollGeneration;
    this.pollTimer = window.setInterval(() => { void this.poll(flowId, operationGeneration, pollGeneration); }, this.pollIntervalMs);
  }

  private stopPolling(): void {
    this.pollGeneration += 1;
    if (this.pollTimer === undefined) return;
    window.clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  private async poll(flowId: string, operationGeneration: number, pollGeneration: number): Promise<void> {
    if (pollGeneration !== this.pollGeneration) return;
    const dialog = this.currentOAuthDialog(operationGeneration, flowId);
    if (dialog === undefined) {
      this.stopPolling();
      return;
    }
    const requestId = oauthRequestId(dialog.flow);
    try {
      const flow = await this.api.oauthFlow(flowId, selectedMachineId(this.getState()));
      const current = this.currentOAuthDialog(operationGeneration, flowId);
      if (flow.flowId !== flowId || pollGeneration !== this.pollGeneration || current === undefined || oauthRequestId(current.flow) !== requestId) return;
      this.updateOAuthFlow(flow);
    } catch (error) {
      const current = this.currentOAuthDialog(operationGeneration, flowId);
      if (pollGeneration !== this.pollGeneration || current === undefined || oauthRequestId(current.flow) !== requestId) return;
      this.stopPolling();
      this.setState({ authDialog: { ...current, error: String(error) } });
    }
  }

  private currentOAuthDialog(operationGeneration: number, flowId: string): OAuthDialogState | undefined {
    if (operationGeneration !== this.oauthOperationGeneration) return undefined;
    const dialog = this.getState().authDialog;
    return dialog?.step === "oauth" && dialog.flow.flowId === flowId ? dialog : undefined;
  }

  private async refreshStatus(): Promise<void> {
    const session = this.session();
    if (session === undefined) return;
    try {
      this.applyStatus(await this.api.status(session, selectedMachineId(this.getState())));
    } catch {
      // Status refresh is opportunistic after login completes.
    }
  }

  private session() {
    const session = this.getState().selectedSession;
    if (session === undefined || session.archived === true) return undefined;
    return session;
  }
}

function oauthRequestId(flow: OAuthFlowState): string | undefined {
  return flow.prompt?.requestId ?? flow.select?.requestId;
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
