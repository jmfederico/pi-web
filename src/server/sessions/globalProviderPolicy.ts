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
  const loggedProviderIds: Record<ProviderMutationOperation, Set<string>> = {
    registerNativeProvider: new Set(),
    registerProvider: new Set(),
    unregisterProvider: new Set(),
  };
  // Logging must never turn a provider mutation into an extension failure.
  const logQuietly = (details: Record<string, unknown>, message: string): void => {
    try {
      logger.info(details, message);
    } catch {
      // Intentionally ignored; the mutation decision already stands.
    }
  };
  const logIgnoredMutation = (operation: ProviderMutationOperation, providerId: string): void => {
    const loggedIds = loggedProviderIds[operation];
    if (loggedIds.has(providerId)) return;
    loggedIds.add(providerId);
    logQuietly({ context: LOG_CONTEXT, operation, providerId }, "ignored provider mutation after global bootstrap");
  };
  const frozenMethods: ProviderMutationMethods = {
    registerProvider(providerId, config) {
      const baseline = configBaseline.get(providerId);
      if (!baseline || !isModelsOnlyProviderUpdate(baseline, config)) {
        logIgnoredMutation("registerProvider", providerId);
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
      logIgnoredMutation("registerNativeProvider", provider.id);
    },
    unregisterProvider(providerId) {
      logIgnoredMutation("unregisterProvider", providerId);
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
 * extensions without loading project resources. Documented initialization-time
 * config and native registrations therefore reach the runtime through Pi's
 * public service factory. Pi exposes no provider-freeze hook, so the daemon
 * deliberately shadows the three public instance mutation methods afterward;
 * every registration replay or later call is then a logged no-op.
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
