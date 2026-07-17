import { join } from "node:path";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AuthProvidersResponse, AuthType, OAuthFlowState } from "../../shared/apiTypes.js";
import { getLoginProviderOptions, getLogoutProviderOptions, type AuthProviderModelRuntime } from "./authProviderOptions.js";
import { OAuthLoginFlowService } from "./oauthLoginFlowService.js";

export interface AuthChange {
  removedProviderId?: string;
}

type AuthChangeListener = (change: AuthChange) => void | Promise<void>;

export interface AuthModelRuntime extends AuthProviderModelRuntime {
  login(providerId: string, authType: AuthType, interaction: AuthInteraction): Promise<unknown>;
  logout(providerId: string): Promise<void>;
}

export interface AuthServiceDependencies {
  modelRuntime: AuthModelRuntime;
  authFlows?: OAuthLoginFlowService;
}

export function createModelRuntimeForAgentDir(agentDir: string, allowModelNetwork = true): Promise<ModelRuntime> {
  return ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    allowModelNetwork,
  });
}

export class AuthService {
  readonly modelRuntime: AuthModelRuntime;
  private readonly authFlows: OAuthLoginFlowService;
  private readonly listeners = new Set<AuthChangeListener>();

  constructor(deps: AuthServiceDependencies) {
    this.modelRuntime = deps.modelRuntime;
    this.authFlows = deps.authFlows ?? new OAuthLoginFlowService();
  }

  subscribe(listener: AuthChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    this.authFlows.dispose();
    this.listeners.clear();
  }

  async authProviders(mode: "login" | "logout", authType?: AuthType): Promise<AuthProvidersResponse> {
    const providers = mode === "logout"
      ? await getLogoutProviderOptions(this.modelRuntime)
      : getLoginProviderOptions(this.modelRuntime, authType);
    return { providers };
  }

  async saveApiKey(providerId: string, key: string): Promise<{ accepted: true }> {
    if (key.trim() === "") throw new Error("API key is required");
    const provider = this.requireLoginProvider(providerId, "api_key");
    let promptHandled = false;
    const interaction: AuthInteraction = {
      prompt: (prompt) => {
        if (prompt.signal?.aborted === true) throw new Error("Login cancelled");
        if (promptHandled || prompt.type !== "secret") {
          throw new Error(`${provider.name} requires interactive setup; use Pi's /login command`);
        }
        promptHandled = true;
        return Promise.resolve(key);
      },
      notify() {
        // The existing API-key endpoint is intentionally one-shot. Providers
        // requiring richer interactions are rejected above and remain available
        // through Pi's generic login command.
      },
    };
    await this.modelRuntime.login(providerId, "api_key", interaction);
    await this.emit({});
    return { accepted: true };
  }

  async logoutProvider(providerId: string): Promise<{ accepted: true }> {
    await this.modelRuntime.logout(providerId);
    await this.emit({ removedProviderId: providerId });
    return { accepted: true };
  }

  startOAuthLogin(providerId: string): OAuthFlowState {
    const provider = this.requireLoginProvider(providerId, "oauth");
    return this.authFlows.start({
      providerId,
      providerName: provider.name,
      login: (interaction) => this.modelRuntime.login(providerId, "oauth", interaction),
      onComplete: () => this.emit({}),
    });
  }

  oauthFlow(flowId: string): OAuthFlowState {
    return this.authFlows.get(flowId);
  }

  respondToOAuthFlow(flowId: string, requestId: string, value: string): OAuthFlowState {
    return this.authFlows.respond(flowId, requestId, value);
  }

  cancelOAuthFlow(flowId: string): OAuthFlowState {
    return this.authFlows.cancel(flowId);
  }

  private async emit(change: AuthChange): Promise<void> {
    await Promise.all([...this.listeners].map((listener) => Promise.resolve(listener(change))));
  }

  private requireLoginProvider(providerId: string, authType: AuthType) {
    const provider = getLoginProviderOptions(this.modelRuntime, authType).find((option) => option.id === providerId);
    if (provider === undefined) {
      const label = authType === "oauth" ? "OAuth" : "API key";
      throw new Error(`${label} provider not found: ${providerId}`);
    }
    return provider;
  }
}
