import type { PluginSelectionService, PluginSelectionSnapshot } from "../../../plugin-api";

/** Registry-owned notifications; the host remains the owner of current selection. */
export class PluginSelectionHost {
  private readonly subscribers = new Set<(snapshot: PluginSelectionSnapshot) => void>();
  private lastSelection: string;

  constructor(private readonly readSelection: () => PluginSelectionSnapshot) {
    this.lastSelection = JSON.stringify(readSelection());
  }

  notifyChanged(): void {
    const snapshot = this.readSelection();
    const selection = JSON.stringify(snapshot);
    if (selection === this.lastSelection) return;
    this.lastSelection = selection;
    // A callback may unsubscribe another callback before its turn.
    for (const notify of [...this.subscribers]) {
      if (this.subscribers.has(notify)) notify(snapshot);
    }
  }

  forPlugin(pluginId: string, lifetimeSignal: AbortSignal): PluginSelectionService {
    return Object.freeze({
      getSnapshot: () => structuredClone(this.readSelection()),
      subscribe: (listener: (snapshot: PluginSelectionSnapshot) => void | Promise<void>) => {
        if (lifetimeSignal.aborted) return () => undefined;
        const reportFailure = (error: unknown) => {
          console.warn(`PI WEB plugin ${pluginId} selection subscriber failed`, error);
        };
        const notify = (snapshot: PluginSelectionSnapshot) => {
          try {
            // Each consumer gets detached data, including nested workspace metadata.
            const result = listener(structuredClone(snapshot));
            if (result !== undefined) void Promise.resolve(result).catch(reportFailure);
          } catch (error) {
            reportFailure(error);
          }
        };
        const unsubscribe = () => {
          this.subscribers.delete(notify);
          lifetimeSignal.removeEventListener("abort", unsubscribe);
        };
        this.subscribers.add(notify);
        lifetimeSignal.addEventListener("abort", unsubscribe, { once: true });
        return unsubscribe;
      },
    });
  }
}
