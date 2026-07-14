import { describe, expect, it, vi } from "vitest";
import type { ActiveAgentProfileDescriptor } from "../shared/apiTypes.js";
import type { SessionDaemonRequestClient } from "../sessiond/sessionDaemonClient.js";
import {
  ActiveAgentProfileAccessError,
  requireActiveAgentProfile,
  SessionDaemonActiveAgentProfileProvider,
} from "./activeAgentProfileProvider.js";

const firstProfile = activeProfile("a", "first-agent", "/state/first");
const secondProfile = activeProfile("b", "second-agent", "/state/second");

describe("SessionDaemonActiveAgentProfileProvider", () => {
  it("queries sessiond on every read and observes a new daemon profile epoch", async () => {
    const request = vi.fn<SessionDaemonRequestClient["request"]>()
      .mockResolvedValueOnce(runtimeResponse(firstProfile))
      .mockResolvedValueOnce(runtimeResponse(secondProfile));
    const provider = new SessionDaemonActiveAgentProfileProvider({ request });

    await expect(provider.getActiveAgentProfile()).resolves.toEqual({ status: "available", profile: firstProfile });
    await expect(provider.getActiveAgentProfile()).resolves.toEqual({ status: "available", profile: secondProfile });

    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(1, "GET", "/runtime");
    expect(request).toHaveBeenNthCalledWith(2, "GET", "/runtime");
  });

  it("preserves invalid protocol and daemon unavailability as distinct results", async () => {
    const invalidRequest = vi.fn<SessionDaemonRequestClient["request"]>().mockResolvedValue({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: "not-json",
    });
    const unavailableRequest = vi.fn<SessionDaemonRequestClient["request"]>().mockRejectedValue(new Error("connect ECONNREFUSED"));

    await expect(new SessionDaemonActiveAgentProfileProvider({ request: invalidRequest }).getActiveAgentProfile()).resolves.toEqual({
      status: "invalid",
      error: "session daemon runtime response was not valid JSON",
    });
    await expect(new SessionDaemonActiveAgentProfileProvider({ request: unavailableRequest }).getActiveAgentProfile()).resolves.toEqual({
      status: "unavailable",
      error: "connect ECONNREFUSED",
    });
  });
});

describe("requireActiveAgentProfile", () => {
  it.each(["invalid", "unavailable"] as const)("fails closed for an %s active profile", async (status) => {
    const provider = {
      getActiveAgentProfile: () => Promise.resolve({ status, error: `${status} profile` } as const),
    };

    const error = await requireActiveAgentProfile(provider).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ActiveAgentProfileAccessError);
    expect(error).toMatchObject({ profileStatus: status, message: `Active agent profile is ${status}: ${status} profile` });
  });
});

function activeProfile(revisionCharacter: string, command: string, dir: string): ActiveAgentProfileDescriptor {
  return {
    schemaVersion: 1,
    revision: `sha256:${revisionCharacter.repeat(64)}`,
    command,
    dir,
    sessionDirEnvKeys: ["PI_WEB_AGENT_SESSION_DIR"],
  };
}

function runtimeResponse(profile: ActiveAgentProfileDescriptor) {
  return {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      component: "sessiond",
      label: "Session daemon",
      available: true,
      capabilities: [],
      activeAgentProfile: profile,
    }),
  };
}
