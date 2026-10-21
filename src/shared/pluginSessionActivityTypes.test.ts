import { describe, expect, it, vi } from "vitest";
import { PI_WEB_HOST_PI_SESSION_ACTIVITY_CAPABILITY } from "./pluginSessionActivityTypes.js";

const selection = { projectId: "p", workspaceId: "w", sessionId: "s" };

function snapshot() {
  return {
    session: { id: "s", cwd: "/repo", archived: false, runtime: "not-hosted" },
    lifecycle: "active",
    runtimeLoaded: false,
    activity: "unknown",
    status: {
      persisted: true,
      isStreaming: null,
      isCompacting: null,
      isBashRunning: null,
      pendingMessageCount: null,
      messageCount: 4,
      queueState: { available: false, reason: "runtime_not_loaded" },
      telemetry: { available: false, reason: "runtime_not_loaded" },
    },
    relatedExecutions: {
      supportedKinds: ["subsession"],
      unsupportedKinds: ["background-agent", "terminal", "process"],
      truncated: false,
      executions: [],
      workingCount: 0,
      totalCount: 0,
    },
  };
}

describe("session activity capability", () => {
  it("requires the explicit v1 token and validates immutable cold snapshots", async () => {
    const inspect = vi.fn(() => Promise.resolve(snapshot()));
    const activity = PI_WEB_HOST_PI_SESSION_ACTIVITY_CAPABILITY.parse({ version: 1, inspect });
    const result = await activity.inspect(selection);
    expect(inspect).toHaveBeenCalledWith(selection, undefined);
    expect(result.status.telemetry).toEqual({ available: false, reason: "runtime_not_loaded" });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.relatedExecutions.unsupportedKinds)).toBe(true);
  });

  it("rejects mismatched session identity, unsupported relation rows and malformed availability", async () => {
    const mismatched = PI_WEB_HOST_PI_SESSION_ACTIVITY_CAPABILITY.parse({ version: 1, inspect: () => Promise.resolve({ ...snapshot(), session: { ...snapshot().session, id: "other" } }) });
    await expect(mismatched.inspect(selection)).rejects.toThrow("Invalid");
    const unsupported = PI_WEB_HOST_PI_SESSION_ACTIVITY_CAPABILITY.parse({ version: 1, inspect: () => Promise.resolve({
      ...snapshot(), relatedExecutions: { ...snapshot().relatedExecutions, executions: [{ id: "process:1", kind: "process", status: "working" }] },
    }) });
    await expect(unsupported.inspect(selection)).rejects.toThrow("Invalid");
    const malformed = PI_WEB_HOST_PI_SESSION_ACTIVITY_CAPABILITY.parse({ version: 1, inspect: () => Promise.resolve({
      ...snapshot(), status: { ...snapshot().status, telemetry: { available: false, reason: "not-sure" } },
    }) });
    await expect(malformed.inspect(selection)).rejects.toThrow("Invalid");
  });

  it("requires exact working counts when the relation projection is complete", async () => {
    const inconsistent = PI_WEB_HOST_PI_SESSION_ACTIVITY_CAPABILITY.parse({ version: 1, inspect: () => Promise.resolve({
      ...snapshot(), relatedExecutions: { ...snapshot().relatedExecutions, workingCount: 1, totalCount: 1 },
    }) });
    await expect(inconsistent.inspect(selection)).rejects.toThrow("Invalid");

    const truncatedAggregate = PI_WEB_HOST_PI_SESSION_ACTIVITY_CAPABILITY.parse({ version: 1, inspect: () => Promise.resolve({
      ...snapshot(), relatedExecutions: { ...snapshot().relatedExecutions, truncated: true, workingCount: 1, totalCount: 101 },
    }) });
    await expect(truncatedAggregate.inspect(selection)).resolves.toMatchObject({
      relatedExecutions: { truncated: true, workingCount: 1, totalCount: 101 },
    });
  });
});
