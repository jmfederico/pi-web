import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AuthInteraction, CredentialStore, Provider } from "@earendil-works/pi-ai";
import type { AuthProviderOption, AuthProvidersResponse, AuthType, OAuthFlowState } from "../../shared/apiTypes.js";
import { getLoginProviderOptions, getLogoutProviderOptions } from "./authProviderOptions.js";
import { OAuthLoginFlowService } from "./oauthLoginFlowService.js";
import type {
  SessionAuthRuntimeRegistry,
  SessionAuthRuntimeTarget,
  SessionAuthTarget,
} from "./sessionAuthRuntimeRegistry.js";

export interface AuthChange {
  removedProviderId?: string;
}

type AuthChangeListener = (change: AuthChange) => void | Promise<void>;

export interface AuthServiceDependencies {
  agentDir?: string;
  credentials?: CredentialStore;
  runtime?: ModelRuntime;
  authRuntimeRegistry?: SessionAuthRuntimeRegistry;
  authFlows?: OAuthLoginFlowService;
  logger?: AuthServiceLogger;
  /** Test seams for bounded opaque provider references. */
  now?: () => number;
  providerReferenceTtlMs?: number;
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

interface ProviderReferenceRecord {
  providerRef: string;
  providerId: string;
  authType: AuthType;
  runtime: ModelRuntime;
  provider: Provider;
  expiresAt: number;
  target?: SessionAuthRuntimeTarget;
}

interface ResolvedLoginProvider {
  runtime: ModelRuntime;
  provider: Provider;
  target?: SessionAuthRuntimeTarget;
}

const DEFAULT_PROVIDER_REFERENCE_TTL_MS = 5 * 60 * 1000;
const MAX_PROVIDER_REFERENCES = 512;
const noopLogger: AuthServiceLogger = { error() { /* no-op */ } };

export function createModelRuntimeForAgentDir(
  agentDir: string,
  credentials: CredentialStore,
  allowModelNetwork?: boolean,
): Promise<ModelRuntime> {
  return ModelRuntime.create({
    credentials,
    modelsPath: join(agentDir, "models.json"),
    ...(allowModelNetwork === undefined ? {} : { allowModelNetwork }),
  });
}

export class AuthService {
  readonly runtime: ModelRuntime;
  private readonly authFlows: OAuthLoginFlowService;
  private readonly authRuntimeRegistry: SessionAuthRuntimeRegistry | undefined;
  private readonly logger: AuthServiceLogger;
  private readonly listeners = new Set<AuthChangeListener>();
  private readonly providerReferences = new Map<string, ProviderReferenceRecord>();
  private readonly now: () => number;
  private readonly providerReferenceTtlMs: number;
  private readonly unsubscribeRuntimeInvalidation: () => void;

  private constructor(
    runtime: ModelRuntime,
    authFlows: OAuthLoginFlowService,
    authRuntimeRegistry: SessionAuthRuntimeRegistry | undefined,
    logger: AuthServiceLogger,
    now: () => number,
    providerReferenceTtlMs: number,
  ) {
    this.runtime = runtime;
    this.authFlows = authFlows;
    this.authRuntimeRegistry = authRuntimeRegistry;
    this.logger = logger;
    this.now = now;
    this.providerReferenceTtlMs = providerReferenceTtlMs;
    this.unsubscribeRuntimeInvalidation = authRuntimeRegistry?.subscribeInvalidation((generationId) => {
      this.invalidateGeneration(generationId);
    }) ?? (() => undefined);
  }

  static async create(deps: AuthServiceDependencies): Promise<AuthService> {
    let runtime = deps.runtime;
    if (runtime === undefined) {
      if (deps.agentDir === undefined || deps.credentials === undefined) {
        throw new Error("AuthService requires an injected runtime or profile credential store");
      }
      runtime = await createModelRuntimeForAgentDir(deps.agentDir, deps.credentials);
    }
    const logger = deps.logger ?? noopLogger;
    const authFlows = deps.authFlows ?? new OAuthLoginFlowService({ logger });
    return new AuthService(
      runtime,
      authFlows,
      deps.authRuntimeRegistry,
      logger,
      deps.now ?? (() => Date.now()),
      Math.max(1, deps.providerReferenceTtlMs ?? DEFAULT_PROVIDER_REFERENCE_TTL_MS),
    );
  }

  subscribe(listener: AuthChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    this.unsubscribeRuntimeInvalidation();
    this.authFlows.dispose();
    this.providerReferences.clear();
    this.listeners.clear();
  }

  async authProviders(
    mode: "login" | "logout",
    authType?: AuthType,
    target?: SessionAuthTarget,
  ): Promise<AuthProvidersResponse> {
    // Logout is profile-global because public credentials are keyed only by
    // provider id. Targeting applies to discovery/login definitions.
    const runtimeTarget = mode === "login" && target !== undefined
      ? this.requireRuntimeTarget(target)
      : undefined;
    const runtime = runtimeTarget?.runtime ?? this.runtime;
    await runtime.reloadConfig();
    const providers = mode === "logout"
      ? await getLogoutProviderOptions(runtime)
      : getLoginProviderOptions(runtime, authType).map((option) => this.bindProviderReference(runtime, option, runtimeTarget));
    return { providers };
  }

  async saveApiKey(providerId: string, key: string, providerRef?: string): Promise<{ accepted: true }> {
    if (key.trim() === "") throw new Error("API key is required");
    const resolved = await this.requireApiKeyLoginProvider(providerId, providerRef);
    const { provider } = resolved;
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
    await this.runLogin(resolved, providerId, "api_key", interaction);
    await this.emit({}, { operation: "login", providerId, authType: "api_key" });
    return { accepted: true };
  }

  async logoutProvider(providerId: string): Promise<{ accepted: true }> {
    await this.runtime.logout(providerId);
    await this.emit({ removedProviderId: providerId }, { operation: "logout", providerId });
    return { accepted: true };
  }

  async startApiKeyLogin(providerId: string, providerRef?: string): Promise<OAuthFlowState> {
    const resolved = await this.requireApiKeyLoginProvider(providerId, providerRef);
    return this.authFlows.start({
      providerId,
      providerName: resolved.provider.name,
      runtime: resolved.target === undefined ? resolved.runtime : this.loginRuntime(resolved),
      authType: "api_key",
      ...(resolved.target === undefined ? {} : { owner: resolved.target.generationId }),
      onComplete: () => this.emit({}, { operation: "login", providerId, authType: "api_key" }),
    });
  }

  async startOAuthLogin(providerId: string, providerRef?: string): Promise<OAuthFlowState> {
    const resolved = await this.requireOAuthLoginProvider(providerId, providerRef);
    return this.authFlows.start({
      providerId,
      providerName: resolved.provider.name,
      runtime: resolved.target === undefined ? resolved.runtime : this.loginRuntime(resolved),
      authType: "oauth",
      ...(resolved.target === undefined ? {} : { owner: resolved.target.generationId }),
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

  private requireRuntimeTarget(target: SessionAuthTarget): SessionAuthRuntimeTarget {
    const resolved = this.authRuntimeRegistry?.resolveTarget(target);
    if (resolved === undefined) throw new Error("Target session auth runtime is no longer active");
    return resolved;
  }

  private bindProviderReference(
    runtime: ModelRuntime,
    option: AuthProviderOption,
    target: SessionAuthRuntimeTarget | undefined,
  ): AuthProviderOption {
    const provider = runtime.getProviders().find((candidate) => candidate.id === option.id);
    if (provider === undefined) return option;
    this.purgeProviderReferences();
    while (this.providerReferences.size >= MAX_PROVIDER_REFERENCES) {
      const oldest = this.providerReferences.keys().next().value;
      if (oldest === undefined) break;
      this.providerReferences.delete(oldest);
    }
    const providerRef = randomUUID();
    this.providerReferences.set(providerRef, {
      providerRef,
      providerId: option.id,
      authType: option.authType,
      runtime,
      provider,
      expiresAt: this.now() + this.providerReferenceTtlMs,
      ...(target === undefined ? {} : { target }),
    });
    return { ...option, providerRef };
  }

  private consumeProviderReference(
    providerRef: string,
    providerId: string,
    authType: AuthType,
  ): ResolvedLoginProvider {
    const reference = this.providerReferences.get(providerRef);
    this.providerReferences.delete(providerRef);
    if (reference === undefined || reference.expiresAt <= this.now()) throw new Error("Auth provider reference expired");
    if (reference.providerId !== providerId || reference.authType !== authType) throw new Error("Auth provider reference does not match the requested provider");
    if (reference.target !== undefined && this.authRuntimeRegistry?.isCurrentGeneration(reference.target) !== true) {
      throw new Error("Auth provider reference is no longer active");
    }
    const currentProvider = reference.runtime.getProviders().find((provider) => provider.id === providerId);
    if (currentProvider !== reference.provider) throw new Error("Auth provider definition changed; choose the provider again");
    return {
      runtime: reference.runtime,
      provider: reference.provider,
      ...(reference.target === undefined ? {} : { target: reference.target }),
    };
  }

  private runLogin(
    resolved: ResolvedLoginProvider,
    providerId: string,
    authType: AuthType,
    interaction: AuthInteraction,
  ) {
    const login = () => resolved.runtime.login(providerId, authType, interaction);
    return resolved.target === undefined
      ? login()
      : this.authRuntimeRegistry?.runInGeneration(resolved.target, login)
        ?? Promise.reject(new Error("Target session auth runtime is no longer active"));
  }

  private loginRuntime(resolved: ResolvedLoginProvider): Pick<ModelRuntime, "login"> {
    return {
      login: (providerId, authType, interaction) => this.runLogin(resolved, providerId, authType, interaction),
    };
  }

  private async requireApiKeyLoginProvider(providerId: string, providerRef?: string): Promise<ResolvedLoginProvider> {
    if (providerRef !== undefined) {
      const resolved = this.consumeProviderReference(providerRef, providerId, "api_key");
      if (resolved.provider.auth.apiKey?.login !== undefined) return resolved;
      throw new Error(`${resolved.provider.name} does not support interactive API-key setup`);
    }

    // Rolling compatibility: an older browser sends only providerId and can
    // reach profile/base providers, never a cwd aggregate chosen by open order.
    await this.runtime.reloadConfig();
    const provider = getLoginProviderOptions(this.runtime, "api_key").find((option) => option.id === providerId);
    const definition = this.runtime.getProviders().find((option) => option.id === providerId);
    if (provider !== undefined && definition !== undefined) return { runtime: this.runtime, provider: definition };
    if (definition !== undefined) {
      throw new Error(`${definition.name} does not support interactive API-key setup`);
    }
    throw new Error(`API key provider not found: ${providerId}`);
  }

  private async requireOAuthLoginProvider(providerId: string, providerRef?: string): Promise<ResolvedLoginProvider> {
    if (providerRef !== undefined) {
      const resolved = this.consumeProviderReference(providerRef, providerId, "oauth");
      if (resolved.provider.auth.oauth !== undefined) return resolved;
      throw new Error(`OAuth provider not found: ${providerId}`);
    }

    await this.runtime.reloadConfig();
    const provider = getLoginProviderOptions(this.runtime, "oauth").find((option) => option.id === providerId);
    const definition = this.runtime.getProviders().find((option) => option.id === providerId);
    if (provider === undefined || definition === undefined) throw new Error(`OAuth provider not found: ${providerId}`);
    return { runtime: this.runtime, provider: definition };
  }

  private invalidateGeneration(generationId: string): void {
    for (const [providerRef, reference] of this.providerReferences) {
      if (reference.target?.generationId === generationId) this.providerReferences.delete(providerRef);
    }
    this.authFlows.invalidateOwner(generationId);
  }

  private purgeProviderReferences(): void {
    const now = this.now();
    for (const [providerRef, reference] of this.providerReferences) {
      if (reference.expiresAt <= now) this.providerReferences.delete(providerRef);
    }
  }
}
