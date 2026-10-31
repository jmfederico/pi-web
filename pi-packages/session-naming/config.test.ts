import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSessionNamingConfig, parseSessionNamingConfig, resolveSessionNamingConfig, sessionNamingAgentDir, sessionNamingConfigPath } from "./config.js";

describe("session naming configuration", () => {
  it("uses the canonical profile environment, expands home paths, and defaults to the Pi agent directory", () => {
    const home = join(tmpdir(), "profile-home");
    const explicit = join(tmpdir(), "custom-profile");
    expect(sessionNamingAgentDir({ PI_CODING_AGENT_DIR: explicit }, home)).toBe(explicit);
    expect(sessionNamingAgentDir({ PI_CODING_AGENT_DIR: "~/custom/profile" }, home)).toBe(join(home, "custom", "profile"));
    expect(sessionNamingAgentDir({ PI_CODING_AGENT_DIR: "~" }, home)).toBe(home);
    expect(sessionNamingAgentDir({}, home)).toBe(join(home, ".pi", "agent"));
    expect(sessionNamingAgentDir({ PI_CODING_AGENT_DIR: "" }, home)).toBe(join(home, ".pi", "agent"));
  });
  it("resolves defaults and overlays tuning without inventing a model", () => {
    expect(resolveSessionNamingConfig()).toEqual({ maxTokens: 24, thinkingLevel: "minimal", timeoutMs: 10_000 });
    expect(resolveSessionNamingConfig({ model: "vendor/model/path", maxTokens: 48 }, { maxTokens: 72, thinkingLevel: "off" }))
      .toEqual({ model: "vendor/model/path", maxTokens: 72, thinkingLevel: "off", timeoutMs: 10_000 });
  });

  it.each([null, [], false, { enabled: true }, { typo: 24 }, { model: "model" }, { model: "a/" }, { model: "a/b c" },
    { maxTokens: 0 }, { maxTokens: 1.1 }, { maxTokens: Number.MAX_SAFE_INTEGER + 1 },
    { thinkingLevel: "unknown" }, { timeoutMs: 0 }, { timeoutMs: 2_147_483_648 }])("rejects invalid tuning %j", (value) => {
    expect(() => parseSessionNamingConfig(value)).toThrow();
  });

  it("reads file and environment afresh, and reports invalid JSON instead of hiding it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "session-naming-"));
    try {
      expect(await loadSessionNamingConfig(dir, {})).toEqual(resolveSessionNamingConfig());
      await mkdir(join(dir, "session-naming"));
      await writeFile(sessionNamingConfigPath(dir), JSON.stringify({ maxTokens: 50, model: "vendor/small" }));
      expect(await loadSessionNamingConfig(dir, { PI_WEB_SESSION_NAMING: '{"maxTokens":80}' }))
        .toMatchObject({ maxTokens: 80, model: "vendor/small" });
      await writeFile(sessionNamingConfigPath(dir), '{"maxTokens":90}');
      expect(await loadSessionNamingConfig(dir, {})).toMatchObject({ maxTokens: 90 });
      await writeFile(sessionNamingConfigPath(dir), "{");
      await expect(loadSessionNamingConfig(dir, {})).rejects.toThrow();
      await writeFile(sessionNamingConfigPath(dir), "{}");
      await expect(loadSessionNamingConfig(dir, { PI_WEB_SESSION_NAMING: '{"enabled":false}' })).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
