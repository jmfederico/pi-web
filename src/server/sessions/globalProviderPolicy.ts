import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const LOG_CONTEXT = "global-provider-bootstrap";

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

function freezeProviderMutations(runtime: ModelRuntime, logger: GlobalProviderBootstrapLogger): void {
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
  const logIgnoredMutation = (operation: ProviderMutationOperation, providerId: string): void => {
    const loggedIds = loggedProviderIds[operation];
    if (loggedIds.has(providerId)) return;
    loggedIds.add(providerId);
    logger.info(
      { context: LOG_CONTEXT, operation, providerId },
      "ignored provider mutation after global bootstrap",
    );
  };
  const frozenMethods: ProviderMutationMethods = {
    registerProvider(providerId) {
      logIgnoredMutation("registerProvider", providerId);
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
 */
export async function bootstrapAndFreezeGlobalExtensionProviders(
  runtime: ModelRuntime,
  agentDir: string,
  logger: GlobalProviderBootstrapLogger,
): Promise<void> {
  const services = await loadGlobalExtensionServices(runtime, agentDir);
  const providerIds = Object.freeze([...runtime.getRegisteredProviderIds()].sort());

  freezeProviderMutations(runtime, logger);

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
