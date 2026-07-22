import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

/**
 * PI WEB supports only globally configured providers: Pi built-ins, agent-dir
 * `models.json`, and environment credentials. Any provider an extension tries
 * to register is rejected — the user is told, and everything else the
 * extension does keeps working.
 *
 * Why: all sessions share one daemon-wide {@link ModelRuntime}. Letting one
 * workspace's extensions mutate it corrupts the provider set of every other
 * concurrent session (issue #76). Rather than building scoped-provider
 * isolation, pi-web rejects scoped registrations outright.
 *
 * Mechanism: this deliberately shadows the `registerProvider` /
 * `unregisterProvider` instance methods because Pi 0.80.10 offers no
 * registration hook. Both Pi call sites (the load-time
 * `pendingProviderRegistrations` drain in `createAgentSessionServices` and the
 * late `pi.registerProvider` path through `ModelRegistry`) reach the runtime
 * through call-time property lookup, so instance shadowing intercepts them
 * identically. The acceptance test that exercises both paths is the tripwire:
 * if a Pi upgrade changes these internals, that test fails loudly and this
 * shim must be revisited.
 */
export function installGlobalProviderPolicy(
  runtime: ModelRuntime,
  onRejection: (providerId: string) => void,
): void {
  runtime.registerProvider = (providerId: string) => {
    // Swallow: the shared runtime is never mutated, the rejection is surfaced.
    onRejection(providerId);
  };
  runtime.unregisterProvider = () => {
    // No-op: with every registration rejected, the extension provider layer is
    // always empty, so there is never anything to unregister.
  };
}

/**
 * User-facing wording for a rejected registration. `cwd` is known only for
 * rejections raised while loading a workspace's services; late registrations
 * from session event handlers carry no attribution beyond the provider id.
 */
export function providerRejectionMessage(providerId: string, cwd?: string): string {
  const origin = cwd === undefined ? "registered by an extension" : `registered by an extension in ${cwd}`;
  return `Provider "${providerId}" ${origin} was ignored — PI WEB only supports globally configured providers. `
    + "Configure it globally (e.g. agent-dir models.json) to use it here. All other extension features are unaffected.";
}
