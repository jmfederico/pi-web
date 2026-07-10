import { describe, expect, it } from "vitest";

import {
  type ConnectorConfigStorageDependencies,
  connectorConfigDirectoryMode,
  connectorConfigFileMode,
  createDefaultConnectorConfig,
  defaultLocalPiWebUrl,
  parseConnectorConfig,
  readConnectorConfig,
  writeConnectorConfig,
} from "./config-storage.js";

type StorageCall =
  | { readonly kind: "chmod"; readonly mode: number; readonly path: string }
  | { readonly kind: "mkdir"; readonly mode: number; readonly path: string; readonly recursive: true }
  | { readonly contents: string; readonly kind: "writeFile"; readonly mode: number; readonly path: string };

interface FakeStorageDependencies {
  readonly calls: () => readonly StorageCall[];
  readonly dependencies: ConnectorConfigStorageDependencies;
}

interface FakeStorageOptions {
  readonly platform?: NodeJS.Platform;
  readonly readContents?: string;
}

function createFakeStorageDependencies(options: FakeStorageOptions = {}): FakeStorageDependencies {
  const calls: StorageCall[] = [];
  const platform = options.platform ?? "linux";
  const readContents = options.readContents ?? JSON.stringify(createDefaultConnectorConfig());

  return {
    calls: () => calls,
    dependencies: {
      chmod(path, mode): void {
        calls.push({ kind: "chmod", mode, path });
      },
      mkdir(path, options): void {
        calls.push({ kind: "mkdir", mode: options.mode, path, recursive: options.recursive });
      },
      platform,
      readFile(): string {
        return readContents;
      },
      writeFile(path, contents, options): void {
        calls.push({ contents, kind: "writeFile", mode: options.mode, path });
      },
    },
  };
}

describe("connector config storage", () => {
  it("creates a default local-only config", () => {
    expect(createDefaultConnectorConfig()).toEqual({
      localPiWebUrl: defaultLocalPiWebUrl,
      schemaVersion: 2,
    });
  });

  it("writes config under a private POSIX directory and file", () => {
    const storage = createFakeStorageDependencies();

    writeConnectorConfig(
      "/home/pi/.config/pi-web-tunnel/config.json",
      createDefaultConnectorConfig(),
      storage.dependencies,
    );

    expect(storage.calls()).toEqual([
      {
        kind: "mkdir",
        mode: connectorConfigDirectoryMode,
        path: "/home/pi/.config/pi-web-tunnel",
        recursive: true,
      },
      {
        kind: "chmod",
        mode: connectorConfigDirectoryMode,
        path: "/home/pi/.config/pi-web-tunnel",
      },
      {
        contents: "{\n  \"localPiWebUrl\": \"http://127.0.0.1:8504\",\n  \"schemaVersion\": 2\n}\n",
        kind: "writeFile",
        mode: connectorConfigFileMode,
        path: "/home/pi/.config/pi-web-tunnel/config.json",
      },
      {
        kind: "chmod",
        mode: connectorConfigFileMode,
        path: "/home/pi/.config/pi-web-tunnel/config.json",
      },
    ]);
  });

  it("uses Windows path semantics and skips POSIX chmod calls on Windows", () => {
    const storage = createFakeStorageDependencies({ platform: "win32" });

    writeConnectorConfig(
      "C:\\Users\\pi\\AppData\\Roaming\\pi-web-tunnel\\config.json",
      createDefaultConnectorConfig(),
      storage.dependencies,
    );

    expect(storage.calls()).toEqual([
      {
        kind: "mkdir",
        mode: connectorConfigDirectoryMode,
        path: "C:\\Users\\pi\\AppData\\Roaming\\pi-web-tunnel",
        recursive: true,
      },
      {
        contents: "{\n  \"localPiWebUrl\": \"http://127.0.0.1:8504\",\n  \"schemaVersion\": 2\n}\n",
        kind: "writeFile",
        mode: connectorConfigFileMode,
        path: "C:\\Users\\pi\\AppData\\Roaming\\pi-web-tunnel\\config.json",
      },
    ]);
  });

  it("reads and upgrades a legacy v1 connector config", () => {
    const storage = createFakeStorageDependencies({
      readContents: "{\"schemaVersion\":1,\"localPiWebUrl\":\"http://127.0.0.1:8504\"}",
    });

    expect(readConnectorConfig("/home/pi/.config/pi-web-tunnel/config.json", storage.dependencies)).toEqual({
      localPiWebUrl: "http://127.0.0.1:8504",
      schemaVersion: 2,
    });
  });

  it("reads persisted machine credentials and frpc path", () => {
    expect(
      parseConnectorConfig(JSON.stringify({
        schemaVersion: 2,
        localPiWebUrl: "http://127.0.0.1:8504",
        frpcPath: "/usr/local/bin/frpc",
        machine: {
          controlApiBaseUrl: "http://127.0.0.1:8787",
          machineId: "machine_abc",
          machineToken: "piwt_mtok_v1_secret",
          machineSlug: "my-dev-box",
          publicUrl: "https://my-dev-box.ns.tunnels.pi-web.dev",
        },
      })),
    ).toEqual({
      localPiWebUrl: "http://127.0.0.1:8504",
      schemaVersion: 2,
      frpcPath: "/usr/local/bin/frpc",
      machine: {
        controlApiBaseUrl: "http://127.0.0.1:8787",
        machineId: "machine_abc",
        machineToken: "piwt_mtok_v1_secret",
        machineSlug: "my-dev-box",
        publicUrl: "https://my-dev-box.ns.tunnels.pi-web.dev",
      },
    });
  });

  it("rejects malformed machine credentials", () => {
    expect(() => parseConnectorConfig(JSON.stringify({
      schemaVersion: 2,
      localPiWebUrl: "http://127.0.0.1:8504",
      machine: { machineId: "machine_abc" },
    }))).toThrow("Connector config machine.controlApiBaseUrl must be a non-empty string.");
  });

  it("rejects unsupported config schema versions", () => {
    expect(() => parseConnectorConfig("{\"schemaVersion\":3,\"localPiWebUrl\":\"http://127.0.0.1:8504\"}")).toThrow(
      "Unsupported connector config schema version: 3.",
    );
  });
});
