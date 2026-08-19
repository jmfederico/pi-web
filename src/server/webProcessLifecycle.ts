import type {
  FastifyInstance,
  FastifyListenOptions,
} from "fastify";

export const WEB_PROCESS_SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM"] as const;

export type WebProcessShutdownSignal = typeof WEB_PROCESS_SHUTDOWN_SIGNALS[number];
export type WebProcessSignalListener = () => void | Promise<void>;

export interface WebProcessSignalSource {
  subscribe(
    signal: WebProcessShutdownSignal,
    listener: WebProcessSignalListener,
  ): () => void;
}

export interface WebProcessLifecycleDependencies {
  signalSource?: WebProcessSignalSource;
  close?: (app: FastifyInstance) => Promise<void>;
  listen?: (
    app: FastifyInstance,
    options: FastifyListenOptions,
  ) => Promise<unknown>;
}

const nodeProcessSignalSource: WebProcessSignalSource = {
  subscribe(signal, listener) {
    const processListener = () => { void listener(); };
    process.on(signal, processListener);
    return () => { process.off(signal, processListener); };
  },
};

const closeWithFastify = (app: FastifyInstance): Promise<void> => app.close();

const listenWithFastify = (
  app: FastifyInstance,
  options: FastifyListenOptions,
): Promise<string> => app.listen(options);

/** Closes the composed Fastify app once on a normal process shutdown signal. */
export async function runWebProcess(
  app: FastifyInstance,
  listenOptions: FastifyListenOptions,
  dependencies: WebProcessLifecycleDependencies = {},
): Promise<void> {
  const signalSource = dependencies.signalSource ?? nodeProcessSignalSource;
  const close = dependencies.close ?? closeWithFastify;
  const listen = dependencies.listen ?? listenWithFastify;
  const unsubscribeSignals: (() => void)[] = [];
  let shutdownInFlight: Promise<void> | undefined;
  let signalsRemoved = false;

  const removeSignalListeners = (): void => {
    if (signalsRemoved) return;
    signalsRemoved = true;
    for (const unsubscribe of unsubscribeSignals.splice(0)) unsubscribe();
  };
  const requestShutdown = (): Promise<void> => {
    shutdownInFlight ??= Promise.resolve()
      .then(() => close(app))
      .finally(removeSignalListeners);
    return shutdownInFlight;
  };

  app.addHook("onClose", () => {
    removeSignalListeners();
    return Promise.resolve();
  });
  for (const signal of WEB_PROCESS_SHUTDOWN_SIGNALS) {
    unsubscribeSignals.push(signalSource.subscribe(signal, async () => {
      try {
        await requestShutdown();
      } catch (error: unknown) {
        app.log.error(
          { err: error, signal },
          "failed to close web server after shutdown signal",
        );
      }
    }));
  }

  try {
    await listen(app, listenOptions);
  } catch (error: unknown) {
    try {
      await requestShutdown();
    } catch (cleanupError: unknown) {
      app.log.error(
        { err: cleanupError },
        "web server listen failed and shutdown was incomplete",
      );
    }
    removeSignalListeners();
    throw error;
  }
}
