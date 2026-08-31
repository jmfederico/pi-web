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
        serverPlugins: { stop: () => { events.push("plugins"); throw failure; } },
        terminals: { dispose: () => { events.push("terminals"); } },
        catalogRefresher: { dispose: () => { events.push("catalog"); } },
        auth: { dispose: () => { events.push("auth"); } },
        sessions: { dispose: () => { events.push("sessions"); } },
        unreadStore: { flush: () => { events.push("unread"); } },
        pushSubscriptions: { flush: () => { events.push("pushSubscriptions"); } },
        closeServer: () => { events.push("server"); },
      },
    });

    expect(events).toEqual(["quiesce", "terminals", "catalog", "sessions", "server", "plugins", "auth", "unread", "pushSubscriptions"]);
    expect(onFailure).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(
      { err: failure, operation: "stop server plugins" },
      "session daemon shutdown operation failed",
    );
  });
});
