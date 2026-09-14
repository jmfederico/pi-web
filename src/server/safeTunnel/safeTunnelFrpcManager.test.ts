import { createHash } from "node:crypto";
import { createServer, type RequestListener, type Server } from "node:http";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  findSafeTunnelFrpcArtifact,
  safeTunnelFrpcManifest,
  type SafeTunnelFrpcArtifact,
  type SafeTunnelFrpcManifest,
} from "./safeTunnelFrpcManifest.js";
import {
  FileSafeTunnelFrpcInstallationStore,
  HttpSafeTunnelFrpcArtifactSource,
  SafeTunnelFrpcManager,
  TarGzipSafeTunnelFrpcArchiveExtractor,
  type SafeTunnelFrpcArtifactSource,
} from "./safeTunnelFrpcManager.js";

let tempDirectory: string;
const servers: Server[] = [];

beforeEach(async () => {
  tempDirectory = await mkdtemp(join(tmpdir(), "pi-web-managed-frpc-"));
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => closeServer(server)));
  await rm(tempDirectory, { force: true, recursive: true });
});

describe("pinned Safe Tunnel frpc manifest", () => {
  it("pins independently verified official frp executables for supported targets", () => {
    expect(safeTunnelFrpcManifest.version).toBe("0.69.1");
    expect(safeTunnelFrpcManifest.artifacts).toHaveLength(2);
    expect(findSafeTunnelFrpcArtifact(safeTunnelFrpcManifest, "linux", "arm64")).toEqual({
      platform: "linux",
      architecture: "arm64",
      archiveFormat: "tar.gz",
      archiveSha256: "bbc0c75e896af3f292fb46ba09c844a04fa9b5ea3530c039c7af20637f836355",
      archiveSize: 12_599_774,
      archiveEntryPath: "frp_0.69.1_linux_arm64/frpc",
      downloadUrl: "https://github.com/fatedier/frp/releases/download/v0.69.1/frp_0.69.1_linux_arm64.tar.gz",
      executableSha256: "f93e758ea21099a8ac6b65791d1113e86ccb06bab03cc41575613726e375322d",
      executableSize: 15_007_928,
    });
    expect(findSafeTunnelFrpcArtifact(safeTunnelFrpcManifest, "linux", "x64")).toEqual({
      platform: "linux",
      architecture: "x64",
      archiveFormat: "tar.gz",
      archiveSha256: "7be257b72dbbc60bcb3e0e25a5afd1dfac7b63f897084864d3c956dd3d5674e1",
      archiveSize: 14_189_005,
      archiveEntryPath: "frp_0.69.1_linux_amd64/frpc",
      downloadUrl: "https://github.com/fatedier/frp/releases/download/v0.69.1/frp_0.69.1_linux_amd64.tar.gz",
      executableSha256: "142f447f43fef286acc8da8a6852dda80631db631d604b2e63634b2db4d6848c",
      executableSize: 16_806_072,
    });
  });
});

describe("HttpSafeTunnelFrpcArtifactSource", () => {
  it("downloads only a bounded successful artifact body", async () => {
    const expected = Buffer.from("fixture archive bytes");
    const baseArtifact = {
      ...artifactFixture("1.0.0", expected).artifact,
      archiveSize: expected.byteLength,
    };
    const requests: { readonly accept: string | undefined; readonly path: string | undefined }[] = [];
    const server = await listen((request, response) => {
      requests.push({ accept: request.headers.accept, path: request.url });
      if (request.url === "/failure") {
        response.writeHead(503);
        response.end("provider response");
        return;
      }
      if (request.url === "/large") {
        response.writeHead(200, { "content-length": "1000" });
        response.end("too large");
        return;
      }
      if (request.url === "/stream-large") {
        response.writeHead(200);
        response.end(Buffer.alloc(1_000));
        return;
      }
      response.writeHead(200, { "content-length": expected.byteLength.toString() });
      response.end(expected);
    });
    const source = new HttpSafeTunnelFrpcArtifactSource({ maximumDownloadBytes: 1_024 });

    await expect(source.download({
      ...baseArtifact,
      downloadUrl: `${server.origin}/artifact`,
    })).resolves.toEqual(Uint8Array.from(expected));
    expect(requests[0]).toEqual({ accept: "application/octet-stream", path: "/artifact" });
    await expect(source.download({
      ...baseArtifact,
      downloadUrl: `${server.origin}/failure`,
    })).rejects.toMatchObject({ code: "download_failed" });
    await expect(source.download({
      ...baseArtifact,
      downloadUrl: `${server.origin}/large`,
    })).rejects.toMatchObject({ code: "download_too_large" });
    await expect(source.download({
      ...baseArtifact,
      downloadUrl: `${server.origin}/stream-large`,
    })).rejects.toMatchObject({ code: "download_too_large" });
  });

  it("aborts a stalled transport at the configured timeout", async () => {
    vi.useFakeTimers();
    try {
      let observedSignal: AbortSignal | null | undefined;
      const source = new HttpSafeTunnelFrpcArtifactSource({
        fetch: (_input, init) => {
          observedSignal = init?.signal;
          return new Promise<Response>((_resolve, reject) => {
            observedSignal?.addEventListener(
              "abort",
              () => { reject(new Error("stalled transport")); },
              { once: true },
            );
          });
        },
        timeoutMs: 50,
      });
      const fixture = artifactFixture("1.0.0", Buffer.from("fixture"));
      const assertion = expect(source.download(fixture.artifact)).rejects.toMatchObject({
        code: "download_failed",
      });

      await vi.advanceTimersByTimeAsync(50);

      await assertion;
      expect(observedSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts a pending transport when its caller cancels", async () => {
    let observedSignal: AbortSignal | null | undefined;
    const source = new HttpSafeTunnelFrpcArtifactSource({
      fetch: (_input, init) => {
        observedSignal = init?.signal;
        return new Promise<Response>((_resolve, reject) => {
          observedSignal?.addEventListener(
            "abort",
            () => { reject(new Error("cancelled transport")); },
            { once: true },
          );
        });
      },
    });
    const fixture = artifactFixture("1.0.0", Buffer.from("fixture"));
    const controller = new AbortController();
    const assertion = expect(source.download(
      fixture.artifact,
      { signal: controller.signal },
    )).rejects.toMatchObject({ code: "download_failed" });

    controller.abort();

    await assertion;
    expect(observedSignal?.aborted).toBe(true);
  });
});

describe("SafeTunnelFrpcManager", () => {
  it("selects, verifies, extracts, and installs the pinned target", async () => {
    const executable = Buffer.from("#!/bin/sh\necho fixture-frpc\n");
    let requestCount = 0;
    const archivePath = "frp_1.2.3_linux_arm64/frpc";
    const archive = tarGzipFixture([{ path: archivePath, contents: executable }]);
    const server = await listen((_request, response) => {
      requestCount += 1;
      response.writeHead(200, { "content-type": "application/gzip" });
      response.end(archive);
    });
    const fixture = artifactFixture("1.2.3", executable, `${server.origin}/frp.tar.gz`, {
      archive,
      archiveEntryPath: archivePath,
    });
    const manager = managerFor(fixture.manifest, new HttpSafeTunnelFrpcArtifactSource());

    const installed = await manager.ensureManagedFrpc();

    expect(installed.path).toBe(join(
      tempDirectory,
      "safe-tunnel",
      "frpc",
      "versions",
      "1.2.3",
      "linux-arm64",
      "frpc",
    ));
    expect(await readFile(installed.path)).toEqual(executable);
    if (process.platform !== "win32") {
      expect((await stat(installed.path)).mode & 0o777).toBe(0o700);
      expect((await stat(dirname(installed.path))).mode & 0o777).toBe(0o700);
    }
    expect(await temporaryInstallFiles(join(tempDirectory, "safe-tunnel", "frpc"))).toEqual([]);

    await expect(manager.ensureManagedFrpc()).resolves.toEqual(installed);
    expect(requestCount).toBe(1);
  });

  it("does not extract or install after cancellation during download", async () => {
    const executable = Buffer.from("verified frpc");
    const fixture = artifactFixture("1.0.0", executable);
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    let markDownloadStarted = (): void => undefined;
    const downloadStarted = new Promise<void>((resolve) => { markDownloadStarted = resolve; });
    let releaseDownload = (archive: Uint8Array): void => {
      throw new Error(`Download did not start for ${archive.byteLength.toString()} bytes.`);
    };
    const source: SafeTunnelFrpcArtifactSource = {
      download(_artifact, options = {}) {
        observedSignal = options.signal;
        return new Promise<Uint8Array>((resolve) => {
          releaseDownload = resolve;
          markDownloadStarted();
        });
      },
    };
    const extractExecutable = vi.fn(() => Uint8Array.from(executable));
    const installAtomically = vi.fn(() => Promise.resolve());
    const manager = new SafeTunnelFrpcManager({
      archiveExtractor: { extractExecutable },
      artifactSource: source,
      installationStore: {
        executablePath: () => join(tempDirectory, "frpc"),
        installAtomically,
        isVerifiedExisting: () => Promise.resolve(false),
      },
      manifest: fixture.manifest,
      platform: "linux",
      architecture: "arm64",
    });

    const acquisition = manager.ensureManagedFrpc({ signal: controller.signal });
    await downloadStarted;
    expect(observedSignal).toBe(controller.signal);

    controller.abort();
    expect(observedSignal?.aborted).toBe(true);
    releaseDownload(fixture.archive);

    await expect(acquisition).rejects.toThrow();
    expect(extractExecutable).not.toHaveBeenCalled();
    expect(installAtomically).not.toHaveBeenCalled();
  });

  it("rejects a checksum mismatch without installing an executable", async () => {
    const expected = Buffer.from("expected executable bytes");
    const fixture = artifactFixture("1.0.0", expected);
    const tamperedArchive = tarGzipFixture([{
      path: fixture.artifact.archiveEntryPath,
      contents: Buffer.from("tampered executable bytes"),
    }]);

    await expect(managerFor(
      fixture.manifest,
      new FixtureArtifactSource([[fixture.artifact.downloadUrl, tamperedArchive]]),
    ).ensureManagedFrpc()).rejects.toMatchObject({ code: "checksum_mismatch" });
    await expect(readdir(join(tempDirectory, "safe-tunnel", "frpc")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails before downloading when the pinned manifest omits this platform", async () => {
    const source = new FixtureArtifactSource([]);
    const manager = new SafeTunnelFrpcManager({
      archiveExtractor: new TarGzipSafeTunnelFrpcArchiveExtractor(),
      artifactSource: source,
      installationStore: new FileSafeTunnelFrpcInstallationStore({
        installDirectory: join(tempDirectory, "safe-tunnel", "frpc"),
        platform: "darwin",
      }),
      manifest: safeTunnelFrpcManifest,
      platform: "darwin",
      architecture: "x64",
    });

    await expect(manager.ensureManagedFrpc()).rejects.toMatchObject({
      code: "unsupported_platform",
      message: "PI WEB does not provide a managed Safe Tunnel runtime for this platform and architecture.",
    });
    expect(source.calls).toEqual([]);
  });
});

interface ArtifactFixtureOptions {
  readonly archive?: Uint8Array;
  readonly archiveEntryPath?: string;
}

interface ArtifactFixture {
  readonly archive: Uint8Array;
  readonly artifact: SafeTunnelFrpcArtifact;
  readonly manifest: SafeTunnelFrpcManifest;
}

function artifactFixture(
  version: string,
  executable: Uint8Array,
  downloadUrl = `https://fixtures.example.test/frp-${version}.tar.gz`,
  options: ArtifactFixtureOptions = {},
): ArtifactFixture {
  const archiveEntryPath = options.archiveEntryPath ?? `frp_${version}_linux_arm64/frpc`;
  const archive = options.archive
    ?? tarGzipFixture([{ path: archiveEntryPath, contents: executable }]);
  const artifact: SafeTunnelFrpcArtifact = {
    platform: "linux",
    architecture: "arm64",
    archiveFormat: "tar.gz",
    archiveSha256: createHash("sha256").update(archive).digest("hex"),
    archiveSize: archive.byteLength,
    archiveEntryPath,
    downloadUrl,
    executableSha256: createHash("sha256").update(executable).digest("hex"),
    executableSize: executable.byteLength,
  };
  return {
    archive,
    artifact,
    manifest: { version, artifacts: [artifact] },
  };
}

function managerFor(
  manifest: SafeTunnelFrpcManifest,
  artifactSource: SafeTunnelFrpcArtifactSource,
): SafeTunnelFrpcManager {
  return new SafeTunnelFrpcManager({
    archiveExtractor: new TarGzipSafeTunnelFrpcArchiveExtractor(),
    artifactSource,
    installationStore: new FileSafeTunnelFrpcInstallationStore({
      installDirectory: join(tempDirectory, "safe-tunnel", "frpc"),
      platform: "linux",
    }),
    manifest,
    platform: "linux",
    architecture: "arm64",
  });
}

class FixtureArtifactSource implements SafeTunnelFrpcArtifactSource {
  readonly calls: string[] = [];
  private readonly responses: Map<string, Uint8Array | Error>;

  constructor(entries: readonly (readonly [string, Uint8Array | Error])[]) {
    this.responses = new Map(entries);
  }

  download(artifact: SafeTunnelFrpcArtifact): Promise<Uint8Array> {
    this.calls.push(artifact.downloadUrl);
    const response = this.responses.get(artifact.downloadUrl);
    if (response instanceof Error) return Promise.reject(response);
    if (response === undefined) return Promise.reject(new Error("Unexpected fixture download"));
    return Promise.resolve(Uint8Array.from(response));
  }
}

interface LoopbackServer {
  readonly origin: string;
}

async function listen(listener: RequestListener): Promise<LoopbackServer> {
  const server = createServer(listener);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Loopback server has no TCP address");
  }
  return { origin: `http://127.0.0.1:${address.port.toString()}` };
}

function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}

interface TarFixtureEntry {
  readonly path: string;
  readonly contents: Uint8Array;
}

function tarGzipFixture(entries: readonly TarFixtureEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    writeTarText(header, 0, 100, entry.path);
    writeTarOctal(header, 100, 8, 0o755);
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    writeTarOctal(header, 124, 12, entry.contents.byteLength);
    writeTarOctal(header, 136, 12, 0);
    header.fill(32, 148, 156);
    header[156] = "0".charCodeAt(0);
    writeTarText(header, 257, 6, "ustar");
    writeTarText(header, 263, 2, "00");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    writeTarChecksum(header, checksum);
    blocks.push(header, Buffer.from(entry.contents));
    const padding = (512 - (entry.contents.byteLength % 512)) % 512;
    if (padding > 0) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

function writeTarText(
  header: Buffer,
  offset: number,
  length: number,
  value: string,
): void {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength > length) throw new Error("Tar fixture field is too long");
  bytes.copy(header, offset);
}

function writeTarOctal(
  header: Buffer,
  offset: number,
  length: number,
  value: number,
): void {
  const source = `${value.toString(8).padStart(length - 1, "0")}\0`;
  writeTarText(header, offset, length, source);
}

function writeTarChecksum(header: Buffer, checksum: number): void {
  const source = `${checksum.toString(8).padStart(6, "0")}\0 `;
  writeTarText(header, 148, 8, source);
}

async function temporaryInstallFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  await visit(root, files);
  return files.filter((path) => path.includes(".tmp"));
}

async function visit(path: string, files: string[]): Promise<void> {
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await visit(child, files);
    else files.push(child);
  }
}
