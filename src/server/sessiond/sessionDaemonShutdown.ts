export interface SessionDaemonShutdownLogger {
  error(details: Record<string, unknown>, message: string): void;
}

export interface SessionDaemonShutdownDependencies {
  quiesceServer(): void | Promise<void>;
  serverPlugins: { stop(): void | Promise<void> };
  terminals: { dispose(): void | Promise<void> };
  catalogRefresher: { dispose(): void | Promise<void> };
  auth: { dispose(): void | Promise<void> };
  sessions: { dispose(): void | Promise<void> };
  unreadStore: { flush(): void | Promise<void> };
  pushSubscriptions: { flush(): void | Promise<void> };
  closeServer(): void | Promise<void>;
}

export interface SessionDaemonShutdownOptions {
  logger: SessionDaemonShutdownLogger;
  dependencies: SessionDaemonShutdownDependencies;
  onFailure?: () => void;
}

/** Quiesces ingress, disposes consumers, then tears down plugin providers and dependencies. */
export async function runSessionDaemonShutdown(options: SessionDaemonShutdownOptions): Promise<void> {
  const { dependencies } = options;
  const operations: readonly (readonly [string, () => void | Promise<void>])[] = [
    ["quiesce server", () => dependencies.quiesceServer()],
    ["dispose terminals", () => dependencies.terminals.dispose()],
    ["dispose catalog refresher", () => dependencies.catalogRefresher.dispose()],
    ["dispose sessions", () => dependencies.sessions.dispose()],
    ["close server", () => dependencies.closeServer()],
    ["stop server plugins", () => dependencies.serverPlugins.stop()],
    ["dispose auth", () => dependencies.auth.dispose()],
    ["flush session unread state", () => dependencies.unreadStore.flush()],
    // Both persistence stores flush last (after the server is closed): in-flight work can still write to them,
    // and a graceful stop must not drop state accepted moments before shutdown.
    ["flush push subscriptions", () => dependencies.pushSubscriptions.flush()],
  ];

  for (const [operation, run] of operations) {
    try {
      await run();
    } catch (error) {
      options.onFailure?.();
      options.logger.error({ err: error, operation }, "session daemon shutdown operation failed");
    }
  }
}
