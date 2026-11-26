import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  PI_WEB_HOST_CATALOG_CAPABILITY, PI_WEB_HOST_PI_SESSION_EVENTS_CAPABILITY, PI_WEB_HOST_SESSION_STATE_CAPABILITY,
  type PiWebServerPluginV5, type ServerPluginActivationContextV5, type ServerPluginActivationV5,
} from "@jmfederico/pi-web/server-plugin-api";
import { createSessionDelivery } from "./delivery.js";
import { createGitHubReader, type GitHubReader } from "./github.js";
import { PrWatchService } from "./service.js";
import { parseSettings } from "./settings.js";
import { SubscriptionStore } from "./store.js";

const plugin: PiWebServerPluginV5 = {
  apiVersion: 5,
  name: "PR watch (internal)",
  requires: [PI_WEB_HOST_CATALOG_CAPABILITY, PI_WEB_HOST_SESSION_STATE_CAPABILITY, PI_WEB_HOST_PI_SESSION_EVENTS_CAPABILITY],
  activate(context) { return activatePrWatch(context); },
};
export default plugin;

export interface ActivationOverrides {
  readonly github?: GitHubReader;
  readonly now?: () => number;
}

/** Activation owns the subscription file and the poll timer; disposal stops polling and flushes state. */
export function activatePrWatch(context: ServerPluginActivationContextV5, overrides: ActivationOverrides = {}): ServerPluginActivationV5 {
  const settings = parseSettings(context.settings);
  const logError = (message: string) => (error: unknown) => {
    context.logger.error(message, { error: error instanceof Error ? error.message : String(error) });
  };
  let service: PrWatchService | undefined;
  let store: SubscriptionStore | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> = Promise.resolve();
  const stop = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  context.lifetimeSignal.addEventListener("abort", stop, { once: true });

  return {
    async start({ capabilities }) {
      context.lifetimeSignal.throwIfAborted();
      store = await SubscriptionStore.open(join(context.dataDirectory, "subscriptions.json"), logError("PR watch could not save subscriptions"));
      const notices = context.notices;
      service = new PrWatchService({
        store,
        github: overrides.github ?? createGitHubReader(context.execFile, settings.ghCommand),
        catalog: capabilities.resolve(PI_WEB_HOST_CATALOG_CAPABILITY),
        deliver: createSessionDelivery(
          capabilities.resolve(PI_WEB_HOST_SESSION_STATE_CAPABILITY),
          capabilities.resolve(PI_WEB_HOST_PI_SESSION_EVENTS_CAPABILITY),
          context.lifetimeSignal,
        ),
        settings,
        logger: context.logger,
        ...(notices === undefined ? {} : { notice: (input) => { notices.record(input); } }),
        now: overrides.now ?? Date.now,
        randomId: randomUUID,
      });
      const active = service;
      const schedule = () => {
        if (context.lifetimeSignal.aborted) return;
        timer = setTimeout(() => {
          running = active.cycle(context.lifetimeSignal).catch((error: unknown) => {
            if (!context.lifetimeSignal.aborted) logError("PR watch cycle failed")(error);
          }).finally(schedule);
        }, settings.pollIntervalMs);
        timer.unref();
      };
      schedule();
    },
    peer: {
      async request({ scope, operation, input, signal }) {
        context.lifetimeSignal.throwIfAborted();
        if (scope.kind !== "machine") throw new Error("PR watch requires machine scope");
        if (service === undefined) throw new Error("PR watch has not started");
        return service.request(operation, input, AbortSignal.any([signal, context.lifetimeSignal]));
      },
    },
    health() {
      return service?.health() ?? { status: "unhealthy", message: "PR watch has not started" };
    },
    async dispose() {
      stop();
      context.lifetimeSignal.removeEventListener("abort", stop);
      await running;
      await store?.flush();
      service = undefined;
      store = undefined;
    },
  };
}
