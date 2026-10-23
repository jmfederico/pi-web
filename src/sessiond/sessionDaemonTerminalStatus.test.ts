import { describe, expect, it, vi } from "vitest";
import type { SessionDaemonRequestClient } from "./sessionDaemonClient.js";
import { formatTerminalServiceStatus, getSessionDaemonTerminalStatus } from "./sessionDaemonTerminalStatus.js";

describe("session daemon Terminal status", () => {
  it("reads the daemon's active service state, not the CLI's provider prerequisites", async () => {
    const request = vi.fn<SessionDaemonRequestClient["request"]>().mockResolvedValue({
      statusCode: 200, headers: {}, body: JSON.stringify({ state: "active", health: "unhealthy", message: "service stopped" }),
    });
    const status = await getSessionDaemonTerminalStatus({ request });
    expect(status).toEqual({ state: "active", health: "unhealthy", message: "service stopped" });
    expect(formatTerminalServiceStatus(status).ok).toBe(false);
    expect(request.mock.calls[0]?.slice(0, 3)).toEqual(["GET", "/terminal-status", undefined]);
    expect(request.mock.calls[0]?.[3]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("treats intentional recovery disablement as disabled, not healthy or failed", async () => {
    const status = await getSessionDaemonTerminalStatus({ request: () => Promise.resolve({ statusCode: 200, headers: {},
      body: JSON.stringify({ state: "disabled", message: "disabled by safe start" }) }) });
    const report = formatTerminalServiceStatus(status);
    expect(status.state).toBe("disabled");
    expect(report.ok).toBe(true);
    expect(report.lines.join("\n")).toContain("disabled by safe start");
    expect(report.lines.join("\n")).not.toContain("healthy");
  });

  it.each([
    { statusCode: 404, headers: {}, body: "" },
    { statusCode: 200, headers: {}, body: '{"state":"active"}' },
  ])("does not substitute CLI prerequisites for an unsupported daemon report", async response => {
    const status = await getSessionDaemonTerminalStatus({ request: () => Promise.resolve(response) });
    expect(status.state).toBe("unavailable");
    expect(formatTerminalServiceStatus(status).ok).toBe(false);
    expect(status.message).toContain("Restart the session daemon");
  });

  it("shows active and degraded states without promising every operation will succeed", () => {
    expect(formatTerminalServiceStatus({ state: "active", health: "healthy" })).toEqual({ ok: true, lines: ["✓ Terminal plugin is active (healthy)"] });
    expect(formatTerminalServiceStatus({ state: "active", health: "degraded", message: "service warning" })).toEqual({ ok: true,
      lines: ["! Terminal plugin is active (degraded)", "  service warning"] });
  });
});
