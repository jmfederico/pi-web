import { describe, expect, it } from "vitest";
import type { EffectivePiWebAgentConfig } from "../config.js";
import { createActiveAgentProfileDescriptor } from "./activeAgentProfile.js";

const baseAgent: EffectivePiWebAgentConfig = {
  command: "acme-agent",
  dir: "/opt/acme-agent/state",
  sessionDirEnvKeys: ["PI_WEB_AGENT_SESSION_DIR"],
};

describe("active agent profile descriptor", () => {
  it("builds a stable revision from every effective profile field", () => {
    const first = createActiveAgentProfileDescriptor(baseAgent);
    const second = createActiveAgentProfileDescriptor({ ...baseAgent, sessionDirEnvKeys: [...baseAgent.sessionDirEnvKeys] });

    expect(second).toEqual(first);
    expect(first.revision).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(createActiveAgentProfileDescriptor({ ...baseAgent, command: "other-agent" }).revision).not.toBe(first.revision);
    expect(createActiveAgentProfileDescriptor({ ...baseAgent, dir: "/other/state" }).revision).not.toBe(first.revision);
    expect(createActiveAgentProfileDescriptor({ ...baseAgent, sessionDirEnvKeys: ["PI_WEB_AGENT_SESSION_DIR", "PI_CODING_AGENT_SESSION_DIR"] }).revision).not.toBe(first.revision);
  });

  it("takes an immutable snapshot for the session daemon profile epoch", () => {
    const sessionDirEnvKeys = ["PI_WEB_AGENT_SESSION_DIR"];
    const profile = createActiveAgentProfileDescriptor({ ...baseAgent, sessionDirEnvKeys });
    sessionDirEnvKeys.push("LATE_MUTATION");

    expect(Object.isFrozen(profile)).toBe(true);
    expect(Object.isFrozen(profile.sessionDirEnvKeys)).toBe(true);
    expect(profile.sessionDirEnvKeys).toEqual(["PI_WEB_AGENT_SESSION_DIR"]);
    expect(Reflect.set(profile, "command", "mutated-agent")).toBe(false);
    expect(Reflect.set(profile.sessionDirEnvKeys, "0", "MUTATED_SESSION_DIR")).toBe(false);
  });

  it("rejects profile fields outside the host and explicit environment policy", () => {
    expect(() => createActiveAgentProfileDescriptor({ ...baseAgent, command: "./acme-agent" })).toThrow("must be valid for this host");
    expect(() => createActiveAgentProfileDescriptor({ ...baseAgent, dir: "relative/state" })).toThrow("must be valid for this host");
    expect(() => createActiveAgentProfileDescriptor({ ...baseAgent, sessionDirEnvKeys: ["ARBITRARY_AGENT_SESSION_DIR"] })).toThrow("explicit PI WEB policy");
  });

  it("copies only the secret-free descriptor fields", () => {
    const input = {
      ...baseAgent,
      token: "must-not-cross-the-protocol",
      auth: { apiKey: "also-secret" },
    };

    const profile = createActiveAgentProfileDescriptor(input);

    expect(profile).toEqual({
      schemaVersion: 1,
      revision: profile.revision,
      command: baseAgent.command,
      dir: baseAgent.dir,
      sessionDirEnvKeys: baseAgent.sessionDirEnvKeys,
    });
    expect(profile.revision).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(JSON.stringify(profile)).not.toContain("secret");
  });
});
