import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_MAX_UPLOAD_BYTES, DEFAULT_UPLOADS_FOLDER, effectiveAgentConfig, effectivePiWebConfig, loadPiWebConfig, maxUploadBytes, savePiWebConfig, spawnSessionsEnabled, subsessionsEnabled } from "./config.js";

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
    const saved = savePiWebConfig({ host: "0.0.0.0", port: 9000, allowedHosts: ["example.local"], shortcuts: { "core:view.chat": "mod+1", "core:session.stop": null }, plugins: { "workspace-tasks": { enabled: false, settings: { configPath: ".pi-web/tasks.json" } } }, pathAccess: { allowedPaths: ["/tmp", "~/SDKs"] }, uploads: { defaultFolder: "manual\\incoming" } }, testOptions());

    expect(saved).toEqual({ path: configPath, exists: true, config: { host: "0.0.0.0", port: 9000, allowedHosts: ["example.local"], shortcuts: { "core:view.chat": "mod+1", "core:session.stop": null }, plugins: { "workspace-tasks": { enabled: false, settings: { configPath: ".pi-web/tasks.json" } } }, pathAccess: { allowedPaths: ["/tmp", "~/SDKs"] }, uploads: { defaultFolder: "manual/incoming" } } });
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
    savePiWebConfig({ agent: { command: "omp", dir: "~/.omp/agent" } }, testOptions());

    expect(loadPiWebConfig(testOptions()).config.agent).toEqual({ command: "omp", dir: "~/.omp/agent" });
  });

  it("resolves OMP agent defaults from the configured command", () => {
    expect(effectiveAgentConfig({ HOME: join(tempDir, ".home") }, { agent: { command: "omp" } })).toMatchObject({
      command: "omp",
      dir: join(tempDir, ".home", ".omp", "agent"),
      sessionDirEnvKeys: ["PI_WEB_AGENT_SESSION_DIR", "OMP_CODING_AGENT_SESSION_DIR", "PI_CODING_AGENT_SESSION_DIR"],
    });
  });

  it("lets PI WEB agent environment overrides take precedence", () => {
    expect(effectiveAgentConfig({
      PI_WEB_AGENT_COMMAND: "omp",
      PI_WEB_AGENT_DIR: join(tempDir, "env-agent"),
    }, { agent: { command: "pi", dir: join(tempDir, "config-agent") } })).toMatchObject({
      command: "omp",
      dir: join(tempDir, "env-agent"),
    });
  });

  it("lets command-specific agent environment directories override config", () => {
    expect(effectiveAgentConfig({
      HOME: join(tempDir, ".home"),
      OMP_CODING_AGENT_DIR: join(tempDir, "omp-env-agent"),
    }, { agent: { command: "omp", dir: join(tempDir, "config-agent") } })).toMatchObject({
      command: "omp",
      dir: join(tempDir, "omp-env-agent"),
    });
  });

  it("normalizes omp.exe to OMP environment keys", () => {
    expect(effectiveAgentConfig({
      HOME: join(tempDir, ".home"),
      OMP_CODING_AGENT_DIR: join(tempDir, "omp-exe-env-agent"),
    }, { agent: { command: "omp.exe", dir: join(tempDir, "config-agent") } })).toMatchObject({
      command: "omp.exe",
      dir: join(tempDir, "omp-exe-env-agent"),
      sessionDirEnvKeys: ["PI_WEB_AGENT_SESSION_DIR", "OMP_CODING_AGENT_SESSION_DIR", "PI_CODING_AGENT_SESSION_DIR"],
    });
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
