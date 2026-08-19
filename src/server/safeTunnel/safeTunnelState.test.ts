import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FileSafeTunnelStateStorage,
  createDefaultSafeTunnelState,
  defaultSafeTunnelStatePath,
  normalizeSafeTunnelControlApiBaseUrl,
  normalizeSafeTunnelLocalPiWebUrl,
  normalizeSafeTunnelPublicUrl,
  parseSafeTunnelState,
  safeTunnelStateDirectoryMode,
  safeTunnelStateFileMode,
} from "./safeTunnelState.js";

let tempDirectory: string;

beforeEach(async () => {
  tempDirectory = await mkdtemp(join(tmpdir(), "pi-web-safe-tunnel-state-"));
});

afterEach(async () => {
  await rm(tempDirectory, { recursive: true, force: true });
});

describe("Safe Tunnel state paths", () => {
  it("stores PI WEB-owned state beneath PI_WEB_DATA_DIR", () => {
    // Resolved with the host path semantics so the layout contract holds on
    // every platform, not only on POSIX path shapes.
    expect(defaultSafeTunnelStatePath({ PI_WEB_DATA_DIR: "./data" }, "/workspace"))
      .toBe(join(resolve("/workspace", "data"), "safe-tunnel", "config.json"));
  });

});

describe("Safe Tunnel URL policy", () => {
  it.each([
    ["https://control.example.test/", "https://control.example.test"],
    ["http://127.1:8787/", "http://127.0.0.1:8787"],
    ["http://[0:0:0:0:0:0:0:1]:8787", "http://[::1]:8787"],
  ])("normalizes supported Control API endpoint %s", (input, expected) => {
    expect(normalizeSafeTunnelControlApiBaseUrl(input)).toBe(expected);
  });

  it.each([
    "http://control.example.test",
    "http://localhost:8787",
    "http://0.0.0.0:8787",
    "http://192.168.1.10:8787",
  ])("rejects plaintext non-loopback Control API endpoint %s", (value) => {
    expect(() => normalizeSafeTunnelControlApiBaseUrl(value)).toThrow("must use https");
  });

  it("preserves an explicit default port in IPv4 and bracketed IPv6 local targets", () => {
    expect(normalizeSafeTunnelLocalPiWebUrl("http://127.0.0.1:80"))
      .toBe("http://127.0.0.1:80");
    expect(normalizeSafeTunnelLocalPiWebUrl("http://[::1]:80"))
      .toBe("http://[::1]:80");
    expect(() => normalizeSafeTunnelLocalPiWebUrl("http://127.0.0.1"))
      .toThrow("explicit port");
  });

  it("normalizes HTTPS and literal-loopback public origins", () => {
    expect(normalizeSafeTunnelPublicUrl("https://Ingress.Example.Test:443/"))
      .toBe("https://ingress.example.test");
    expect(normalizeSafeTunnelPublicUrl("http://127.0.0.1:9443"))
      .toBe("http://127.0.0.1:9443");
    expect(() => normalizeSafeTunnelPublicUrl("http://ingress.example.test"))
      .toThrow("must use https");
  });
});

describe("FileSafeTunnelStateStorage", () => {
  it("defaults intent to disabled without creating state", async () => {
    const filePath = join(tempDirectory, "data", "safe-tunnel", "config.json");
    const storage = createStorage(filePath);

    await expect(storage.load()).resolves.toEqual({
      exists: false,
      state: createDefaultSafeTunnelState(),
    });
    await expect(stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("atomically persists only current private intent and credentials", async () => {
    const filePath = join(tempDirectory, "data", "safe-tunnel", "config.json");
    const storage = createStorage(filePath);
    const state = {
      ...createDefaultSafeTunnelState(),
      desiredState: "enabled" as const,
      localPiWebUrl: "http://127.0.0.1:9000",
      frpcPath: "/opt/frpc",
      machine: {
        controlApiBaseUrl: "https://control.example.test/",
        credentialStatus: "active" as const,
        machineId: "machine_123",
        machineToken: "AbC-._~+/==",
        machineSlug: "dev-box",
        publicUrl: "https://dev-box.example.test",
      },
    };

    await storage.save(state);

    await expect(storage.load()).resolves.toEqual({
      exists: true,
      state: {
        ...state,
        machine: {
          ...state.machine,
          controlApiBaseUrl: "https://control.example.test",
        },
      },
    });
    // POSIX permission bits are only observable where the filesystem
    // honors them; the injected linux platform still exercises the chmod
    // path on every host.
    if (process.platform !== "win32") {
      expect((await stat(join(tempDirectory, "data", "safe-tunnel"))).mode & 0o777)
        .toBe(safeTunnelStateDirectoryMode);
      expect((await stat(filePath)).mode & 0o777).toBe(safeTunnelStateFileMode);
    }
    const source = await readFile(filePath, "utf8");
    expect(source).toContain('"machineToken": "AbC-._~+/=="');
    expect(source).not.toContain("credentialBoundary");
  });

  it("removes obsolete classification history when an existing state file is loaded", async () => {
    const filePath = join(tempDirectory, "data", "safe-tunnel", "config.json");
    await mkdir(join(tempDirectory, "data", "safe-tunnel"), { recursive: true });
    await writeFile(filePath, JSON.stringify({
      ...createDefaultSafeTunnelState(),
      credentialBoundaryPrivateValues: ["old-private-value"],
      credentialBoundaryPublicValues: ["old-public-value"],
      machine: {
        controlApiBaseUrl: "https://control.example.test",
        machineId: "machine_123",
        machineToken: "machine-token",
        credentialBoundaryPublicValues: ["old-machine-public-value"],
      },
    }));
    const storage = createStorage(filePath);

    const loaded = await storage.load();

    expect(loaded.state).toEqual({
      ...createDefaultSafeTunnelState(),
      machine: {
        controlApiBaseUrl: "https://control.example.test",
        credentialStatus: "active",
        machineId: "machine_123",
        machineToken: "machine-token",
      },
    });
    const rewritten = await readFile(filePath, "utf8");
    expect(rewritten).not.toContain("credentialBoundary");
    expect(rewritten).not.toContain("old-public-value");
    expect(rewritten).not.toContain("old-private-value");
  });


  it("reports invalid JSON and unsupported versions without overwriting them", async () => {
    const filePath = join(tempDirectory, "data", "safe-tunnel", "config.json");
    await mkdir(join(tempDirectory, "data", "safe-tunnel"), { recursive: true });
    await writeFile(filePath, "not json");
    const storage = createStorage(filePath);

    await expect(storage.load()).rejects.toThrow("contains invalid JSON");
    expect(await readFile(filePath, "utf8")).toBe("not json");
    expect(() => parseSafeTunnelState({
      stateVersion: 99,
      desiredState: "disabled",
      localPiWebUrl: "http://127.0.0.1:8504",
    })).toThrow("Unsupported Safe Tunnel state version");
  });

  it.each([
    ["invalid desired state", { desiredState: "maybe" }],
    ["invalid local target", { localPiWebUrl: "https://127.0.0.1:8504" }],
    ["header-unsafe token", {
      machine: {
        controlApiBaseUrl: "https://control.example.test",
        machineId: "machine_123",
        machineToken: "bad token\nvalue",
      },
    }],
  ])("rejects %s", (_label, override) => {
    expect(() => parseSafeTunnelState({
      ...createDefaultSafeTunnelState(),
      ...override,
    })).toThrow();
  });
});

function createStorage(filePath: string): FileSafeTunnelStateStorage {
  return new FileSafeTunnelStateStorage({
    filePath,
    platform: "linux",
  });
}
