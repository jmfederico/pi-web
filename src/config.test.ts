import { chmod, lstat, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_ATTACHMENT_FOLDER, DEFAULT_EXTENSION_DIALOGS_TIMEOUT_MS, DEFAULT_MAX_UPLOAD_BYTES, DEFAULT_UPLOADS_FOLDER, AGENT_SESSION_DIR_ENV_KEYS, agentSessionDirEnvOverride, askUserEnabled, detectDeprecatedAgentInputs, effectiveAgentConfig, environmentFactsEnabled, effectivePiWebConfig, loadPiWebConfig, maxUploadBytes, offlineModeEnabled, savePiWebConfig, sessionArchiveDirectory, sessionMessagesEnabled, spawnSessionsEnabled, subsessionsEnabled, applyPiWebConfigEnv, overlayPiWebConfig, piWebConfigSources, piWebConfigEnforcedSettings, resolveEffectivePiWebConfig } from "./config.js";

let tempDir: string;
let configPath: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-web-config-test-"));
  configPath = join(tempDir, "config.json");
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("configuration save integrity", () => {
  it.skipIf(process.platform === "win32")("preserves config symlinks and target permissions during atomic updates", async () => {
    const target = join(tempDir, "target.json");
    await writeFile(target, "{}");
    await chmod(target, 0o640);
    await symlink(target, configPath);
    savePiWebConfig({ installationName: "Office" }, testOptions());
    expect((await lstat(configPath)).isSymbolicLink()).toBe(true);
    expect((await stat(target)).mode & 0o777).toBe(0o640);
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ installationName: "Office" });
    expect((await readdir(tempDir)).sort()).toEqual(["config.json", "target.json"]);
  });

  it("validates bootstrap boolean policies before resolving effective configuration", () => {
    expect(() => effectivePiWebConfig({ env: { PI_WEB_CONFIG: configPath, PI_WEB_SKIP_VERSION_CHECK: "perhaps" } })).toThrow("PI_WEB_SKIP_VERSION_CHECK");
    expect(() => effectivePiWebConfig({ env: { PI_WEB_CONFIG: configPath, PI_WEB_OFFLINE: "yes" } })).toThrow("PI_WEB_OFFLINE");
  });
});

describe("default localization", () => {
  it("round-trips, preserves, resets, and removes file defaults", async () => {
    const defaultLocalization = { language: "de", formatLocale: "en-GB", timeZone: "UTC", hourCycle: "h24" } as const;
    savePiWebConfig({ defaultLocalization }, testOptions());
    expect(loadPiWebConfig(testOptions()).config.defaultLocalization).toEqual(defaultLocalization);
    savePiWebConfig({ ...loadPiWebConfig(testOptions()).config, port: 9000 }, testOptions());
    expect(effectivePiWebConfig(testOptions()).config.defaultLocalization).toEqual(defaultLocalization);
    savePiWebConfig({ defaultLocalization: {} }, testOptions());
    expect(loadPiWebConfig(testOptions()).config.defaultLocalization).toEqual({});
    expect(JSON.parse(await readFile(configPath, "utf8"))).toHaveProperty("defaultLocalization", {});
    savePiWebConfig({}, testOptions());
    expect(loadPiWebConfig(testOptions()).config).not.toHaveProperty("defaultLocalization");
    expect(JSON.parse(await readFile(configPath, "utf8"))).not.toHaveProperty("defaultLocalization");
  });

  it("validates localization defaults on both load and save", async () => {
    // Detailed invalid-value coverage belongs to defaultLocalization.test.ts.
    const defaultLocalization = { language: "en_US" };
    await writeFile(configPath, JSON.stringify({ defaultLocalization }), "utf8");
    expect(() => loadPiWebConfig(testOptions())).toThrow("PI WEB config defaultLocalization");
    // The persistence boundary also validates runtime input from untyped callers.
    expect(() => savePiWebConfig({ defaultLocalization }, testOptions())).toThrow("PI WEB config defaultLocalization");
  });
});

describe("installation name", () => {
  it("round-trips trimmed names and removes the saved identity", () => {
    savePiWebConfig({ installationName: "  Build lab  " }, testOptions());
    expect(loadPiWebConfig(testOptions()).config.installationName).toBe("Build lab");
    savePiWebConfig({ installationName: "" }, testOptions());
    expect(loadPiWebConfig(testOptions()).config.installationName).toBe("");
    savePiWebConfig({}, testOptions());
    expect(loadPiWebConfig(testOptions()).config).not.toHaveProperty("installationName");
  });

  it.each([null, 123, {}, "x".repeat(121), "Lab\nOffice"])("rejects invalid names %j", async (installationName) => {
    await writeFile(configPath, JSON.stringify({ installationName }), "utf8");
    expect(() => loadPiWebConfig(testOptions())).toThrow("installationName");
  });
});

describe("sessionArchive config", () => {
  it("round-trips, preserves on unrelated saves, and removes the override", () => {
    const sessionArchive = { directory: "archive-files" };
    savePiWebConfig({ sessionArchive }, testOptions());
    expect(loadPiWebConfig(testOptions()).config.sessionArchive).toEqual(sessionArchive);
    savePiWebConfig({ ...loadPiWebConfig(testOptions()).config, port: 9000 }, testOptions());
    expect(effectivePiWebConfig(testOptions()).config.sessionArchive).toEqual(sessionArchive);
    savePiWebConfig({}, testOptions());
    expect(loadPiWebConfig(testOptions()).config).not.toHaveProperty("sessionArchive");
  });

  it.each([null, [], "archive", { unknown: true }, { directory: "" }, { directory: "   " }, { directory: 1 }, { directory: null }, { directory: "a\u0000b" }])("rejects invalid archive config %j", async (sessionArchive) => {
    await writeFile(configPath, JSON.stringify({ sessionArchive }), "utf8");
    expect(() => loadPiWebConfig(testOptions())).toThrow("PI WEB config sessionArchive");
  });

  it("resolves the default, config, and environment destinations against the process cwd", () => {
    const env = { PI_WEB_DATA_DIR: "state" };
    const config = { sessionArchive: { directory: "configured" } };
    expect(sessionArchiveDirectory(env, {}, tempDir)).toBe(join(tempDir, "state", "archived-sessions"));
    expect(sessionArchiveDirectory(env, config, tempDir)).toBe(join(tempDir, "configured"));
    expect(sessionArchiveDirectory({ ...env, PI_WEB_SESSION_ARCHIVE_DIR: "external" }, config, tempDir)).toBe(join(tempDir, "external"));
    expect(sessionArchiveDirectory({ ...env, PI_WEB_SESSION_ARCHIVE_DIR: "" }, config, tempDir)).toBe(join(tempDir, "configured"));
    expect(sessionArchiveDirectory({}, { sessionArchive: { directory: tempDir } }, resolve(tempDir, "other"))).toBe(tempDir);
    expect(sessionArchiveDirectory(env, { sessionArchive: {} }, tempDir)).toBe(join(tempDir, "state", "archived-sessions"));
  });
});

describe("PI WEB config persistence", () => {
  it("writes and reads the configured PI WEB config path", () => {
    const requestedConfig = {
      host: "0.0.0.0",
      port: 9000,
      defaultTheme: { themeId: "custom-theme:night", auto: false },
      allowedHosts: ["example.local"],
      shortcuts: { "core:view.chat": "mod+1", "core:session.stop": null },
      plugins: {
        "pi-web.terminal": { enabled: false },
        "workspace-tasks": { enabled: false, settings: { configPath: ".pi-web/tasks.json" } },
      },
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

  it("preserves the theme default across unrelated saves and allows removing it", async () => {
    const defaultTheme = { themeId: "themes:pi-web-light", auto: false };
    savePiWebConfig({ defaultTheme, shortcuts: { "core:view.chat": "mod+1" } }, testOptions());
    const current = loadPiWebConfig(testOptions()).config;
    savePiWebConfig({ ...current, port: 9000 }, testOptions());
    expect(effectivePiWebConfig(testOptions()).config.defaultTheme).toEqual(defaultTheme);

    savePiWebConfig({ port: 9000 }, testOptions());
    expect(loadPiWebConfig(testOptions()).config.defaultTheme).toBeUndefined();
    expect(JSON.parse(await readFile(configPath, "utf8"))).not.toHaveProperty("defaultTheme");
  });

  it("rejects an invalid theme default rather than silently ignoring it", async () => {
    await writeFile(configPath, JSON.stringify({ defaultTheme: { themeId: "light", auto: true } }), "utf8");
    expect(() => loadPiWebConfig(testOptions())).toThrow("PI WEB config defaultTheme");
  });

  it.each(["steer", "followUp"] as const)("round-trips and clears defaultStreamingBehavior %s", async (defaultStreamingBehavior) => {
    savePiWebConfig({ defaultStreamingBehavior }, testOptions());
    expect(loadPiWebConfig(testOptions()).config.defaultStreamingBehavior).toBe(defaultStreamingBehavior);
    const current = loadPiWebConfig(testOptions()).config;
    savePiWebConfig({ ...current, port: 9000 }, testOptions());
    expect(effectivePiWebConfig(testOptions()).config.defaultStreamingBehavior).toBe(defaultStreamingBehavior);

    savePiWebConfig({ port: 9000 }, testOptions());
    expect(loadPiWebConfig(testOptions()).config).not.toHaveProperty("defaultStreamingBehavior");
    expect(JSON.parse(await readFile(configPath, "utf8"))).not.toHaveProperty("defaultStreamingBehavior");
  });

  it.each(["", "followup", "queue", null, false, 42, {}, []])("rejects invalid defaultStreamingBehavior %j on load and save", async (value) => {
    await writeFile(configPath, JSON.stringify({ defaultStreamingBehavior: value }), "utf8");
    expect(() => loadPiWebConfig(testOptions())).toThrow("PI WEB config defaultStreamingBehavior");
    const original = await readFile(configPath, "utf8");
    // Model an untyped caller at the persistence boundary.
    const invalid = { defaultStreamingBehavior: value };
    // @ts-expect-error Deliberately exercise invalid untyped config input.
    expect(() => savePiWebConfig(invalid, testOptions())).toThrow("PI WEB config defaultStreamingBehavior");
    expect(await readFile(configPath, "utf8")).toBe(original);
  });

  it("round-trips and clears quietMode", async () => {
    savePiWebConfig({ quietMode: true }, testOptions());
    expect(loadPiWebConfig(testOptions()).config.quietMode).toBe(true);
    expect(effectivePiWebConfig(testOptions()).config.quietMode).toBe(true);
    savePiWebConfig({ ...loadPiWebConfig(testOptions()).config, port: 9000 }, testOptions());
    expect(effectivePiWebConfig(testOptions()).config.quietMode).toBe(true);

    savePiWebConfig({ port: 9000 }, testOptions());
    expect(loadPiWebConfig(testOptions()).config).not.toHaveProperty("quietMode");
    expect(JSON.parse(await readFile(configPath, "utf8"))).not.toHaveProperty("quietMode");
  });

  it.each(["true", 1, null, {}, []])("rejects invalid quietMode %j on load and save", async (value) => {
    await writeFile(configPath, JSON.stringify({ quietMode: value }), "utf8");
    expect(() => loadPiWebConfig(testOptions())).toThrow("PI WEB config quietMode");
    const original = await readFile(configPath, "utf8");
    // Model an untyped caller at the persistence boundary.
    const invalid = { quietMode: value };
    // @ts-expect-error Deliberately exercise invalid untyped config input.
    expect(() => savePiWebConfig(invalid, testOptions())).toThrow("PI WEB config quietMode");
    expect(await readFile(configPath, "utf8")).toBe(original);
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

  it("removes an omitted extensionDialogsTimeoutMs override on replacement saves", async () => {
    await writeFile(configPath, `${JSON.stringify({ extensionDialogsTimeoutMs: 60_000 }, null, 2)}\n`, "utf8");

    savePiWebConfig({ port: 9000 }, testOptions());

    expect(loadPiWebConfig(testOptions()).config.extensionDialogsTimeoutMs).toBeUndefined();
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

  it("fails visibly on invalid deployment policy instead of falling back", () => {
    expect(() => maxUploadBytes({ PI_WEB_MAX_UPLOAD_BYTES: "not-a-number" }, { maxUploadBytes: 555 })).toThrow("PI_WEB_MAX_UPLOAD_BYTES");
    expect(maxUploadBytes({}, { maxUploadBytes: 555 })).toBe(555);
  });
});

describe("extensionDialogsTimeoutMs", () => {
  it.each([0, 2_147_483_647])("accepts timer-safe boundary %s through files and environment", (timeout) => {
    savePiWebConfig({ extensionDialogsTimeoutMs: timeout }, testOptions());
    expect(loadPiWebConfig(testOptions()).config.extensionDialogsTimeoutMs).toBe(timeout);
    expect(applyPiWebConfigEnv({}, { PI_WEB_EXTENSION_DIALOGS_TIMEOUT_MS: String(timeout) }).extensionDialogsTimeoutMs).toBe(timeout);
  });

  it.each([2_147_483_648, Number.MAX_SAFE_INTEGER])("rejects timer-overflow value %s before writing", async (timeout) => {
    await writeFile(configPath, "{}");
    expect(() => savePiWebConfig({ extensionDialogsTimeoutMs: timeout }, testOptions())).toThrow("2147483647");
    expect(await readFile(configPath, "utf8")).toBe("{}");
    expect(() => applyPiWebConfigEnv({}, { PI_WEB_EXTENSION_DIALOGS_TIMEOUT_MS: String(timeout) })).toThrow("PI_WEB_EXTENSION_DIALOGS_TIMEOUT_MS");
    await writeFile(configPath, JSON.stringify({ extensionDialogsTimeoutMs: timeout }));
    expect(() => loadPiWebConfig(testOptions())).toThrow("2147483647");
  });

  it("defaults to five minutes when nothing is configured", () => {
    expect(effectivePiWebConfig(testOptions()).config.extensionDialogsTimeoutMs).toBe(DEFAULT_EXTENSION_DIALOGS_TIMEOUT_MS);
  });

  it("resolves a configured value, including zero for waiting forever", async () => {
    await writeFile(configPath, `${JSON.stringify({ extensionDialogsTimeoutMs: 0 }, null, 2)}\n`, "utf8");

    expect(effectivePiWebConfig(testOptions()).config.extensionDialogsTimeoutMs).toBe(0);
  });
});

describe("sessionMessages configuration", () => {
  it("defaults on independently of spawnSessions and subsessions", () => {
    expect(sessionMessagesEnabled({}, { spawnSessions: false, subsessions: false })).toBe(true);
    expect(effectivePiWebConfig(testOptions()).config.sessionMessages).toBe(true);
    expect(sessionMessagesEnabled({}, { sessionMessages: false, spawnSessions: true, subsessions: true })).toBe(false);
  });

  it("round-trips false and resolves defaults, writable config, then environment", async () => {
    const defaultsPath = join(tempDir, "defaults.json");
    await writeFile(defaultsPath, JSON.stringify({ sessionMessages: false }));
    const options = { env: { ...testOptions().env, PI_WEB_DEFAULTS_CONFIG: defaultsPath } };
    expect(effectivePiWebConfig(options).config.sessionMessages).toBe(false);
    savePiWebConfig({ sessionMessages: true }, options);
    expect(effectivePiWebConfig(options).config.sessionMessages).toBe(true);
    const enforcedOptions = { env: { ...options.env, PI_WEB_SESSION_MESSAGES: "0" } };
    expect(effectivePiWebConfig(enforcedOptions).config.sessionMessages).toBe(false);
    expect(loadPiWebConfig(enforcedOptions).config.sessionMessages).toBe(true);
    expect(piWebConfigSources(loadPiWebConfig(enforcedOptions), enforcedOptions)["/sessionMessages"]).toBe("PI_WEB_SESSION_MESSAGES");
    savePiWebConfig({ sessionMessages: false }, options);
    expect(loadPiWebConfig(options).config.sessionMessages).toBe(false);
    savePiWebConfig({}, options);
    expect(loadPiWebConfig(options).config).not.toHaveProperty("sessionMessages");
    expect(effectivePiWebConfig(options).config.sessionMessages).toBe(false);
  });

  it.each([null, "false", 0, {}, []])("rejects nonboolean file value %j", async (sessionMessages) => {
    await writeFile(configPath, JSON.stringify({ sessionMessages }));
    expect(() => loadPiWebConfig(testOptions())).toThrow("sessionMessages must be a boolean");
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

  it("rejects an explicitly empty boolean", () => {
    expect(() => askUserEnabled({ PI_WEB_ASK_USER: "" }, { askUser: false })).toThrow("PI_WEB_ASK_USER");
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

  it("rejects an explicitly empty boolean", () => {
    expect(() => environmentFactsEnabled({ PI_WEB_ENVIRONMENT_FACTS: "" }, { environmentFacts: false })).toThrow("PI_WEB_ENVIRONMENT_FACTS");
  });
});

describe("offlineModeEnabled", () => {
  it("is off when no offline env var is set", () => {
    expect(offlineModeEnabled({})).toBe(false);
  });

  it("rejects explicitly empty offline aliases", () => {
    expect(() => offlineModeEnabled({ PI_OFFLINE: "" })).toThrow("PI_OFFLINE");
    expect(() => offlineModeEnabled({ PI_WEB_OFFLINE: "" })).toThrow("PI_WEB_OFFLINE");
  });

  it("is on when either offline key has a value", () => {
    expect(offlineModeEnabled({ PI_OFFLINE: "1" })).toBe(true);
    expect(offlineModeEnabled({ PI_WEB_OFFLINE: "TRUE" })).toBe(true);
  });

  it("validates both aliases and recognizes explicit opt-outs", () => {
    expect(offlineModeEnabled({ PI_WEB_OFFLINE: "false", PI_OFFLINE: "0" })).toBe(false);
    expect(offlineModeEnabled({ PI_WEB_OFFLINE: "false", PI_OFFLINE: "1" })).toBe(true);
    expect(() => offlineModeEnabled({ PI_WEB_OFFLINE: "1", PI_OFFLINE: "anything" })).toThrow("PI_OFFLINE");
  });

  it("ignores the narrower skip-version-check keys", () => {
    expect(offlineModeEnabled({ PI_SKIP_VERSION_CHECK: "1", PI_WEB_SKIP_VERSION_CHECK: "1" })).toBe(false);
  });
});

describe("configuration layers", () => {
  it("keeps defaults separate, resolves relative selectors, and saves only writable overrides", async () => {
    const defaults = { installationName: "Deployment", uploads: { defaultFolder: "deployment" }, defaultLocalization: { language: "de", timeZone: "UTC" }, plugins: { git: { enabled: true, settings: { first: 1, value: { old: true } } } } };
    const defaultsPath = join(tempDir, "defaults.json");
    const original = JSON.stringify(defaults);
    await writeFile(defaultsPath, original);
    const options = { cwd: tempDir, env: { PI_WEB_CONFIG: configPath, PI_WEB_DEFAULTS_CONFIG: "defaults.json", PI_WEB_INSTALLATION_NAME: "Enforced" } };
    const missing = loadPiWebConfig(options);
    expect(missing).toMatchObject({ exists: false, config: {}, defaultsConfig: defaults, defaultsPath });
    const writable = { uploads: {}, defaultLocalization: { hourCycle: "h24" as const }, plugins: { git: { settings: { value: {} } } } };
    savePiWebConfig(writable, options);
    const loaded = loadPiWebConfig(options);
    expect(loaded.config).toEqual(writable);
    expect(resolveEffectivePiWebConfig(loaded, options).config).toMatchObject({
      installationName: "Enforced", uploads: { defaultFolder: "deployment" },
      defaultLocalization: { language: "de", timeZone: "UTC", hourCycle: "h24" },
      plugins: { git: { enabled: true, settings: { first: 1, value: {} } } },
    });
    expect(piWebConfigSources(loaded, options)).toMatchObject({
      "/installationName": "PI_WEB_INSTALLATION_NAME", "/uploads/defaultFolder": "defaults",
      "/defaultLocalization/language": "defaults", "/defaultLocalization/hourCycle": "config",
      "/plugins/git/enabled": "defaults", "/plugins/git/settings/value": "config",
    });
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual(writable);
    expect(await readFile(defaultsPath, "utf8")).toBe(original);
    savePiWebConfig({}, options);
    expect(effectivePiWebConfig(options).config.uploads.defaultFolder).toBe("deployment");
  });

  it("never guesses a defaults path and fails on a selected missing or invalid defaults file", async () => {
    expect(loadPiWebConfig(testOptions())).not.toHaveProperty("defaultsConfig");
    const options = { env: { ...testOptions().env, PI_WEB_DEFAULTS_CONFIG: join(tempDir, "defaults.json") } };
    expect(() => loadPiWebConfig(options)).toThrow();
    await writeFile(options.env.PI_WEB_DEFAULTS_CONFIG, JSON.stringify({ quietMode: "true" }));
    expect(() => loadPiWebConfig(options)).toThrow("quietMode");
  });

  it("refuses to write the deployment defaults file even if both selectors name it", async () => {
    const original = JSON.stringify({ installationName: "Deployment" });
    await writeFile(configPath, original);
    expect(() => savePiWebConfig({}, { env: { ...testOptions().env, PI_WEB_DEFAULTS_CONFIG: configPath } })).toThrow("PI_WEB_CONFIG must not select");
    expect(await readFile(configPath, "utf8")).toBe(original);
  });

  it.each([null, "a,b", [""], [1]])("validates basePaths %j identically for files and environment", async (basePaths) => {
    await writeFile(configPath, JSON.stringify({ basePaths }));
    expect(() => loadPiWebConfig(testOptions())).toThrow("basePaths");
    expect(() => applyPiWebConfigEnv({}, { PI_WEB_BASE_PATHS: JSON.stringify(basePaths) })).toThrow("PI_WEB_BASE_PATHS");
  });

  it("round-trips and removes timeout, environment facts, and base paths without persisting defaults", async () => {
    const config = { extensionDialogsTimeoutMs: 0, environmentFacts: false, basePaths: ["/path,with,commas"] };
    savePiWebConfig(config, testOptions());
    expect(loadPiWebConfig(testOptions()).config).toEqual(config);
    savePiWebConfig({}, testOptions());
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({});
  });

  it("overlays namespaces but replaces ordinary object and array settings", () => {
    const base = { basePaths: ["/base"], shortcuts: { one: "a" }, defaultTheme: { themeId: "themes:light", auto: true }, defaultLocalization: { language: "de" }, plugins: { git: { enabled: false, settings: { value: { old: 1 }, keep: [1] } } } };
    const result = overlayPiWebConfig(base, { basePaths: [], shortcuts: {}, defaultLocalization: {}, plugins: { git: { settings: { value: {} } } } });
    expect(result).toMatchObject({ basePaths: [], shortcuts: {}, defaultLocalization: { language: "de" }, plugins: { git: { enabled: false, settings: { value: {}, keep: [1] } } } });
    expect(base.plugins.git.settings.value).toEqual({ old: 1 });
  });
});

describe("environment setting resolution", () => {
  it.each([
    { key: "pathAccess", variable: "PI_WEB_PATH_ACCESS", value: { allowedpaths: [] } },
    { key: "uploads", variable: "PI_WEB_UPLOADS", value: { defaultfolder: "uploads" } },
    { key: "attachments", variable: "PI_WEB_ATTACHMENTS", value: { defaultfolder: "attachments" } },
  ])("rejects unknown $key fields rather than silently losing deployment policy", async ({ key, variable, value }) => {
    await writeFile(configPath, JSON.stringify({ [key]: value }));
    expect(() => loadPiWebConfig(testOptions())).toThrow("unknown key");
    expect(() => applyPiWebConfigEnv({ pathAccess: { allowedPaths: ["/existing"] } }, { [variable]: JSON.stringify(value) })).toThrow(variable);
    expect(() => piWebConfigEnforcedSettings({ [variable]: JSON.stringify(value) })).toThrow("unknown key");
  });

  it("validates plugin policy envelopes without interpreting plugin-owned setting names or values", () => {
    expect(() => applyPiWebConfigEnv({}, { PI_WEB_PLUGINS: '{"git":{"enable":false}}' })).toThrow("PI_WEB_PLUGINS");
    const settings = { customKey: { nested: [1, false] }, anotherKey: "value" };
    const env = { PI_WEB_PLUGINS: JSON.stringify({ custom: { settings } }) };
    expect(applyPiWebConfigEnv({}, env).plugins?.["custom"]?.settings).toEqual(settings);
    expect(piWebConfigEnforcedSettings(env)).toEqual({ "/plugins/custom/settings/customKey": "PI_WEB_PLUGINS", "/plugins/custom/settings/anotherKey": "PI_WEB_PLUGINS" });
  });

  it("supports every core setting with source-aware validators", () => {
    const config = {
      installationName: "Deployment", host: "0.0.0.0", port: 9001, allowedHosts: ["host"],
      shortcuts: { stop: null }, defaultTheme: { themeId: "themes:pi-web-light", auto: false },
      defaultLocalization: { language: "de" }, defaultStreamingBehavior: "followUp" as const,
      quietMode: true, plugins: { git: { enabled: false, settings: { key: { value: 1 } } } },
      basePaths: [], pathAccess: { allowedPaths: ["/a,b"] }, uploads: {}, attachments: {},
      maxUploadBytes: 100, sessionArchive: { directory: "archive" },
      spawnSessions: false, sessionMessages: false, subsessions: false, askUser: false, environmentFacts: false, extensionDialogsTimeoutMs: 0,
    };
    const env = Object.fromEntries(Object.entries(config).map(([key, value]) => [
      `PI_WEB_${key.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}`,
      typeof value === "string" ? value : JSON.stringify(value),
    ]));
    expect(applyPiWebConfigEnv({}, env)).toEqual(config);
    expect(piWebConfigEnforcedSettings(env)).toMatchObject({ "/defaultTheme": "PI_WEB_DEFAULT_THEME", "/basePaths": "PI_WEB_BASE_PATHS", "/plugins/git/enabled": "PI_WEB_PLUGINS", "/defaultLocalization/language": "PI_WEB_DEFAULT_LOCALIZATION" });
  });

  it("enforces only supplied namespace leaves and preserves project siblings", () => {
    const env = { PI_WEB_DEFAULT_LOCALIZATION: '{"language":"de"}', PI_WEB_PLUGINS: '{"git":{"settings":{"a~/b":{}}}}' };
    expect(piWebConfigEnforcedSettings(env)).toEqual({ "/defaultLocalization/language": "PI_WEB_DEFAULT_LOCALIZATION", "/plugins/git/settings/a~0~1b": "PI_WEB_PLUGINS" });
    expect(applyPiWebConfigEnv({ defaultLocalization: { timeZone: "UTC" }, plugins: { git: { enabled: true, settings: { sibling: 1, "a~/b": { old: true } } } } }, env)).toMatchObject({ defaultLocalization: { language: "de", timeZone: "UTC" }, plugins: { git: { enabled: true, settings: { sibling: 1, "a~/b": {} } } } });
    expect(piWebConfigEnforcedSettings({ PI_WEB_PLUGINS: '{}', PI_WEB_DEFAULT_LOCALIZATION: '{}' })).toEqual({});
  });

  it("enforces only supplied fields in schema-declared settings containers", () => {
    const env = {
      PI_WEB_UPLOADS: "{}", PI_WEB_ATTACHMENTS: '{"defaultFolder":"forced"}',
      PI_WEB_SESSION_ARCHIVE: "{}",
      PI_WEB_PATH_ACCESS: '{"allowedPaths":[]}',
    };
    expect(piWebConfigEnforcedSettings(env)).toEqual({
      "/attachments/defaultFolder": "PI_WEB_ATTACHMENTS", "/pathAccess/allowedPaths": "PI_WEB_PATH_ACCESS",
    });
    expect(applyPiWebConfigEnv({
      uploads: { defaultFolder: "deployed" }, attachments: { defaultFolder: "saved" },
      sessionArchive: { directory: "/archive" }, pathAccess: { allowedPaths: ["/saved"] },
    }, env)).toMatchObject({
      uploads: { defaultFolder: "deployed" }, attachments: { defaultFolder: "forced" },
      sessionArchive: { directory: "/archive" }, pathAccess: { allowedPaths: [] },
    });
  });

  it("preserves allowed-host shorthand, JSON, port aliases, and archive directory precedence", () => {
    expect(applyPiWebConfigEnv({}, { PI_WEB_ALLOWED_HOSTS: "127.0.0.1, example.org" }).allowedHosts).toEqual(["127.0.0.1", "example.org"]);
    expect(applyPiWebConfigEnv({}, { PI_WEB_ALLOWED_HOSTS: '["a,b"]' }).allowedHosts).toEqual(["a,b"]);
    expect(applyPiWebConfigEnv({}, { PI_WEB_ALLOWED_HOSTS: "true" }).allowedHosts).toBe(true);
    expect(applyPiWebConfigEnv({}, { PORT: "9001" }).port).toBe(9001);
    expect(piWebConfigEnforcedSettings({ PORT: "9001", PI_WEB_PORT: "9002" })).toEqual({ "/port": "PI_WEB_PORT" });
    const env = { PI_WEB_SESSION_ARCHIVE: '{"directory":"json"}', PI_WEB_SESSION_ARCHIVE_DIR: "legacy" };
    expect(applyPiWebConfigEnv({}, env).sessionArchive).toEqual({ directory: "legacy" });
    expect(piWebConfigEnforcedSettings(env)).toEqual({ "/sessionArchive/directory": "PI_WEB_SESSION_ARCHIVE_DIR" });
  });

  it.each([
    ["PI_WEB_SESSION_MESSAGES", "yes"], ["PI_WEB_SESSION_MESSAGES", ""],
    ["PI_WEB_QUIET_MODE", "yes"], ["PI_WEB_SPAWN_SESSIONS", "no"], ["PI_WEB_SUBSESSIONS", "2"],
    ["PI_WEB_QUIET_MODE", ""], ["PI_WEB_SPAWN_SESSIONS", ""], ["PI_WEB_SUBSESSIONS", ""],
    ["PI_WEB_ASK_USER", ""], ["PI_WEB_ENVIRONMENT_FACTS", ""], ["PI_WEB_INSTALLATION_NAME", "bad\nname"],
    ["PI_WEB_ASK_USER", "enabled"], ["PI_WEB_ENVIRONMENT_FACTS", "null"],
    ["PI_WEB_BASE_PATHS", "/a,/b"], ["PI_WEB_PATH_ACCESS", "[]"], ["PI_WEB_UPLOADS", "null"],
    ["PI_WEB_ALLOWED_HOSTS", "[broken"], ["PI_WEB_MAX_UPLOAD_BYTES", "0"],
    ["PI_WEB_EXTENSION_DIALOGS_TIMEOUT_MS", "-1"], ["PI_WEB_DEFAULT_THEME", "{}"],
  ])("rejects invalid %s with variable context", (key, value) => {
    expect(() => applyPiWebConfigEnv({}, { [key]: value })).toThrow(key);
  });

  it.each(["TRUE", "true", "1", "FALSE", "false", "0"])("parses strict boolean %s consistently", (value) => {
    const expected = /^(true|1)$/i.test(value);
    expect(applyPiWebConfigEnv({}, { PI_WEB_QUIET_MODE: value }).quietMode).toBe(expected);
    expect(spawnSessionsEnabled({ PI_WEB_SPAWN_SESSIONS: value })).toBe(expected);
    expect(sessionMessagesEnabled({ PI_WEB_SESSION_MESSAGES: value }, { sessionMessages: !expected })).toBe(expected);
    expect(subsessionsEnabled({ PI_WEB_SUBSESSIONS: value })).toBe(expected);
    expect(askUserEnabled({ PI_WEB_ASK_USER: value })).toBe(expected);
    expect(environmentFactsEnabled({ PI_WEB_ENVIRONMENT_FACTS: value })).toBe(expected);
  });
});

function testOptions(): { env: NodeJS.ProcessEnv } {
  return { env: { PI_WEB_CONFIG: configPath, PI_CODING_AGENT_DIR: join(tempDir, "agent") } };
}
