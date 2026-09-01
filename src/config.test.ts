import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_ATTACHMENT_FOLDER, DEFAULT_EXTENSION_DIALOGS_TIMEOUT_MS, DEFAULT_MAX_UPLOAD_BYTES, DEFAULT_UPLOADS_FOLDER, AGENT_SESSION_DIR_ENV_KEYS, agentSessionDirEnvOverride, askUserEnabled, detectDeprecatedAgentInputs, effectiveAgentConfig, environmentFactsEnabled, effectivePiWebConfig, loadPiWebConfig, maxUploadBytes, offlineModeEnabled, savePiWebConfig, spawnSessionsEnabled, subsessionsEnabled } from "./config.js";

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

    expect(saved).toEqual({ path: configPath, exists: true, config: normalizedConfig, deprecatedAgentInputs: [] });
    expect(loadPiWebConfig(testOptions())).toEqual(saved);
  });

  it("preserves unrelated config keys while replacing managed keys", async () => {
    await writeFile(configPath, `${JSON.stringify({ host: "old", port: 8504, allowedHosts: true, plugins: { info: { enabled: false } }, pathAccess: { allowedPaths: ["/old"] }, uploads: { defaultFolder: "old" }, attachments: { defaultFolder: "old-attachments" }, serverPlugins: { safeStart: "none" }, future: { enabled: true } }, null, 2)}\n`, "utf8");

    savePiWebConfig({ port: 9000, allowedHosts: [], pathAccess: { allowedPaths: ["/new"] }, uploads: { defaultFolder: "new" }, attachments: { defaultFolder: "new-attachments" } }, testOptions());

    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({ serverPlugins: { safeStart: "none" }, future: { enabled: true }, port: 9000, allowedHosts: [], pathAccess: { allowedPaths: ["/new"] }, uploads: { defaultFolder: "new" }, attachments: { defaultFolder: "new-attachments" } });
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

  it("keeps a hand-edited extensionDialogsTimeoutMs across settings saves", async () => {
    await writeFile(configPath, `${JSON.stringify({ extensionDialogsTimeoutMs: 60_000 }, null, 2)}\n`, "utf8");

    savePiWebConfig({ port: 9000 }, testOptions());

    expect(loadPiWebConfig(testOptions()).config.extensionDialogsTimeoutMs).toBe(60_000);
  });

  it("drops a hand-edited respectProjectTrust key on save (option removed)", async () => {
    await writeFile(configPath, `${JSON.stringify({ respectProjectTrust: true, port: 8504 }, null, 2)}\n`, "utf8");

    expect(loadPiWebConfig(testOptions()).config).not.toHaveProperty("respectProjectTrust");
    savePiWebConfig({ port: 9000 }, testOptions());

    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({ port: 9000 });
  });

  it("rejects an invalid extensionDialogsTimeoutMs", async () => {
    for (const value of [-1, 1.5, "5000", null]) {
      await writeFile(configPath, `${JSON.stringify({ extensionDialogsTimeoutMs: value }, null, 2)}\n`, "utf8");

      expect(() => loadPiWebConfig(testOptions())).toThrow("PI WEB config extensionDialogsTimeoutMs must be a non-negative integer");
    }
  });

  it("persists and reads agent config keys, including the deprecated command", () => {
    savePiWebConfig({ agent: { command: "acme-agent", dir: "/opt/acme-agent/state" } }, testOptions());

    expect(loadPiWebConfig(testOptions()).config.agent).toEqual({ command: "acme-agent", dir: "/opt/acme-agent/state" });
  });

  it("defaults to the pi SDK agent directory", () => {
    expect(effectiveAgentConfig({ HOME: join(tempDir, ".home") })).toEqual({
      dir: join(tempDir, ".home", ".pi", "agent"),
    });
  });

  it("ignores the deprecated agent command when resolving the agent directory", () => {
    const home = { HOME: join(tempDir, ".home") };

    expect(effectiveAgentConfig(home, { agent: { command: "acme-agent" } })).toEqual(effectiveAgentConfig(home));
  });

  it.skipIf(process.platform === "win32")("rejects foreign-platform absolute agent state paths", () => {
    expect(() => effectiveAgentConfig({}, { agent: { dir: "C:\\profiles\\acme" } })).toThrow("agent.dir must be a host-absolute path");
  });

  it("rejects home expansion that would create a workspace-relative agent directory", () => {
    expect(() => effectiveAgentConfig({ HOME: "relative-home" })).toThrow("the agent directory default must be a host-absolute path");
  });

  it("attributes agent directory resolution failures to the input that supplied the directory", () => {
    expect(() => effectiveAgentConfig({ PI_WEB_AGENT_DIR: "relative/web", PI_CODING_AGENT_DIR: "relative/pi" })).toThrow("PI_WEB_AGENT_DIR must be a host-absolute path");
    expect(() => effectiveAgentConfig({ PI_CODING_AGENT_DIR: "relative/pi" })).toThrow("PI_CODING_AGENT_DIR must be a host-absolute path");
    expect(() => effectiveAgentConfig({}, { agent: { dir: "relative/config" } })).toThrow("agent.dir must be a host-absolute path");
  });

  it("expands the configured agent state directory against HOME", () => {
    expect(effectiveAgentConfig({ HOME: join(tempDir, ".home") }, { agent: { dir: "~/agent-profiles/acme" } })).toEqual({
      dir: join(tempDir, ".home", "agent-profiles", "acme"),
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

    expect(effectiveAgentConfig(env, { agent: { dir: "~/agent-profiles/acme" } })).toEqual({
      dir: join(tempDir, ".home", "agent-profiles", "acme"),
    });
    expect(agentSessionDirEnvOverride(env)).toBeUndefined();
  });

  it("resolves the agent directory with the deprecated alias first, then the canonical env var, then config", () => {
    const webDir = join(tempDir, "web-env-agent");
    const piDir = join(tempDir, "pi-env-agent");
    const configDir = join(tempDir, "config-agent");

    expect(effectiveAgentConfig({ PI_WEB_AGENT_DIR: webDir, PI_CODING_AGENT_DIR: piDir }, { agent: { dir: configDir } }).dir).toBe(webDir);
    expect(effectiveAgentConfig({ PI_CODING_AGENT_DIR: piDir }, { agent: { dir: configDir } }).dir).toBe(piDir);
    expect(effectiveAgentConfig({}, { agent: { dir: configDir } }).dir).toBe(configDir);
  });

  it("orders session directory env overrides with the deprecated alias first", () => {
    expect(AGENT_SESSION_DIR_ENV_KEYS).toEqual(["PI_WEB_AGENT_SESSION_DIR", "PI_CODING_AGENT_SESSION_DIR"]);
    expect(agentSessionDirEnvOverride({ PI_WEB_AGENT_SESSION_DIR: join(tempDir, "web-sessions"), PI_CODING_AGENT_SESSION_DIR: join(tempDir, "pi-sessions") })).toBe(join(tempDir, "web-sessions"));
    expect(agentSessionDirEnvOverride({ PI_CODING_AGENT_SESSION_DIR: join(tempDir, "pi-sessions") })).toBe(join(tempDir, "pi-sessions"));
    expect(agentSessionDirEnvOverride({})).toBeUndefined();
  });

  it("detects deprecated agent inputs from the environment and config", () => {
    expect(detectDeprecatedAgentInputs({})).toEqual([]);
    expect(detectDeprecatedAgentInputs({ PI_WEB_AGENT_COMMAND: "", PI_WEB_AGENT_DIR: "" })).toEqual([]);
    expect(detectDeprecatedAgentInputs({
      PI_WEB_AGENT_COMMAND: "acme-agent",
      PI_WEB_AGENT_DIR: "/state/acme",
      PI_WEB_AGENT_SESSION_DIR: "/state/acme/sessions",
    }, { agent: { command: "acme-agent", dir: "/state/acme" } })).toEqual([
      { source: "environment", name: "PI_WEB_AGENT_COMMAND" },
      { source: "environment", name: "PI_WEB_AGENT_DIR", replacement: "PI_CODING_AGENT_DIR" },
      { source: "environment", name: "PI_WEB_AGENT_SESSION_DIR", replacement: "PI_CODING_AGENT_SESSION_DIR" },
      { source: "config", name: "agent.command" },
      { source: "config", name: "agent.dir", replacement: "PI_CODING_AGENT_DIR" },
    ]);
  });

  it("reports detected deprecated inputs on the loaded config", async () => {
    expect(loadPiWebConfig(testOptions()).deprecatedAgentInputs).toEqual([]);
    expect(loadPiWebConfig({ env: { ...testOptions().env, PI_WEB_AGENT_DIR: join(tempDir, "agent") } }).deprecatedAgentInputs).toEqual([
      { source: "environment", name: "PI_WEB_AGENT_DIR", replacement: "PI_CODING_AGENT_DIR" },
    ]);

    await writeFile(configPath, `${JSON.stringify({ agent: { command: "acme-agent", dir: "/state/acme" } }, null, 2)}\n`, "utf8");

    expect(loadPiWebConfig(testOptions()).deprecatedAgentInputs).toEqual([
      { source: "config", name: "agent.command" },
      { source: "config", name: "agent.dir", replacement: "PI_CODING_AGENT_DIR" },
    ]);
  });

  it("rejects unknown nested agent keys instead of erasing them", async () => {
    const original = { agent: { command: "acme-agent", dir: join(tempDir, "agent"), futureSetting: true } };
    await writeFile(configPath, `${JSON.stringify(original, null, 2)}\n`, "utf8");

    expect(() => loadPiWebConfig(testOptions())).toThrow('PI WEB config agent accepts only the deprecated keys "command" and "dir"; unknown key "futureSetting"');
    expect(() => savePiWebConfig({ port: 9000 }, testOptions())).toThrow('PI WEB config agent accepts only the deprecated keys "command" and "dir"; unknown key "futureSetting"');
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual(original);
  });

  it("exposes the default upload folder in the effective config", () => {
    expect(effectivePiWebConfig(testOptions()).config.uploads).toEqual({ defaultFolder: DEFAULT_UPLOADS_FOLDER });
  });

  it("round-trips and normalizes the attachments default folder", () => {
    savePiWebConfig({ attachments: { defaultFolder: "dropped\\files" } }, testOptions());

    expect(loadPiWebConfig(testOptions()).config.attachments).toEqual({ defaultFolder: "dropped/files" });
  });

  it("exposes the effective attachments default folder, configured or built-in", async () => {
    expect(effectivePiWebConfig(testOptions()).config.attachments).toEqual({ defaultFolder: DEFAULT_ATTACHMENT_FOLDER });

    await writeFile(configPath, `${JSON.stringify({ attachments: { defaultFolder: "dropped" } }, null, 2)}\n`, "utf8");

    expect(effectivePiWebConfig(testOptions()).config.attachments).toEqual({ defaultFolder: "dropped" });
  });

  it("resolves askUser in the effective config so the runtime has a single source of truth", async () => {
    expect(effectivePiWebConfig(testOptions()).config.askUser).toBe(true);

    await writeFile(configPath, `${JSON.stringify({ askUser: false }, null, 2)}\n`, "utf8");

    expect(effectivePiWebConfig(testOptions()).config.askUser).toBe(false);
    expect(effectivePiWebConfig({ ...testOptions(), env: { ...testOptions().env, PI_WEB_ASK_USER: "1" } }).config.askUser).toBe(true);
  });

  it("round-trips the askUser key through save and load", () => {
    expect(savePiWebConfig({ askUser: false }, testOptions()).config).toEqual({ askUser: false });
    expect(loadPiWebConfig(testOptions()).config).toEqual({ askUser: false });
  });

  it("rejects a non-boolean askUser key", async () => {
    await writeFile(configPath, `${JSON.stringify({ askUser: "yes" }, null, 2)}\n`, "utf8");

    expect(() => loadPiWebConfig(testOptions())).toThrow("PI WEB config askUser must be a boolean");
  });

  it("round-trips and validates the environmentFacts key", async () => {
    expect(savePiWebConfig({ environmentFacts: false }, testOptions()).config).toEqual({ environmentFacts: false });
    expect(loadPiWebConfig(testOptions()).config).toEqual({ environmentFacts: false });
    expect(effectivePiWebConfig(testOptions()).config.environmentFacts).toBe(false);
    expect(effectivePiWebConfig({ ...testOptions(), env: { ...testOptions().env, PI_WEB_ENVIRONMENT_FACTS: "1" } }).config.environmentFacts).toBe(true);

    await writeFile(configPath, `${JSON.stringify({ environmentFacts: "no" }, null, 2)}\n`, "utf8");

    expect(() => loadPiWebConfig(testOptions())).toThrow("PI WEB config environmentFacts must be a boolean");
  });

  it("rejects upload defaults that are not workspace-relative", async () => {
    await writeFile(configPath, `${JSON.stringify({ uploads: { defaultFolder: "../outside" } }, null, 2)}\n`, "utf8");

    expect(() => loadPiWebConfig(testOptions())).toThrow("PI WEB config uploads.defaultFolder must not contain path traversal");
  });

  it("rejects attachment defaults that are not workspace-relative", async () => {
    await writeFile(configPath, `${JSON.stringify({ attachments: { defaultFolder: "../outside" } }, null, 2)}\n`, "utf8");

    expect(() => loadPiWebConfig(testOptions())).toThrow("PI WEB config attachments.defaultFolder must not contain path traversal");

    await writeFile(configPath, `${JSON.stringify({ attachments: { defaultFolder: "/absolute" } }, null, 2)}\n`, "utf8");

    expect(() => loadPiWebConfig(testOptions())).toThrow("PI WEB config attachments.defaultFolder must be workspace-relative");
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

describe("extensionDialogsTimeoutMs", () => {
  it("defaults to five minutes when nothing is configured", () => {
    expect(effectivePiWebConfig(testOptions()).config.extensionDialogsTimeoutMs).toBe(DEFAULT_EXTENSION_DIALOGS_TIMEOUT_MS);
  });

  it("resolves a configured value, including zero for waiting forever", async () => {
    await writeFile(configPath, `${JSON.stringify({ extensionDialogsTimeoutMs: 0 }, null, 2)}\n`, "utf8");

    expect(effectivePiWebConfig(testOptions()).config.extensionDialogsTimeoutMs).toBe(0);
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
  it("is on by default", () => {
    expect(subsessionsEnabled({}, {})).toBe(true);
  });

  it("honors an explicit config opt-out", () => {
    expect(subsessionsEnabled({}, { subsessions: false })).toBe(false);
  });

  it("lets the env var override the config in both directions", () => {
    expect(subsessionsEnabled({ PI_WEB_SUBSESSIONS: "1" }, { subsessions: false })).toBe(true);
    expect(subsessionsEnabled({ PI_WEB_SUBSESSIONS: "0" }, { subsessions: true })).toBe(false);
  });
});

describe("askUserEnabled", () => {
  it("is on by default because the user is present for every ask", () => {
    expect(askUserEnabled({}, {})).toBe(true);
  });

  it("honors an explicit config opt-out", () => {
    expect(askUserEnabled({}, { askUser: false })).toBe(false);
  });

  it("lets the env var override the config in both directions", () => {
    expect(askUserEnabled({ PI_WEB_ASK_USER: "0" }, { askUser: true })).toBe(false);
    expect(askUserEnabled({ PI_WEB_ASK_USER: "true" }, { askUser: false })).toBe(true);
  });

  it("treats an empty env value as unset", () => {
    expect(askUserEnabled({ PI_WEB_ASK_USER: "" }, { askUser: false })).toBe(false);
  });
});

describe("environmentFactsEnabled", () => {
  it("is on by default so a Docker deployment describes itself to agents", () => {
    expect(environmentFactsEnabled({}, {})).toBe(true);
  });

  it("honors an explicit config opt-out", () => {
    expect(environmentFactsEnabled({}, { environmentFacts: false })).toBe(false);
  });

  it("lets the env var override the config in both directions", () => {
    expect(environmentFactsEnabled({ PI_WEB_ENVIRONMENT_FACTS: "0" }, { environmentFacts: true })).toBe(false);
    expect(environmentFactsEnabled({ PI_WEB_ENVIRONMENT_FACTS: "true" }, { environmentFacts: false })).toBe(true);
  });

  it("treats an empty env value as unset", () => {
    expect(environmentFactsEnabled({ PI_WEB_ENVIRONMENT_FACTS: "" }, { environmentFacts: false })).toBe(false);
  });
});

describe("offlineModeEnabled", () => {
  it("is off when no offline env var is set", () => {
    expect(offlineModeEnabled({})).toBe(false);
  });

  it("treats an empty value as unset", () => {
    expect(offlineModeEnabled({ PI_OFFLINE: "", PI_WEB_OFFLINE: "" })).toBe(false);
  });

  it("is on when either offline key has a value", () => {
    expect(offlineModeEnabled({ PI_OFFLINE: "1" })).toBe(true);
    expect(offlineModeEnabled({ PI_WEB_OFFLINE: "anything" })).toBe(true);
  });

  it("ignores the narrower skip-version-check keys", () => {
    expect(offlineModeEnabled({ PI_SKIP_VERSION_CHECK: "1", PI_WEB_SKIP_VERSION_CHECK: "1" })).toBe(false);
  });
});

function testOptions(): { env: NodeJS.ProcessEnv } {
  return { env: { PI_WEB_CONFIG: configPath } };
}
