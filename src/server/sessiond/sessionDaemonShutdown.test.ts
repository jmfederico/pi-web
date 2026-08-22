import { describe, expect, it, vi } from "vitest";
import { runSessionDaemonShutdown } from "./sessionDaemonShutdown.js";

describe("session daemon shutdown", () => {
  it("quiesces ingress, disposes consumers before providers, and continues after failures", async () => {
    const events: string[] = [];
    const failure = new Error("plugin stop failed");
    const logger = { error: vi.fn() };
    const onFailure = vi.fn();

    await runSessionDaemonShutdown({
      logger,
      onFailure,
      dependencies: {
        quiesceServer: () => { events.push("quiesce"); },
        serverPlugins: {
          quiesce: () => { events.push("plugin-quiesce"); },
          stop: () => { events.push("plugins"); throw failure; },
        },
        backgroundSessions: { quiesceAll: () => { events.push("background-sessions"); } },
        terminals: { dispose: () => { events.push("terminals"); } },
        catalogRefresher: { dispose: () => { events.push("catalog"); } },
        auth: { dispose: () => { events.push("auth"); } },
        sessions: { dispose: () => { events.push("sessions"); } },
        unreadStore: { flush: () => { events.push("unread"); } },
        closeServer: () => { events.push("server"); },
      },
    });

    expect(events).toEqual(["quiesce", "plugin-quiesce", "background-sessions", "terminals", "catalog", "sessions", "server", "plugins", "auth", "unread"]);
    expect(onFailure).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(
      { err: failure, operation: "stop server plugins" },
      "session daemon shutdown operation failed",
    );
  });
});
