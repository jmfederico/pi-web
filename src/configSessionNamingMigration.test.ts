import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPiWebConfig, parsePiWebConfig, savePiWebConfig } from "./config.js";

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, renameSync: vi.fn(original.renameSync) };
});

let root: string;
let path: string;
let agentDir: string;
let destination: string;
let env: NodeJS.ProcessEnv;

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(join(file, ".."), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function readJson(file: string): unknown {
  const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  return value;
}

beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), "pi-web-naming-migration-"));
  path = join(root, "config.json");
  agentDir = join(root, "agent");
  destination = join(agentDir, "session-naming", "config.json");
  env = { PI_WEB_CONFIG: path, PI_CODING_AGENT_DIR: agentDir };
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("legacy session naming file migration", () => {
  it("merges default and saved members verbatim, sanitizes loads, and leaves deployment defaults untouched", () => {
    const defaultsPath = join(root, "defaults.json");
    const defaults = { sessionNaming: { model: "provider/model", maxTokens: 80, future: { nested: true } }, port: 8504 };
    writeJson(defaultsPath, defaults);
    writeJson(path, { sessionNaming: { maxTokens: 120, thinkingLevel: "off" }, quietMode: true, unrelated: { keep: true } });
    const loaded = loadPiWebConfig({ env: { ...env, PI_WEB_DEFAULTS_CONFIG: defaultsPath } });
    expect(loaded.config).toEqual({ quietMode: true });
    expect(loaded.defaultsConfig).toEqual({ port: 8504 });
    expect(readJson(destination)).toEqual({ model: "provider/model", maxTokens: 120, future: { nested: true }, thinkingLevel: "off" });
    expect(readJson(path)).toEqual({ quietMode: true, unrelated: { keep: true } });
    expect(readJson(defaultsPath)).toEqual(defaults);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining(`remove this key manually after checking ${destination}`));
  });

  it.skipIf(process.platform === "win32")("preserves a writable config symlink and its target permissions during cleanup", () => {
    const target = join(root, "target.json");
    writeJson(target, { sessionNaming: {}, port: 8505, unrelated: "keep" });
    fs.chmodSync(target, 0o640);
    fs.symlinkSync(target, path);
    loadPiWebConfig({ env });
    expect(fs.lstatSync(path).isSymbolicLink()).toBe(true);
    expect(fs.statSync(target).mode & 0o777).toBe(0o640);
    expect(readJson(target)).toEqual({ port: 8505, unrelated: "keep" });
  });

  it("preserves an existing package config, including an empty object, while removing the old key", () => {
    writeJson(destination, {});
    writeJson(path, { sessionNaming: { model: "old/model" }, port: 8505 });
    loadPiWebConfig({ env });
    expect(readJson(destination)).toEqual({});
    expect(readJson(path)).toEqual({ port: 8505 });
  });

  it("does not modify defaults even when the writable selector aliases them", () => {
    const original = { sessionNaming: { maxTokens: 50 } };
    writeJson(path, original);
    loadPiWebConfig({ env: { ...env, PI_WEB_DEFAULTS_CONFIG: path } });
    expect(readJson(path)).toEqual(original);
    expect(readJson(destination)).toEqual(original.sessionNaming);
    expect(console.error).toHaveBeenCalled();
  });

  it("keeps the original field and continues loading when the destination cannot be published", () => {
    const original = { sessionNaming: { maxTokens: 120 }, quietMode: true };
    writeJson(path, original);
    fs.mkdirSync(agentDir);
    fs.writeFileSync(join(agentDir, "session-naming"), "not a directory");
    expect(loadPiWebConfig({ env }).config).toEqual({ quietMode: true });
    expect(readJson(path)).toEqual(original);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining(destination), expect.any(Error));
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining(path), expect.any(Error));
  });

  it("retains the legacy key when the destination is a directory rather than a config file", () => {
    const original = { sessionNaming: { maxTokens: 120 }, quietMode: true };
    writeJson(path, original);
    fs.mkdirSync(destination, { recursive: true });
    expect(loadPiWebConfig({ env }).config).toEqual({ quietMode: true });
    expect(readJson(path)).toEqual(original);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining(destination), expect.any(Error));
  });

  it.skipIf(process.platform === "win32")("retains the legacy key when the package config is a broken symlink", () => {
    const original = { sessionNaming: { maxTokens: 120 } };
    writeJson(path, original);
    fs.mkdirSync(join(destination, ".."), { recursive: true });
    fs.symlinkSync(join(root, "missing.json"), destination);
    loadPiWebConfig({ env });
    expect(readJson(path)).toEqual(original);
    expect(fs.lstatSync(destination).isSymbolicLink()).toBe(true);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining(destination), expect.any(Error));
  });

  it("keeps published package data after cleanup failure, then retries cleanup without overwriting it", () => {
    const original = { sessionNaming: { maxTokens: 120 }, quietMode: true };
    writeJson(path, original);
    vi.mocked(fs.renameSync).mockImplementationOnce(() => { throw new Error("cleanup failed"); });
    expect(loadPiWebConfig({ env }).config).toEqual({ quietMode: true });
    expect(readJson(path)).toEqual(original);
    expect(readJson(destination)).toEqual({ maxTokens: 120 });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining(path), expect.any(Error));
    writeJson(destination, { maxTokens: 200 });
    loadPiWebConfig({ env });
    expect(readJson(path)).toEqual({ quietMode: true });
    expect(readJson(destination)).toEqual({ maxTokens: 200 });
  });

  it.each([null, [], "invalid", 1])("retains invalid legacy values without aborting startup: %j", (sessionNaming) => {
    writeJson(path, { sessionNaming, quietMode: true });
    expect(loadPiWebConfig({ env }).config).toEqual({ quietMode: true });
    expect(readJson(path)).toEqual({ sessionNaming, quietMode: true });
    expect(fs.existsSync(destination)).toBe(false);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining(path), expect.any(Error));
  });

  it("rejects retired keys in parse and save before record filtering, even when undefined", () => {
    expect(() => parsePiWebConfig({ sessionNaming: undefined })).toThrow(/sessionNaming.*retired/);
    expect(() => savePiWebConfig({ port: 8504, ...{ sessionNaming: {} } }, { env })).toThrow(/sessionNaming.*retired/);
    expect(fs.existsSync(path)).toBe(false);
  });
});
