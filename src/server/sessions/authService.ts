import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import type { AuthProvidersResponse, AuthType, OAuthFlowState } from "../../shared/apiTypes.js";
import { getLoginProviderOptions, getLogoutProviderOptions } from "./authProviderOptions.js";
import { OAuthLoginFlowService } from "./oauthLoginFlowService.js";

export interface AuthChange {
  removedProviderId?: string;
}

type AuthChangeListener = (change: AuthChange) => void | Promise<void>;

export interface AuthServiceDependencies {
  agentDir?: string;
  runtime?: ModelRuntime;
  authFlows?: OAuthLoginFlowService;
  logger?: AuthServiceLogger;
}

/** Minimal structured-logging seam for non-fatal auth propagation failures. */
export interface AuthServiceLogger {
  error(details: Record<string, unknown>, message: string): void;
}

interface AuthChangeContext {
  operation: "login" | "logout";
  providerId: string;
  authType?: AuthType;
}

const noopLogger: AuthServiceLogger = { error() { /* no-op */ } };

export function createModelRuntimeForAgentDir(agentDir: string, allowModelNetwork?: boolean): Promise<ModelRuntime> {
  return ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    ...(allowModelNetwork === undefined ? {} : { allowModelNetwork }),
  });
}

export class AuthService {
  readonly runtime: ModelRuntime;
  private readonly authFlows: OAuthLoginFlowService;
  private readonly logger: AuthServiceLogger;
  private readonly listeners = new Set<AuthChangeListener>();

  private constructor(runtime: ModelRuntime, authFlows: OAuthLoginFlowService, logger: AuthServiceLogger) {
    this.runtime = runtime;
    this.authFlows = authFlows;
    this.logger = logger;
  }

  static async create(deps: AuthServiceDependencies = {}): Promise<AuthService> {
    const runtime = deps.runtime ?? (deps.agentDir === undefined ? await ModelRuntime.create({}) : await createModelRuntimeForAgentDir(deps.agentDir));
    const logger = deps.logger ?? noopLogger;
    const authFlows = deps.authFlows ?? new OAuthLoginFlowService({ logger });
    return new AuthService(runtime, authFlows, logger);
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
    await this.runtime.reloadConfig();
    const providers = mode === "logout" ? await getLogoutProviderOptions(this.runtime) : getLoginProviderOptions(this.runtime, authType);
    return { providers };
  }

  async saveApiKey(providerId: string, key: string): Promise<{ accepted: true }> {
    if (key.trim() === "") throw new Error("API key is required");
    const provider = await this.requireApiKeyLoginProvider(providerId);
    let promptAttempted = false;
    const interaction: AuthInteraction = {
      prompt: (prompt) => {
        if (promptAttempted) {
          throw new Error(`${provider.name} requires interactive setup; use Pi's generic /login flow`);
        }
        promptAttempted = true;
        if (prompt.signal?.aborted === true) throw new Error("Login cancelled");
        if (prompt.type !== "secret") {
          throw new Error(`${provider.name} requires interactive setup; use Pi's generic /login flow`);
        }
        return Promise.resolve(key);
      },
      notify: () => undefined,
    };
    await this.runtime.login(providerId, "api_key", interaction);
    await this.emit({}, { operation: "login", providerId, authType: "api_key" });
    return { accepted: true };
  }

  async logoutProvider(providerId: string): Promise<{ accepted: true }> {
    await this.runtime.logout(providerId);
    await this.emit({ removedProviderId: providerId }, { operation: "logout", providerId });
    return { accepted: true };
  }

  async startApiKeyLogin(providerId: string): Promise<OAuthFlowState> {
    const provider = await this.requireApiKeyLoginProvider(providerId);
    return this.authFlows.start({
      providerId,
      providerName: provider.name,
      runtime: this.runtime,
      authType: "api_key",
      onComplete: () => this.emit({}, { operation: "login", providerId, authType: "api_key" }),
    });
  }

  async startOAuthLogin(providerId: string): Promise<OAuthFlowState> {
    const provider = await this.requireOAuthLoginProvider(providerId);
    return this.authFlows.start({
      providerId,
      providerName: provider.name,
      runtime: this.runtime,
      authType: "oauth",
      onComplete: () => this.emit({}, { operation: "login", providerId, authType: "oauth" }),
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

  private async emit(change: AuthChange, context: AuthChangeContext): Promise<void> {
    const results = await Promise.allSettled([...this.listeners].map(async (listener) => listener(change)));
    for (const result of results) {
      if (result.status === "rejected") {
        this.logErrorNoThrow({ err: result.reason, ...context }, "auth-change listener failed");
      }
    }
  }

  private logErrorNoThrow(details: Record<string, unknown>, message: string): void {
    try {
      this.logger.error(details, message);
    } catch {
      // A diagnostic failure cannot turn an already-committed auth mutation into an API failure.
    }
  }

  private async requireApiKeyLoginProvider(providerId: string) {
    await this.runtime.reloadConfig();
    const provider = getLoginProviderOptions(this.runtime, "api_key").find((option) => option.id === providerId);
    if (provider !== undefined) return provider;

    const knownProvider = this.runtime.getProviders().find((option) => option.id === providerId);
    if (knownProvider !== undefined) {
      throw new Error(`${knownProvider.name} does not support interactive API-key setup`);
    }
    throw new Error(`API key provider not found: ${providerId}`);
  }

  private async requireOAuthLoginProvider(providerId: string) {
    await this.runtime.reloadConfig();
    const provider = getLoginProviderOptions(this.runtime, "oauth").find((option) => option.id === providerId);
    if (provider === undefined) throw new Error(`OAuth provider not found: ${providerId}`);
    return provider;
  }
}
