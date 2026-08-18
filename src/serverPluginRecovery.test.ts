import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  disableServerPlugin,
  loadServerPluginRecoveryConfig,
  setServerPluginSafeStart,
} from "./serverPluginRecovery.js";

let tempDir: string;
let configPath: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-web-plugin-recovery-test-"));
  configPath = join(tempDir, "custom", "config.json");
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("server plugin offline recovery config", () => {
  it("disables one plugin while preserving its settings and unrelated config", async () => {
    await writeConfig({
      future: { retained: true },
      plugins: {
        broken: { enabled: true, settings: { executable: "broken" }, futurePluginKey: 42 },
        healthy: { enabled: true },
      },
    });

    const result = disableServerPlugin("broken", { configPath });

    expect(result).toEqual({ path: configPath, exists: true });
    expect(await readConfig()).toEqual({
      future: { retained: true },
      plugins: {
        broken: { enabled: false, settings: { executable: "broken" }, futurePluginKey: 42 },
        healthy: { enabled: true },
      },
    });
  });

  it("disables ids that shadow inherited object properties", async () => {
    disableServerPlugin("constructor", { configPath });

    expect(await readConfig()).toEqual({ plugins: { constructor: { enabled: false } } });
  });

  it("uses an explicit relative config path without relying on PI_WEB_CONFIG", async () => {
    const relativePath = join("nested", "recovery.json");

    disableServerPlugin("offline-provider", {
      cwd: tempDir,
      configPath: relativePath,
      env: { PI_WEB_CONFIG: join(tempDir, "must-not-be-used.json") },
    });

    expect(JSON.parse(await readFile(join(tempDir, relativePath), "utf8"))).toEqual({
      plugins: { "offline-provider": { enabled: false } },
    });
  });

  it.skipIf(process.platform === "win32")("preserves an explicit config symlink while atomically updating its target", async () => {
    const targetPath = join(tempDir, "real-config.json");
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(targetPath, `${JSON.stringify({ future: true })}\n`, "utf8");
    await symlink(targetPath, configPath);

    disableServerPlugin("broken", { configPath });

    expect((await lstat(configPath)).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await readFile(targetPath, "utf8"))).toEqual({
      future: true,
      plugins: { broken: { enabled: false } },
    });
  });

  it("sets, inspects, changes, and clears both persistent safe-start levels", async () => {
    await writeConfig({ serverPlugins: { future: "retained" }, port: 8504 });

    setServerPluginSafeStart("bundled-only", { configPath });
    expect(loadServerPluginRecoveryConfig({ configPath })).toEqual({
      path: configPath,
      exists: true,
      safeStart: "bundled-only",
    });
    expect(await readConfig()).toEqual({
      serverPlugins: { future: "retained", safeStart: "bundled-only" },
      port: 8504,
    });

    setServerPluginSafeStart("none", { configPath });
    expect(loadServerPluginRecoveryConfig({ configPath }).safeStart).toBe("none");

    setServerPluginSafeStart(undefined, { configPath });
    expect(loadServerPluginRecoveryConfig({ configPath }).safeStart).toBeUndefined();
    expect(await readConfig()).toEqual({ serverPlugins: { future: "retained" }, port: 8504 });
  });

  it("removes an empty recovery section when safe start is cleared", async () => {
    await writeConfig({ serverPlugins: { safeStart: "none" }, future: true });

    setServerPluginSafeStart(undefined, { configPath });

    expect(await readConfig()).toEqual({ future: true });
  });

  it("fails closed for malformed safe start without blocking an unrelated plugin disable", async () => {
    const original = {
      plugins: { broken: { enabled: true, settings: { retained: true } } },
      serverPlugins: { safeStart: "future-level", retained: true },
      future: true,
    };
    await writeConfig(original);

    const loaded = loadServerPluginRecoveryConfig({ configPath });
    expect(loaded).toMatchObject({ path: configPath, exists: true, safeStart: "none" });
    expect(loaded.safeStartDiagnostic).toContain("serverPlugins.safeStart must be \"bundled-only\" or \"none\"");

    const recovery = disableServerPlugin("broken", { configPath });

    expect(recovery.safeStart).toBe("none");
    expect(recovery.safeStartDiagnostic).toContain("No server plugins will be loaded");
    expect(await readConfig()).toEqual({
      ...original,
      plugins: { broken: { enabled: false, settings: { retained: true } } },
    });
  });

  it("repairs malformed safe-start sections through set and clear", async () => {
    await writeConfig({ serverPlugins: ["malformed"], future: true });

    const loaded = loadServerPluginRecoveryConfig({ configPath });
    expect(loaded.safeStart).toBe("none");
    expect(loaded.safeStartDiagnostic).toContain("serverPlugins must be an object");

    setServerPluginSafeStart("bundled-only", { configPath });
    expect(await readConfig()).toEqual({ serverPlugins: { safeStart: "bundled-only" }, future: true });

    await writeConfig({ serverPlugins: "malformed", future: true });
    setServerPluginSafeStart(undefined, { configPath });
    expect(await readConfig()).toEqual({ future: true });
  });

  it("rejects invalid ids and malformed plugin sections without overwriting the file", async () => {
    const original = { plugins: ["broken"], serverPlugins: { safeStart: "future-level" }, future: true };
    await writeConfig(original);

    expect(() => disableServerPlugin("Not Valid", { configPath })).toThrow("Invalid PI WEB plugin id");
    expect(() => disableServerPlugin("broken", { configPath })).toThrow("plugins must be an object");
    expect(await readConfig()).toEqual(original);
  });

  it("reports off without creating a missing config", () => {
    expect(loadServerPluginRecoveryConfig({ configPath })).toEqual({ path: configPath, exists: false });
  });
});

async function writeConfig(value: unknown): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readConfig(): Promise<unknown> {
  return JSON.parse(await readFile(configPath, "utf8"));
}
