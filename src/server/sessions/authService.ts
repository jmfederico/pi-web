import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import type { AuthProvidersResponse, AuthType, OAuthFlowState } from "../../shared/apiTypes.js";
import { getLoginProviderOptions, getLogoutProviderOptions } from "./authProviderOptions.js";
import { OAuthLoginFlowService } from "./oauthLoginFlowService.js";

export interface AuthChange {
  removedProviderId?: string;
}

type AuthChangeListener = (change: AuthChange) => void;

export interface AuthServiceDependencies {
  agentDir?: string;
  runtime?: ModelRuntime;
  authFlows?: OAuthLoginFlowService;
}

export function createModelRuntimeForAgentDir(agentDir: string): Promise<ModelRuntime> {
  return ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
}

export class AuthService {
  readonly runtime: ModelRuntime;
  private readonly authFlows: OAuthLoginFlowService;
  private readonly listeners = new Set<AuthChangeListener>();

  private constructor(runtime: ModelRuntime, authFlows: OAuthLoginFlowService) {
    this.runtime = runtime;
    this.authFlows = authFlows;
  }

  static async create(deps: AuthServiceDependencies = {}): Promise<AuthService> {
    const runtime = deps.runtime ?? (deps.agentDir === undefined ? await ModelRuntime.create({}) : await createModelRuntimeForAgentDir(deps.agentDir));
    const authFlows = deps.authFlows ?? new OAuthLoginFlowService();
    return new AuthService(runtime, authFlows);
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
    await this.runtime.refresh();
    const providers = mode === "logout" ? await getLogoutProviderOptions(this.runtime) : await getLoginProviderOptions(this.runtime, authType);
    return { providers };
  }

  async saveApiKey(providerId: string, key: string): Promise<{ accepted: true }> {
    if (key.trim() === "") throw new Error("API key is required");
    // The provider's api-key login prompts for the key and persists the returned
    // credential through the runtime's credential store; feed the key back via a
    // non-interactive AuthInteraction.
    const interaction: AuthInteraction = {
      prompt: async () => key,
      notify: () => {},
    };
    await this.runtime.login(providerId, "api_key", interaction);
    await this.refreshAuthState();
    return { accepted: true };
  }

  async logoutProvider(providerId: string): Promise<{ accepted: true }> {
    await this.runtime.logout(providerId);
    await this.refreshAuthState({ removedProviderId: providerId });
    return { accepted: true };
  }

  async startOAuthLogin(providerId: string): Promise<OAuthFlowState> {
    const provider = await this.requireOAuthLoginProvider(providerId);
    return this.authFlows.start({
      providerId,
      providerName: provider.name,
      runtime: this.runtime,
      onComplete: () => {
        void this.refreshAuthState();
      },
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

  private async refreshAuthState(change: AuthChange = {}): Promise<void> {
    await this.runtime.refresh();
    this.emit(change);
  }

  private emit(change: AuthChange): void {
    for (const listener of this.listeners) listener(change);
  }

  private async requireOAuthLoginProvider(providerId: string) {
    await this.runtime.refresh();
    const provider = (await getLoginProviderOptions(this.runtime, "oauth")).find((option) => option.id === providerId);
    if (provider === undefined) throw new Error(`OAuth provider not found: ${providerId}`);
    return provider;
  }
}
