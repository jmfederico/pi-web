import { describe, expect, it } from "vitest";
import type { EffectivePiWebAgentConfig } from "../config.js";
import { createActiveAgentProfileDescriptor } from "./activeAgentProfile.js";

const baseAgent: EffectivePiWebAgentConfig = {
  dir: "/opt/pi/state",
};

describe("active agent profile descriptor", () => {
  it("reports the resolved agent state directory for the daemon lifetime", () => {
    expect(createActiveAgentProfileDescriptor(baseAgent)).toEqual({ schemaVersion: 2, dir: baseAgent.dir });
    expect(createActiveAgentProfileDescriptor({ dir: "/other/state" }).dir).toBe("/other/state");
  });

  it("takes an immutable snapshot for the session daemon profile epoch", () => {
    const profile = createActiveAgentProfileDescriptor(baseAgent);

    expect(Object.isFrozen(profile)).toBe(true);
    expect(Reflect.set(profile, "dir", "/mutated/state")).toBe(false);
    expect(profile.dir).toBe(baseAgent.dir);
  });

  it("rejects a state directory that is not valid for this host", () => {
    expect(() => createActiveAgentProfileDescriptor({ dir: "relative/state" })).toThrow("must be valid for this host");
    expect(() => createActiveAgentProfileDescriptor({ dir: "" })).toThrow("must be valid for this host");
  });

  it("copies only the secret-free descriptor fields", () => {
    const input = {
      ...baseAgent,
      token: "must-not-cross-the-protocol",
      auth: { apiKey: "also-secret" },
    };

    const profile = createActiveAgentProfileDescriptor(input);

    expect(profile).toEqual({ schemaVersion: 2, dir: baseAgent.dir });
    expect(JSON.stringify(profile)).not.toContain("secret");
  });
});
