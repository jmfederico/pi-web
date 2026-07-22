import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSessionServices, type ModelRuntime } from "@earendil-works/pi-coding-agent";

/**
 * PI WEB providers come from global sources only: Pi built-ins, agent-dir
 * `models.json`, environment credentials, and providers registered by global
 * (agent-dir) extensions. Provider registrations from project extensions are
 * rejected — the user is told, and everything else the extension does keeps
 * working.
 *
 * Why: all sessions share one daemon-wide {@link ModelRuntime}. Global
 * extensions are identical for every session, so their providers are
 * daemon-wide consistent; project extensions differ per workspace, and letting
 * them mutate the shared runtime corrupts the provider set of every other
 * concurrent session (issue #76).
 *
 * Mechanism: this deliberately shadows the `registerProvider` /
 * `registerNativeProvider` / `unregisterProvider` instance methods because Pi
 * 0.81.1 offers no registration hook with extension attribution (the internal
 * drain, the bind-time flush, and the late `pi.registerProvider` path all
 * reach the runtime through call-time property lookup with the extension path
 * already dropped, so instance shadowing intercepts them identically). The
 * acceptance suite that exercises the load-time and late paths is the
 * tripwire: if a Pi upgrade changes these internals, those tests fail loudly
 * and this shim must be revisited.
 *
 * Attribution: Pi drops the registering extension's path before calls reach
 * the runtime, so the shim cannot tell global from project extensions per
 * call. Instead the daemon learns once, at startup, which provider ids global
 * extensions register ({@link learnGlobalExtensionProviderIds}) and allows
 * exactly those. This is not a security boundary — extensions run in-process
 * with full trust, and a project extension re-registering an allowed id would
 * pass. It is a guard against accidental cross-workspace leakage.
 */
export function installGlobalProviderPolicy(
  runtime: ModelRuntime,
  allowedExtensionProviderIds: ReadonlySet<string>,
  onRejection: (providerId: string) => void,
): void {
  const registerProvider = runtime.registerProvider.bind(runtime);
  const registerNativeProvider = runtime.registerNativeProvider.bind(runtime);
  const unregisterProvider = runtime.unregisterProvider.bind(runtime);

  runtime.registerProvider = (providerId, config) => {
    if (allowedExtensionProviderIds.has(providerId)) {
      registerProvider(providerId, config);
      return;
    }
    // Swallow: the shared runtime is never mutated, the rejection is surfaced.
    onRejection(providerId);
  };
  runtime.registerNativeProvider = (provider) => {
    if (allowedExtensionProviderIds.has(provider.id)) {
      registerNativeProvider(provider);
      return;
    }
    onRejection(provider.id);
  };
  runtime.unregisterProvider = (providerId) => {
    if (allowedExtensionProviderIds.has(providerId)) {
      unregisterProvider(providerId);
      return;
    }
    // No-op: rejected registrations never reached the runtime, so there is
    // never anything of theirs to unregister.
  };
}

/**
 * Learn which provider ids the agent directory's global extensions register.
 *
 * Loads extensions once for a guaranteed-empty temporary cwd — so only global
 * (agent-dir) extensions load — against the daemon's shared runtime, and
 * returns the ids that appeared. Those registrations stay on the runtime: they
 * are the daemon baseline, re-registered identically on every session load.
 * Must run before {@link installGlobalProviderPolicy} is installed.
 *
 * Caveat: global extension code runs one extra time at daemon startup. Any
 * commands/tools it registers land on the discarded scratch loader.
 */
export async function learnGlobalExtensionProviderIds(
  runtime: ModelRuntime,
  agentDir: string,
): Promise<ReadonlySet<string>> {
  const before = new Set(runtime.getRegisteredProviderIds());
  const scratchCwd = await mkdtemp(join(tmpdir(), "pi-web-global-ext-"));
  try {
    await createAgentSessionServices({ cwd: scratchCwd, agentDir, modelRuntime: runtime });
  } finally {
    await rm(scratchCwd, { recursive: true, force: true });
  }
  const learned = new Set<string>();
  for (const providerId of runtime.getRegisteredProviderIds()) {
    if (!before.has(providerId)) learned.add(providerId);
  }
  return learned;
}

/**
 * User-facing wording for a rejected registration. `cwd` is known only for
 * rejections raised while loading a workspace's services; late registrations
 * from session event handlers carry no attribution beyond the provider id.
 */
export function providerRejectionMessage(providerId: string, cwd?: string): string {
  const origin = cwd === undefined ? "registered by an extension" : `registered by an extension in ${cwd}`;
  return `Provider "${providerId}" ${origin} was ignored — PI WEB providers must come from global configuration `
    + "(agent-dir models.json) or a globally installed extension. All other extension features are unaffected.";
}
