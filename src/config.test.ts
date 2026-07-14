import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_MAX_UPLOAD_BYTES, DEFAULT_UPLOADS_FOLDER, agentDirEnvSource, agentSessionDirEnvKeys, effectiveAgentConfig, effectivePiWebConfig, hasAgentDirEnvOverride, hasAgentSessionDirEnvOverride, loadPiWebConfig, maxUploadBytes, savePiWebConfig, spawnSessionsEnabled, subsessionsEnabled } from "./config.js";

let tempDir: string;
let configPath: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-web-config-test-"));
  configPath = join(tempDir, "config.json");
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("PI WEB config persistence", () => {
  it("writes and reads the configured PI WEB config path", () => {
    const requestedConfig = {
      host: "0.0.0.0",
      port: 9000,
      allowedHosts: ["example.local"],
      shortcuts: { "core:view.chat": "mod+1", "core:session.stop": null },
      plugins: { "workspace-tasks": { enabled: false, settings: { configPath: ".pi-web/tasks.json" } } },
      pathAccess: { allowedPaths: ["/tmp", "~/SDKs"] },
      uploads: { defaultFolder: "manual\\incoming" },
    };
    const normalizedConfig = {
      ...requestedConfig,
      uploads: { defaultFolder: "manual/incoming" },
    };

    const saved = savePiWebConfig(requestedConfig, testOptions());

    expect(saved).toEqual({ path: configPath, exists: true, config: normalizedConfig });
    expect(loadPiWebConfig(testOptions())).toEqual(saved);
  });

  it("preserves unrelated config keys while replacing managed keys", async () => {
    await writeFile(configPath, `${JSON.stringify({ host: "old", port: 8504, allowedHosts: true, plugins: { info: { enabled: false } }, pathAccess: { allowedPaths: ["/old"] }, uploads: { defaultFolder: "old" }, future: { enabled: true } }, null, 2)}\n`, "utf8");

    savePiWebConfig({ port: 9000, allowedHosts: [], pathAccess: { allowedPaths: ["/new"] }, uploads: { defaultFolder: "new" } }, testOptions());

    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({ future: { enabled: true }, port: 9000, allowedHosts: [], pathAccess: { allowedPaths: ["/new"] }, uploads: { defaultFolder: "new" } });
  });

  it("rejects invalid plugin config", async () => {
    await writeFile(configPath, `${JSON.stringify({ plugins: { info: { enabled: "no" } } }, null, 2)}\n`, "utf8");

    expect(() => loadPiWebConfig(testOptions())).toThrow("PI WEB config plugin enabled values must be booleans");
  });

  it("rejects invalid path access config", async () => {
    await writeFile(configPath, `${JSON.stringify({ pathAccess: { allowedPaths: [""] } }, null, 2)}\n`, "utf8");

    expect(() => loadPiWebConfig(testOptions())).toThrow("PI WEB config pathAccess.allowedPaths must be an array of non-empty strings");
  });

  it("persists and reads maxUploadBytes", () => {
    savePiWebConfig({ maxUploadBytes: 1234 }, testOptions());
    expect(loadPiWebConfig(testOptions()).config.maxUploadBytes).toBe(1234);
  });

  it("persists and reads custom agent runtime settings", () => {
    savePiWebConfig({ agent: { command: "acme-agent", dir: "/opt/acme-agent/state" } }, testOptions());

    expect(loadPiWebConfig(testOptions()).config.agent).toEqual({ command: "acme-agent", dir: "/opt/acme-agent/state" });
  });

  it("defaults to the Pi agent directory only for canonical Pi companion names", () => {
    for (const command of ["pi", "pi.cmd"]) {
      expect(effectiveAgentConfig({ HOME: join(tempDir, ".home") }, { agent: { command } })).toMatchObject({
        command,
        dir: join(tempDir, ".home", ".pi", "agent"),
        sessionDirEnvKeys: ["PI_WEB_AGENT_SESSION_DIR", "PI_CODING_AGENT_SESSION_DIR"],
      });
    }
  });

  it("requires explicit state for alternate names and absolute Pi launchers", () => {
    const absolutePiCommand = join(tempDir, "bin", "pi");
    for (const command of ["acme-agent", absolutePiCommand]) {
      expect(() => effectiveAgentConfig({}, { agent: { command } })).toThrow(`PI WEB config agent.dir or PI_WEB_AGENT_DIR is required when agent.command is ${JSON.stringify(command)}`);
      expect(() => savePiWebConfig({ agent: { command } }, testOptions())).toThrow(`PI WEB config agent.dir or PI_WEB_AGENT_DIR is required when agent.command is ${JSON.stringify(command)}`);
    }
  });

  it("accepts safe bare executable names and host-absolute executable paths", () => {
    const absoluteCommand = join(tempDir, "bin", "acme-agent");
    const agentDir = join(tempDir, "state", "acme");

    expect(effectiveAgentConfig({}, { agent: { command: "acme-agent", dir: agentDir } })).toMatchObject({ command: "acme-agent", dir: agentDir });
    expect(effectiveAgentConfig({}, { agent: { command: absoluteCommand, dir: agentDir } })).toMatchObject({ command: absoluteCommand, dir: agentDir });
  });

  it.each(["./acme-agent", "bin/acme-agent", "../acme-agent", "node acme-agent.js", "acme-agent;other", "-acme-agent"])("rejects unsafe or workspace-relative agent command %j", (command) => {
    expect(() => savePiWebConfig({ agent: { command, dir: join(tempDir, "agent") } }, testOptions())).toThrow("safe bare executable name or host-absolute executable path");
  });

  it.skipIf(process.platform === "win32")("rejects foreign-platform absolute agent command and state paths", () => {
    expect(() => effectiveAgentConfig({}, { agent: { command: "C:\\tools\\acme-agent.exe", dir: join(tempDir, "agent") } })).toThrow("safe bare executable name or host-absolute executable path");
    expect(() => effectiveAgentConfig({}, { agent: { command: "acme-agent", dir: "C:\\profiles\\acme" } })).toThrow("agent.dir must be a host-absolute path");
  });

  it("rejects home expansion that would create a workspace-relative agent directory", () => {
    expect(() => effectiveAgentConfig({ HOME: "relative-home" })).toThrow("agent.dir must be a host-absolute path");
  });

  it("resolves explicit alternate agent command and state directory settings", () => {
    expect(effectiveAgentConfig({ HOME: join(tempDir, ".home") }, { agent: { command: "acme-agent", dir: "~/agent-profiles/acme" } })).toMatchObject({
      command: "acme-agent",
      dir: join(tempDir, ".home", "agent-profiles", "acme"),
      sessionDirEnvKeys: ["PI_WEB_AGENT_SESSION_DIR"],
    });
  });

  it("ignores empty agent environment overrides", () => {
    const env = {
      HOME: join(tempDir, ".home"),
      PI_WEB_AGENT_COMMAND: "",
      PI_WEB_AGENT_DIR: "",
      PI_WEB_AGENT_SESSION_DIR: "",
      PI_CODING_AGENT_DIR: "",
      PI_CODING_AGENT_SESSION_DIR: "",
    };

    expect(effectiveAgentConfig(env, { agent: { command: "acme-agent", dir: "~/agent-profiles/acme" } })).toMatchObject({
      command: "acme-agent",
      dir: join(tempDir, ".home", "agent-profiles", "acme"),
    });
    expect(hasAgentDirEnvOverride(env, "acme-agent")).toBe(false);
    expect(hasAgentSessionDirEnvOverride(env, "acme-agent")).toBe(false);
  });

  it("uses explicit PI WEB agent directory env precedence", () => {
    const env = {
      PI_WEB_AGENT_COMMAND: "acme-agent",
      PI_WEB_AGENT_DIR: join(tempDir, "web-env-agent"),
      PI_CODING_AGENT_DIR: join(tempDir, "pi-env-agent"),
    };
    expect(effectiveAgentConfig(env, { agent: { command: "pi", dir: join(tempDir, "config-agent") } })).toMatchObject({
      command: "acme-agent",
      dir: join(tempDir, "web-env-agent"),
    });
    expect(agentDirEnvSource(env)).toBe("pi-web");
  });

  it("keeps legacy Pi env directory overrides scoped to the canonical Pi command", () => {
    const legacyDir = join(tempDir, "pi-env-agent");
    const alternateDir = join(tempDir, "alternate-agent");
    const env = { PI_CODING_AGENT_DIR: legacyDir };
    expect(effectiveAgentConfig(env, { agent: { dir: join(tempDir, "config-agent") } })).toMatchObject({ dir: legacyDir });
    expect(effectiveAgentConfig(env, { agent: { command: "acme-agent", dir: alternateDir } })).toMatchObject({ command: "acme-agent", dir: alternateDir });
    expect(agentDirEnvSource(env)).toBe("pi-compatibility");
    expect(hasAgentDirEnvOverride(env, "pi")).toBe(true);
    expect(hasAgentDirEnvOverride(env, "acme-agent")).toBe(false);

    for (const command of ["acme-agent", join(tempDir, "bin", "pi")]) {
      expect(() => effectiveAgentConfig(env, { agent: { command } }))
        .toThrow(`PI WEB config agent.dir or PI_WEB_AGENT_DIR is required when agent.command is ${JSON.stringify(command)}`);
    }
  });

  it("uses only explicit session directory env keys", () => {
    expect(agentSessionDirEnvKeys()).toEqual(["PI_WEB_AGENT_SESSION_DIR", "PI_CODING_AGENT_SESSION_DIR"]);
    expect(effectiveAgentConfig({ HOME: join(tempDir, ".home"), PI_WEB_AGENT_COMMAND: "acme-agent", PI_WEB_AGENT_DIR: join(tempDir, "agent") }).sessionDirEnvKeys).toEqual(["PI_WEB_AGENT_SESSION_DIR"]);
    expect(agentSessionDirEnvKeys(join(tempDir, "bin", "pi"))).toEqual(["PI_WEB_AGENT_SESSION_DIR"]);
  });

  it("rejects unknown nested agent keys instead of erasing them", async () => {
    const original = { agent: { command: "acme-agent", dir: join(tempDir, "agent"), futureSetting: true } };
    await writeFile(configPath, `${JSON.stringify(original, null, 2)}\n`, "utf8");

    expect(() => loadPiWebConfig(testOptions())).toThrow('PI WEB config agent contains unknown key "futureSetting"');
    expect(() => savePiWebConfig({ port: 9000 }, testOptions())).toThrow('PI WEB config agent contains unknown key "futureSetting"');
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual(original);
  });

  it("exposes the default upload folder in the effective config", () => {
    expect(effectivePiWebConfig(testOptions()).config.uploads).toEqual({ defaultFolder: DEFAULT_UPLOADS_FOLDER });
  });

  it("rejects upload defaults that are not workspace-relative", async () => {
    await writeFile(configPath, `${JSON.stringify({ uploads: { defaultFolder: "../outside" } }, null, 2)}\n`, "utf8");

    expect(() => loadPiWebConfig(testOptions())).toThrow("PI WEB config uploads.defaultFolder must not contain path traversal");
  });
});

describe("maxUploadBytes", () => {
  it("defaults when nothing is configured", () => {
    expect(maxUploadBytes({}, {})).toBe(DEFAULT_MAX_UPLOAD_BYTES);
  });

  it("prefers the env override over config", () => {
    expect(maxUploadBytes({ PI_WEB_MAX_UPLOAD_BYTES: "2048" }, { maxUploadBytes: 99 })).toBe(2048);
  });

  it("falls back to config when env is unset or invalid", () => {
    expect(maxUploadBytes({ PI_WEB_MAX_UPLOAD_BYTES: "not-a-number" }, { maxUploadBytes: 555 })).toBe(555);
  });
});

describe("spawnSessionsEnabled", () => {
  it("is on by default when nothing is configured", () => {
    expect(spawnSessionsEnabled({}, {})).toBe(true);
  });

  it("honors an explicit config opt-out", () => {
    expect(spawnSessionsEnabled({}, { spawnSessions: false })).toBe(false);
  });

  it("lets the env var override the config in both directions", () => {
    expect(spawnSessionsEnabled({ PI_WEB_SPAWN_SESSIONS: "0" }, { spawnSessions: true })).toBe(false);
    expect(spawnSessionsEnabled({ PI_WEB_SPAWN_SESSIONS: "1" }, { spawnSessions: false })).toBe(true);
  });
});

describe("subsessionsEnabled", () => {
  it("is off by default while the capability is in beta", () => {
    expect(subsessionsEnabled({}, {})).toBe(false);
  });

  it("honors an explicit config opt-in", () => {
    expect(subsessionsEnabled({}, { subsessions: true })).toBe(true);
  });

  it("lets the env var override the config in both directions", () => {
    expect(subsessionsEnabled({ PI_WEB_SUBSESSIONS: "1" }, { subsessions: false })).toBe(true);
    expect(subsessionsEnabled({ PI_WEB_SUBSESSIONS: "0" }, { subsessions: true })).toBe(false);
  });
});

function testOptions(): { env: NodeJS.ProcessEnv } {
  return { env: { PI_WEB_CONFIG: configPath } };
}
