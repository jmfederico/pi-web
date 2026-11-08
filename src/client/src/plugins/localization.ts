import type { PluginLocalization } from "../../../plugin-api.js";
import { LocalizationController } from "../localization/browser.js";
import { LocalizationService, message, type CatalogMachineScope } from "../localization/service.js";

/** The activation owns all effects; source identity stays stable across machines. */
export function createPluginLocalization(
  service: LocalizationService,
  pluginId: string,
  runtimePluginId: string,
  lifetime: AbortSignal,
  /** Machines on which this activation's catalogs apply; a remote pack stays on its machine. */
  catalogScope?: CatalogMachineScope,
): PluginLocalization {
  const cleanups = new Set<() => void>();
  const sources = new Set<string>();
  const assertActive = (): void => { lifetime.throwIfAborted(); };
  const own = (cleanup: () => void): (() => void) => {
    const release = (): void => {
      if (!cleanups.delete(release)) return;
      cleanup();
    };
    cleanups.add(release);
    return release;
  };
  lifetime.addEventListener("abort", () => {
    for (const cleanup of cleanups) cleanup();
  }, { once: true });

  const api: PluginLocalization = {
    message,
    get preferences() { return service.preferences; },
    get language() { return service.language; },
    get direction() { return service.direction; },
    get ready() { return service.ready; },
    registerMessages(namespace, definitions) {
      assertActive();
      if (!/^[a-z][a-z0-9.-]*$/u.test(namespace) || sources.has(namespace)) {
        throw new Error(`Duplicate or invalid plugin message namespace: ${namespace}`);
      }
      const acquired = service.acquireMessages(`plugin:${pluginId}:${namespace}`, definitions);
      sources.add(namespace);
      own(() => { acquired.release(); });
      return acquired.messages;
    },
    registerCatalog(contribution) {
      assertActive();
      if (!contribution.id) throw new Error("A plugin catalog ID is required");
      // JSON tuples preserve identity without ambiguous separators in author IDs.
      return own(service.registerCatalog({ ...contribution, id: JSON.stringify([runtimePluginId, contribution.id]) }, catalogScope));
    },
    subscribe(listener) {
      if (lifetime.aborted) return () => undefined;
      const reportFailure = (error: unknown): void => {
        console.warn(`PI WEB plugin ${runtimePluginId} localization subscriber failed`, error);
      };
      return own(service.subscribe(() => {
        if (lifetime.aborted) return;
        try {
          const result: unknown = listener();
          if (result !== undefined) void Promise.resolve(result).catch(reportFailure);
        } catch (error) { reportFailure(error); }
      }));
    },
    controller: (host) => new LocalizationController(host, api),
    number: (value, options) => service.number(value, options),
    date: (value, options) => service.date(value, options),
    time: (value, options) => service.time(value, options),
    relativeTime: (value, unit, options) => service.relativeTime(value, unit, options),
    list: (values, options) => service.list(values, options),
  };
  return Object.freeze(api);
}
