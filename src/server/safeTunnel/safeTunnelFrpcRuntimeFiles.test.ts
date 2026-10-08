import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getCACertificates,
  rootCertificates,
  setDefaultCACertificates,
} from "node:tls";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FileSafeTunnelFrpcRuntimeFiles,
  safeTunnelFrpcConfigFileMode,
  safeTunnelFrpcRuntimeDirectoryMode,
  safeTunnelFrpcTrustedCaFileMode,
} from "./safeTunnelFrpcRuntimeFiles.js";

let tempDirectory: string;

beforeEach(async () => {
  tempDirectory = await mkdtemp(join(tmpdir(), "pi-web-safe-tunnel-runtime-files-"));
});

afterEach(async () => {
  await rm(tempDirectory, { recursive: true, force: true });
});

describe("FileSafeTunnelFrpcRuntimeFiles", () => {
  it("derives colocated runtime paths without touching the filesystem", async () => {
    const runtimeDirectory = join(tempDirectory, "safe-tunnel");
    const files = new FileSafeTunnelFrpcRuntimeFiles({
      statePath: join(runtimeDirectory, "config.json"),
    });

    expect(files.configPath).toBe(join(runtimeDirectory, "frpc.toml"));
    expect(files.trustedCaPath).toBe(join(runtimeDirectory, "frps-roots.pem"));
    await expect(stat(runtimeDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writes private config and PI WEB-owned trust roots", async () => {
    const runtimeDirectory = join(tempDirectory, "safe-tunnel");
    const configPath = join(runtimeDirectory, "frpc.toml");
    const trustedCaPath = join(runtimeDirectory, "frps-roots.pem");
    const files = new FileSafeTunnelFrpcRuntimeFiles({
      configPath,
      platform: "linux",
      trustedCaPath,
    });
    await writeFile(join(tempDirectory, "unrelated"), "keep");

    await files.writeConfig("serverAddr = \"relay.example.test\"\n");
    await files.writeConfig("serverAddr = \"new-relay.example.test\"\n");

    expect(await readFile(configPath, "utf8")).toBe(
      "serverAddr = \"new-relay.example.test\"\n",
    );
    // POSIX permission bits are only observable where the filesystem honors
    // them; the injected linux platform still exercises the chmod path on
    // every host.
    if (process.platform !== "win32") {
      expect((await stat(runtimeDirectory)).mode & 0o777)
        .toBe(safeTunnelFrpcRuntimeDirectoryMode);
      expect((await stat(configPath)).mode & 0o777)
        .toBe(safeTunnelFrpcConfigFileMode);
      expect((await stat(trustedCaPath)).mode & 0o777)
        .toBe(safeTunnelFrpcTrustedCaFileMode);
    }
    expect(await readFile(trustedCaPath, "utf8"))
      .toContain(getCACertificates("default")[0]);
    expect((await readdir(runtimeDirectory)).sort()).toEqual([
      "frpc.toml",
      "frps-roots.pem",
    ]);

    await files.removeConfig();
    expect(await readdir(runtimeDirectory)).toEqual([]);
  });

  it("writes Node's active configured default CA set", async () => {
    const originalDefaultCertificates = getCACertificates("default");
    const configuredRoot = rootCertificates.at(1);
    if (configuredRoot === undefined) throw new Error("Node did not provide a test CA root");

    try {
      setDefaultCACertificates([configuredRoot]);
      const configuredDefaultCertificates = getCACertificates("default");
      const files = new FileSafeTunnelFrpcRuntimeFiles({
        statePath: join(tempDirectory, "configured", "config.json"),
      });

      await files.writeConfig("serverAddr = \"relay.example.test\"\n");

      expect(await readFile(files.trustedCaPath, "utf8"))
        .toBe(`${configuredDefaultCertificates.join("\n")}\n`);
    } finally {
      setDefaultCACertificates(originalDefaultCertificates);
    }
  });

  it("requires a non-empty certificate bundle", () => {
    expect(() => new FileSafeTunnelFrpcRuntimeFiles({
      statePath: join(tempDirectory, "config.json"),
      trustedCaPem: "not a certificate",
    })).toThrow("non-empty PI WEB-owned CA certificate bundle");
  });
});
