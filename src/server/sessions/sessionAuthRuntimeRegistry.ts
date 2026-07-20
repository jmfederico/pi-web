import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { canonicalizeStoredCwd } from "../workingDirectory.js";
import type { ProfileCredentialMutationGuardStore } from "./profileCredentialStore.js";

export interface SessionAuthTarget {
  sessionId: string;
  cwd: string;
}

export interface SessionAuthRuntimeTarget extends SessionAuthTarget {
  generationId: string;
  runtime: ModelRuntime;
}

export interface SessionAuthCredentialScope {
  credentials: CredentialStore;
  bindRuntime(runtime: ModelRuntime): void;
  abandon(): void;
}

type GenerationInvalidationListener = (generationId: string) => void;

interface RuntimeAuthOperationContext {
  scopeId: string;
  generationId: string;
}

interface RuntimeCredentialScope {
  readonly id: string;
  readonly cwd: string;
  runtime?: ModelRuntime;
  extensionProviderIds: Set<string>;
  activation?: SessionAuthRuntimeTarget;
  disposed: boolean;
}

/**
 * Raised when a cwd runtime tries to use a profile credential whose extension
 * provider definition is ambiguous across live workspace scopes.
 */
export class AmbiguousSessionProviderCredentialError extends Error {
  constructor(readonly providerId: string) {
    super(`Stored profile credentials for provider "${providerId}" are disabled because extension providers with that ID are active in multiple workspaces`);
    this.name = "AmbiguousSessionProviderCredentialError";
  }
}

/** Raised when an invalidated runtime generation attempts a credential write. */
export class StaleSessionAuthRuntimeError extends Error {
  constructor() {
    super("The session auth runtime is no longer active");
    this.name = "StaleSessionAuthRuntimeError";
  }
}

/**
 * Owns the daemon's cwd credential scopes and exact active runtime generations.
 *
 * Credential scopes live for one ModelRuntime lifetime. Provider generations
 * can rotate within that lifetime for an explicit resource reload, allowing
 * stale provider references/flows to be invalidated without replacing auth
 * storage or guessing provider registration ownership.
 */
export class SessionAuthRuntimeRegistry {
  private readonly scopes = new Set<RuntimeCredentialScope>();
  private readonly scopesByRuntime = new WeakMap<ModelRuntime, RuntimeCredentialScope>();
  private readonly activeByIdentity = new Map<string, RuntimeCredentialScope>();
  private readonly invalidationListeners = new Set<GenerationInvalidationListener>();
  private readonly authOperationContext = new AsyncLocalStorage<RuntimeAuthOperationContext>();

  constructor(private readonly profileCredentials: CredentialStore) {}

  createCredentialScope(cwd: string): SessionAuthCredentialScope {
    const scope: RuntimeCredentialScope = {
      id: randomUUID(),
      cwd: canonicalizeStoredCwd(cwd),
      extensionProviderIds: new Set(),
      disposed: false,
    };
    const credentials = new ScopedSessionCredentialStore(this.profileCredentials, scope, this);
    this.scopes.add(scope);

    return {
      credentials,
      bindRuntime: (runtime) => {
        this.assertScopeUsable(scope);
        if (scope.runtime !== undefined) throw new Error("Session auth credential scope is already bound");
        scope.runtime = runtime;
        this.scopesByRuntime.set(runtime, scope);
      },
      abandon: () => {
        this.disposeScope(scope);
      },
    };
  }

  /** Record extension-owned provider IDs as soon as cwd services have loaded. */
  updateExtensionProviders(runtime: ModelRuntime): void {
    const scope = this.requireScope(runtime);
    this.assertScopeUsable(scope);
    scope.extensionProviderIds = new Set(runtime.getRegisteredProviderIds());
  }

  /** Make an initialized runtime discoverable through an exact session target. */
  activateRuntime(runtime: ModelRuntime, target: SessionAuthTarget): SessionAuthRuntimeTarget {
    const scope = this.requireScope(runtime);
    this.assertScopeUsable(scope);
    this.updateExtensionProviders(runtime);
    this.invalidateActivation(scope);

    const canonicalTarget = { sessionId: target.sessionId, cwd: canonicalizeStoredCwd(target.cwd) };
    const key = targetKey(canonicalTarget);
    const previous = this.activeByIdentity.get(key);
    if (previous !== undefined && previous !== scope) this.invalidateActivation(previous);

    const activation: SessionAuthRuntimeTarget = {
      ...canonicalTarget,
      generationId: randomUUID(),
      runtime,
    };
    scope.activation = activation;
    this.activeByIdentity.set(key, scope);
    return activation;
  }

  /** Invalidate provider references/flows while retaining the runtime credential scope. */
  invalidateProviderGeneration(runtime: ModelRuntime): void {
    const scope = this.scopesByRuntime.get(runtime);
    if (scope !== undefined) this.invalidateActivation(scope);
  }

  /** Permanently invalidate a ModelRuntime and remove its collision registration. */
  disposeRuntime(runtime: ModelRuntime): void {
    const scope = this.scopesByRuntime.get(runtime);
    if (scope !== undefined) this.disposeScope(scope);
  }

  resolveTarget(target: SessionAuthTarget): SessionAuthRuntimeTarget | undefined {
    const key = targetKey({ sessionId: target.sessionId, cwd: canonicalizeStoredCwd(target.cwd) });
    const scope = this.activeByIdentity.get(key);
    const activation = scope?.activation;
    return activation === undefined ? undefined : { ...activation };
  }

  isCurrentGeneration(target: SessionAuthRuntimeTarget): boolean {
    const scope = this.scopesByRuntime.get(target.runtime);
    return scope?.disposed === false
      && scope.activation?.generationId === target.generationId
      && this.activeByIdentity.get(targetKey(target)) === scope;
  }

  /**
   * Bind async login work to the exact generation that authorized it. The
   * scoped store reads this public Node async context at its eventual modify
   * boundary, after a provider-owned flow may have awaited for minutes.
   */
  runInGeneration<T>(target: SessionAuthRuntimeTarget, operation: () => T): T {
    const scope = this.scopesByRuntime.get(target.runtime);
    if (scope === undefined || !this.isCurrentGeneration(target)) throw new StaleSessionAuthRuntimeError();
    return this.authOperationContext.run({ scopeId: scope.id, generationId: target.generationId }, operation);
  }

  subscribeInvalidation(listener: GenerationInvalidationListener): () => void {
    this.invalidationListeners.add(listener);
    return () => {
      this.invalidationListeners.delete(listener);
    };
  }

  dispose(): void {
    for (const scope of [...this.scopes]) this.disposeScope(scope);
    this.invalidationListeners.clear();
  }

  assertScopeActive(scope: RuntimeCredentialScope): void {
    this.assertScopeUsable(scope);
    const operation = this.authOperationContext.getStore();
    if (operation?.scopeId === scope.id && scope.activation?.generationId !== operation.generationId) {
      throw new StaleSessionAuthRuntimeError();
    }
  }

  assertCredentialAccess(scope: RuntimeCredentialScope, providerId: string): void {
    this.assertScopeActive(scope);
    if (this.isProviderAmbiguous(scope, providerId)) {
      throw new AmbiguousSessionProviderCredentialError(providerId);
    }
  }

  isProviderAmbiguous(scope: RuntimeCredentialScope, providerId: string): boolean {
    // Extensions may register/unregister providers dynamically after startup.
    // Re-read the public runtime registration set at the credential boundary so
    // collision safety does not depend on an unavailable registration event.
    this.refreshExtensionProviderIds();
    if (!scope.extensionProviderIds.has(providerId)) return false;
    const cwdScopes = new Set<string>();
    for (const candidate of this.scopes) {
      if (candidate.disposed || !candidate.extensionProviderIds.has(providerId)) continue;
      cwdScopes.add(candidate.cwd);
      if (cwdScopes.size > 1) return true;
    }
    return false;
  }

  private refreshExtensionProviderIds(): void {
    for (const candidate of this.scopes) {
      if (!candidate.disposed && candidate.runtime !== undefined) {
        candidate.extensionProviderIds = new Set(candidate.runtime.getRegisteredProviderIds());
      }
    }
  }

  private requireScope(runtime: ModelRuntime): RuntimeCredentialScope {
    const scope = this.scopesByRuntime.get(runtime);
    if (scope === undefined) throw new Error("Model runtime does not belong to this session auth registry");
    return scope;
  }

  private assertScopeUsable(scope: RuntimeCredentialScope): void {
    if (scope.disposed) throw new StaleSessionAuthRuntimeError();
  }

  private disposeScope(scope: RuntimeCredentialScope): void {
    if (scope.disposed) return;
    scope.disposed = true;
    this.invalidateActivation(scope);
    scope.extensionProviderIds.clear();
    this.scopes.delete(scope);
    if (scope.runtime !== undefined) this.scopesByRuntime.delete(scope.runtime);
  }

  private invalidateActivation(scope: RuntimeCredentialScope): void {
    const activation = scope.activation;
    if (activation === undefined) return;
    delete scope.activation;
    const key = targetKey(activation);
    if (this.activeByIdentity.get(key) === scope) this.activeByIdentity.delete(key);
    for (const listener of [...this.invalidationListeners]) {
      try {
        listener(activation.generationId);
      } catch {
        // Invalidation is a lifecycle safety boundary; diagnostics cannot stop it.
      }
    }
  }
}

class ScopedSessionCredentialStore implements CredentialStore {
  constructor(
    private readonly profile: CredentialStore,
    private readonly scope: RuntimeCredentialScope,
    private readonly registry: SessionAuthRuntimeRegistry,
  ) {}

  async read(providerId: string): Promise<Credential | undefined> {
    this.registry.assertScopeActive(this.scope);
    if (this.registry.isProviderAmbiguous(this.scope, providerId)) {
      // Preserve a runtime-local extension/env fallback when no profile secret
      // exists. A real stored entry still rejects instead of being selected by
      // whichever colliding OAuth implementation happened to open first.
      const stored = (await this.profile.list()).some((credential) => credential.providerId === providerId);
      this.registry.assertScopeActive(this.scope);
      if (this.registry.isProviderAmbiguous(this.scope, providerId) && stored) {
        throw new AmbiguousSessionProviderCredentialError(providerId);
      }
      if (this.registry.isProviderAmbiguous(this.scope, providerId)) return undefined;
    }
    const credential = await this.profile.read(providerId);
    this.registry.assertCredentialAccess(this.scope, providerId);
    return credential;
  }

  async list(): Promise<readonly CredentialInfo[]> {
    this.registry.assertScopeActive(this.scope);
    const credentials = await this.profile.list();
    this.registry.assertScopeActive(this.scope);
    return credentials.filter((credential) => !this.registry.isProviderAmbiguous(this.scope, credential.providerId));
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    this.registry.assertCredentialAccess(this.scope, providerId);
    const guardedMutation = async (current: Credential | undefined) => {
      this.registry.assertCredentialAccess(this.scope, providerId);
      const next = await fn(current);
      // Prevent a refresh/login that was in flight during replacement or a
      // newly detected collision from committing against the stale definition.
      this.registry.assertCredentialAccess(this.scope, providerId);
      return next;
    };
    const assertCommitAllowed = () => {
      this.registry.assertCredentialAccess(this.scope, providerId);
    };
    return isMutationGuardStore(this.profile)
      ? this.profile.modifyGuarded(providerId, guardedMutation, assertCommitAllowed)
      : this.profile.modify(providerId, guardedMutation);
  }

  async delete(providerId: string): Promise<void> {
    this.registry.assertCredentialAccess(this.scope, providerId);
    await this.profile.delete(providerId);
    this.registry.assertCredentialAccess(this.scope, providerId);
  }
}

function isMutationGuardStore(store: CredentialStore): store is ProfileCredentialMutationGuardStore {
  return "modifyGuarded" in store && typeof store.modifyGuarded === "function";
}

function targetKey(target: SessionAuthTarget): string {
  return JSON.stringify([canonicalizeStoredCwd(target.cwd), target.sessionId]);
}
