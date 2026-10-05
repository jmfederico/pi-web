import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  createAgentSessionServices,
  type AgentSessionRuntimeDiagnostic,
  type AgentSessionServices,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";

/** Structured logging boundary supplied by the session daemon. */
export interface GlobalProviderBootstrapLogger {
  error(details: Record<string, unknown>, message: string): void;
  info(details: Record<string, unknown>, message: string): void;
  warn(details: Record<string, unknown>, message: string): void;
}

type ProviderMutationOperation = "registerNativeProvider" | "registerProvider" | "unregisterProvider";
type ProviderMutationMethods = Pick<ModelRuntime, ProviderMutationOperation>;
/** Pi's `ProviderConfigInput`, read from the runtime contract instead of a deep package import. */
type RegisteredProviderConfig = NonNullable<ReturnType<ModelRuntime["getRegisteredProviderConfig"]>>;

const LOG_CONTEXT = "global-provider-bootstrap";
const MODELS_FIELD = "models";

/**
 * Snapshot the merged config Pi holds for every config-registered provider.
 * Pi merges defined values over the previous registration, so the runtime's
 * own record — not the extension's last argument — is the accurate baseline.
 * Native providers have no comparable config and are deliberately absent.
 */
function captureProviderConfigBaseline(runtime: ModelRuntime): Map<string, RegisteredProviderConfig> {
  const baseline = new Map<string, RegisteredProviderConfig>();
  for (const providerId of runtime.getRegisteredProviderIds()) {
    const config = runtime.getRegisteredProviderConfig(providerId);
    if (config) baseline.set(providerId, config);
  }
  return baseline;
}

/**
 * True when `incoming` would change the model catalog of `baseline` and nothing
 * else.
 *
 * Extensions that refresh their catalog re-send a complete provider config, so
 * the test is "equal to the baseline except for models", not "contains only
 * models". Omitted fields are not changes: Pi's merge keeps the previous value,
 * which also makes an unchanged catalog a plain replay rather than an update.
 * Function-valued fields (`streamSimple`, `refreshModels`, `oauth` methods)
 * compare by reference under deep strict equality, so a freshly created closure
 * reads as a mismatch. That conservative direction is intentional: an unclear
 * comparison must fall back to the frozen no-op.
 */
function isModelsOnlyProviderUpdate(baseline: RegisteredProviderConfig, incoming: RegisteredProviderConfig): boolean {
  const baselineFields = new Map(Object.entries(baseline));
  const otherFieldsMatch = Object.entries(incoming).every(([field, value]) => {
    if (field === MODELS_FIELD || value === undefined) return true;
    return isDeepStrictEqual(value, baselineFields.get(field));
  });
  if (!otherFieldsMatch) return false;
  return incoming.models !== undefined && !isDeepStrictEqual(incoming.models, baseline.models);
}

/**
 * Diagnostic comparison only: fresh closures are not evidence of changed code.
 * The acceptance gate above still uses strict equality and remains unchanged.
 * Compare plain config objects recursively so a real OAuth setting change is
 * not hidden just because that object also contains callbacks.
 */
function matchesIgnoringFunctionReferences(
  baseline: unknown,
  incoming: unknown,
  compared = new WeakMap<object, WeakSet<object>>(),
): boolean {
  if (isDeepStrictEqual(baseline, incoming)) return true;
  if (typeof baseline === "function" && typeof incoming === "function") return true;
  if (typeof baseline !== "object" || baseline === null || typeof incoming !== "object" || incoming === null) return false;
  const prototype: unknown = Object.getPrototypeOf(baseline);
  if (prototype !== Object.getPrototypeOf(incoming) || (prototype !== Object.prototype && prototype !== null)) return false;
  const paired = compared.get(baseline) ?? new WeakSet();
  if (paired.has(incoming)) return true;
  paired.add(incoming);
  compared.set(baseline, paired);
  const baselineFields = new Map(Object.entries(baseline));
  const incomingFields = Object.entries(incoming);
  return baselineFields.size === incomingFields.length && incomingFields.every(([field, value]) =>
    baselineFields.has(field) && matchesIgnoringFunctionReferences(baselineFields.get(field), value, compared));
}

function ignoredConfigReason(baseline: RegisteredProviderConfig, incoming: RegisteredProviderConfig): IgnoredMutationReason | undefined {
  const baselineFields = new Map(Object.entries(baseline));
  const changedFields = Object.entries(incoming).filter(([field, value]) =>
    field !== MODELS_FIELD && value !== undefined && !isDeepStrictEqual(value, baselineFields.get(field)));
  if (changedFields.length === 0) return undefined; // Unchanged replay: no diagnostic needed.
  return changedFields.every(([field, value]) => matchesIgnoringFunctionReferences(baselineFields.get(field), value))
    ? "implementation-unverified"
    : "configuration-change";
}

type IgnoredMutationReason =
  | "not-in-startup-baseline"
  | "configuration-change"
  | "implementation-unverified"
  | "native-registration-frozen"
  | "unregistration-frozen";

const PROVIDER_RECOVERY_GUIDANCE = "The startup provider, if any, remains in use. "
  + "Provider registrations are shared across sessions and fixed at daemon startup. "
  + "For a global extension, register providers in its factory in the active agent directory, then manually restart "
  + "the session daemon when safe; this interrupts active sessions and terminals. Project-only or session_start-only "
  + "registrations are not enabled by a restart. /reload and web/API restarts do not rebuild the provider baseline. "
  + "See https://pi-web.dev/faq#provider-extension-no-effect.";

async function loadGlobalExtensionServices(runtime: ModelRuntime, agentDir: string): Promise<AgentSessionServices> {
  const scratchCwd = await mkdtemp(join(tmpdir(), "pi-web-global-ext-"));
  try {
    return await createAgentSessionServices({ cwd: scratchCwd, agentDir, modelRuntime: runtime });
  } finally {
    await rm(scratchCwd, { recursive: true, force: true });
  }
}

function logBootstrapDiagnostic(
  logger: GlobalProviderBootstrapLogger,
  diagnostic: AgentSessionRuntimeDiagnostic,
): void {
  const details = {
    context: LOG_CONTEXT,
    diagnosticType: diagnostic.type,
    diagnostic: diagnostic.message,
  };
  if (diagnostic.type === "error") {
    logger.error(details, "global extension provider bootstrap diagnostic");
  } else if (diagnostic.type === "warning") {
    logger.warn(details, "global extension provider bootstrap diagnostic");
  } else {
    logger.info(details, "global extension provider bootstrap diagnostic");
  }
}

/**
 * Pi routers close over an extension runtime's session-bound context. Sharing
 * them would let another session replace a router or keep it after its context
 * is invalidated. Bootstrap has no bound context either, so reject before load.
 * Pi surfaces these throws as bootstrap diagnostics or hosted extension errors.
 */
function rejectVirtualModelMutations(runtime: ModelRuntime): void {
  const reject = (operation: "registerVirtualModel" | "unregisterVirtualModel"): never => {
    // Never echo model definitions or IDs: they may contain sensitive values.
    throw new Error(
      `PI WEB does not support ${operation}(): virtual-model routers capture session-bound context, `
      + "but the model runtime is shared across sessions. Disable this extension's virtual-model feature "
      + "and select a physical model instead.",
    );
  };
  const rejectedMethods: Pick<ModelRuntime, "registerVirtualModel" | "unregisterVirtualModel"> = {
    registerVirtualModel: () => reject("registerVirtualModel"),
    unregisterVirtualModel: () => reject("unregisterVirtualModel"),
  };
  Object.assign(runtime, rejectedMethods);
}

function freezeProviderMutations(
  runtime: ModelRuntime,
  logger: GlobalProviderBootstrapLogger,
  configBaseline: Map<string, RegisteredProviderConfig>,
): void {
  const originalMethods: ProviderMutationMethods = {
    registerNativeProvider: runtime.registerNativeProvider.bind(runtime),
    registerProvider: runtime.registerProvider.bind(runtime),
    unregisterProvider: runtime.unregisterProvider.bind(runtime),
  };
  const startupProviderIds = new Set(runtime.getRegisteredProviderIds());
  const loggedMutations = new Set<string>();
  // Logging must never turn a provider mutation into an extension failure.
  const logQuietly = (details: Record<string, unknown>, message: string, level: "info" | "warn" = "info"): void => {
    try {
      logger[level](details, message);
    } catch {
      // Intentionally ignored; the mutation decision already stands.
    }
  };
  const logIgnoredMutation = (operation: ProviderMutationOperation, providerId: string, reason: IgnoredMutationReason): void => {
    // An ordinary callback replay must not suppress a later actionable warning.
    const key = JSON.stringify([operation, providerId, reason]);
    if (loggedMutations.has(key)) return;
    loggedMutations.add(key);
    const level = reason === "not-in-startup-baseline" || reason === "configuration-change" ? "warn" : "info";
    logQuietly(
      {
        context: LOG_CONTEXT,
        code: "PROVIDER_MUTATION_IGNORED",
        operation,
        providerId,
        reason,
        guidance: PROVIDER_RECOVERY_GUIDANCE,
      },
      "ignored provider mutation after global bootstrap",
      level,
    );
  };
  const frozenMethods: ProviderMutationMethods = {
    registerProvider(providerId, config) {
      const baseline = configBaseline.get(providerId);
      if (!baseline || !isModelsOnlyProviderUpdate(baseline, config)) {
        const reason = baseline === undefined
          ? (startupProviderIds.has(providerId) ? "configuration-change" : "not-in-startup-baseline")
          : ignoredConfigReason(baseline, config);
        if (reason !== undefined) logIgnoredMutation("registerProvider", providerId, reason);
        return;
      }
      // Pi validates the registration and ends in a fire-and-forget local
      // refresh, so this stays synchronous and never reaches the network.
      originalMethods.registerProvider(providerId, config);
      const accepted = runtime.getRegisteredProviderConfig(providerId);
      // Re-read the merged record so the next comparison uses what Pi stored.
      if (accepted) configBaseline.set(providerId, accepted);
      logQuietly(
        {
          context: LOG_CONTEXT,
          operation: "registerProvider",
          providerId,
          modelCount: accepted?.models?.length ?? 0,
        },
        "applied models-only provider update after global bootstrap",
      );
    },
    registerNativeProvider(provider) {
      const reason = configBaseline.has(provider.id)
        ? "configuration-change"
        : startupProviderIds.has(provider.id) ? "native-registration-frozen" : "not-in-startup-baseline";
      logIgnoredMutation("registerNativeProvider", provider.id, reason);
    },
    unregisterProvider(providerId) {
      logIgnoredMutation("unregisterProvider", providerId, "unregistration-frozen");
    },
  };

  try {
    Object.assign(runtime, frozenMethods);
  } catch (error: unknown) {
    Object.assign(runtime, originalMethods);
    throw error;
  }
}

/**
 * Load global extensions once against the shared model runtime, then make its
 * extension-provider baseline immutable for the rest of the daemon lifetime.
 * All sessions share this runtime, so accepting project-dependent mutations
 * would leak provider configuration across workspaces. This is an accidental
 * contamination guard, not a sandbox for otherwise trusted extensions.
 *
 * The temporary cwd is guaranteed to be empty, so Pi discovers agent-dir
 * extensions without loading project resources. Virtual-model mutations are
 * rejected before even that load: their session-bound routers cannot be shared.
 * Documented initialization-time config and native registrations reach Pi's
 * public service factory. Pi exposes no provider-freeze hook, so the daemon
 * deliberately shadows the three public instance mutation methods afterward;
 * every later mutation is then a no-op, with daemon-log-only diagnostics.
 * Unchanged config replays are silent; fresh closures and native replays are
 * informational because their implementation cannot be compared reliably.
 *
 * The one exception is a known config provider refreshing its own model
 * catalog: a `registerProvider` call whose config matches the recorded
 * baseline in every field except `models` is applied, because a catalog is a
 * property of the provider rather than of the project. Native registration
 * stays fully frozen — it passes a whole `Provider` object with no comparable
 * config — as does unregistration.
 */
export async function bootstrapAndFreezeGlobalExtensionProviders(
  runtime: ModelRuntime,
  agentDir: string,
  logger: GlobalProviderBootstrapLogger,
): Promise<void> {
  rejectVirtualModelMutations(runtime);
  const services = await loadGlobalExtensionServices(runtime, agentDir);
  const providerIds = Object.freeze([...runtime.getRegisteredProviderIds()].sort());

  freezeProviderMutations(runtime, logger, captureProviderConfigBaseline(runtime));

  for (const diagnostic of services.diagnostics) logBootstrapDiagnostic(logger, diagnostic);
  for (const extensionError of services.resourceLoader.getExtensions().errors) {
    logger.error(
      { context: LOG_CONTEXT, error: extensionError.error },
      "global extension failed during provider bootstrap",
    );
  }
  logger.info(
    { context: LOG_CONTEXT, providerIds },
    "global extension provider baseline bootstrapped and frozen",
  );
}
