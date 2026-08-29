import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createServerPluginExecFile } from "./serverPluginExec.js";

describe("server plugin execFile helper", () => {
  it("runs argv without a shell, returns nonzero exits, and bounds both output streams", async () => {
    const execFile = createServerPluginExecFile({ maxTimeoutMs: 2_000, maxOutputBytes: 8 });
    const signal = new AbortController().signal;

    const result = await execFile({
      file: process.execPath,
      args: ["-e", "process.stdout.write('abcdefghijkl'); process.stderr.write('uvwxyz0123'); process.exit(7)"],
      signal,
    });

    expect(result).toEqual({
      exitCode: 7,
      signal: null,
      stdout: "abcdefgh",
      stderr: "uvwxyz01",
      stdoutTruncated: true,
      stderrTruncated: true,
    });
  });

  it("retains the existing 2 MiB Git command-output ceiling by default", async () => {
    const execFile = createServerPluginExecFile();

    const result = await execFile({
      file: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(2 * 1024 * 1024 + 1))"],
      signal: new AbortController().signal,
    });

    expect(result.stdout).toHaveLength(2 * 1024 * 1024);
    expect(result.stdoutTruncated).toBe(true);
  });

  it("merges environment overrides, removes requested host keys, and never expands a shell", async () => {
    const execFile = createServerPluginExecFile({ env: { BASE_VALUE: "base", REMOVE_ME: "host" } });

    const result = await execFile({
      file: process.execPath,
      args: ["-e", "process.stdout.write(`${process.env.BASE_VALUE}:${process.env.PLUGIN_VALUE}:${String(process.env.REMOVE_ME)}`)"],
      env: { PLUGIN_VALUE: "$BASE_VALUE literal", REMOVE_ME: "plugin" },
      unsetEnv: ["REMOVE_ME"],
      signal: new AbortController().signal,
    });

    expect(result.stdout).toBe("base:$BASE_VALUE literal:undefined");
  });

  it("pipes a string payload to the command's standard input without a shell", async () => {
    const execFile = createServerPluginExecFile();

    const result = await execFile({
      file: process.execPath,
      args: ["-e", "let data='';process.stdin.setEncoding('utf8');process.stdin.on('data',(chunk)=>{data+=chunk});process.stdin.on('end',()=>process.stdout.write(data.toUpperCase()))"],
      stdin: "secret-payload",
      signal: new AbortController().signal,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("SECRET-PAYLOAD");
  });

  it("pipes binary Uint8Array payloads byte for byte", async () => {
    const execFile = createServerPluginExecFile();
    const payload = new Uint8Array([0, 1, 2, 250, 251, 252, 10, 13, 255]);
    const expectedPayload = [...payload];
    const expectedHex = Buffer.from(payload).toString("hex");

    const result = await execFile({
      file: process.execPath,
      args: ["-e", "const chunks=[];process.stdin.on('data',(chunk)=>chunks.push(chunk));process.stdin.on('end',()=>process.stdout.write(Buffer.concat(chunks).toString('hex')))"],
      stdin: payload,
      signal: new AbortController().signal,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(expectedHex);
    expect([...payload]).toEqual(expectedPayload);
  });

  it("treats an empty stdin payload like an absent one", async () => {
    const execFile = createServerPluginExecFile();

    const result = await execFile({
      file: process.execPath,
      args: ["-e", "let bytes=0;process.stdin.on('data',(chunk)=>{bytes+=chunk.length});process.stdin.on('end',()=>process.stdout.write(String(bytes)))"],
      stdin: "",
      signal: new AbortController().signal,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("0");
  });

  it("resolves commands that exit without reading their stdin", async () => {
    const execFile = createServerPluginExecFile();

    const result = await execFile({
      file: process.execPath,
      args: ["-e", "process.stdin.destroy();process.exit(3)"],
      stdin: "x".repeat(128 * 1024),
      signal: new AbortController().signal,
    });

    expect(result.exitCode).toBe(3);
  });

  it("zeroes its retained stdin copy when spawn throws synchronously", async () => {
    const secret = "sync-spawn-secret";
    const payload = new TextEncoder().encode(secret);
    const expectedPayload = [...payload];
    const fill = vi.spyOn(Buffer.prototype, "fill");
    try {
      const execFile = createServerPluginExecFile();
      const error: unknown = await execFile({
        file: "invalid\0file",
        stdin: payload,
        signal: new AbortController().signal,
      }).then(
        () => { throw new Error("Expected spawn to fail"); },
        (reason: unknown) => reason,
      );

      expect(error).toBeInstanceOf(Error);
      expect(error instanceof Error ? error.message : String(error)).not.toContain(secret);
      const fillInstances: unknown[] = fill.mock.instances;
      const retainedPayloads = fillInstances.filter((instance): instance is Buffer => (
        Buffer.isBuffer(instance) && instance.byteLength === payload.byteLength
      ));
      expect(retainedPayloads).toHaveLength(1);
      const retainedPayload = retainedPayloads[0];
      if (retainedPayload === undefined) throw new Error("Expected the retained stdin Buffer to be wiped");
      expect([...retainedPayload]).toEqual(new Array<number>(payload.byteLength).fill(0));
      expect([...payload]).toEqual(expectedPayload);
    } finally {
      fill.mockRestore();
    }
  });

  it("rejects stdin payloads above the configured byte cap before spawning", async () => {
    const execFile = createServerPluginExecFile({ maxStdinBytes: 8 });

    await expect(execFile({
      file: process.execPath,
      args: ["-e", "process.exit(0)"],
      stdin: "123456789",
      signal: new AbortController().signal,
    })).rejects.toThrow("8 bytes");
  });

  it("measures string payloads in UTF-8 bytes against the default 1 MiB cap", async () => {
    const execFile = createServerPluginExecFile();

    await expect(execFile({
      file: process.execPath,
      args: ["-e", "process.exit(0)"],
      // Each character encodes to two UTF-8 bytes: 1 MiB + 2 bytes total.
      stdin: "é".repeat(512 * 1024 + 1),
      signal: new AbortController().signal,
    })).rejects.toThrow("1048576 bytes");
  });

  it("rejects non-string non-binary stdin payloads before spawning", async () => {
    const execFile = createServerPluginExecFile();

    await expect(execFile({
      file: process.execPath,
      args: ["-e", "process.exit(0)"],
      // @ts-expect-error Exercise the runtime boundary used by plain JavaScript plugins.
      stdin: 42,
      signal: new AbortController().signal,
    })).rejects.toThrow("stdin must be a string or Uint8Array");
  });

  it("rejects malformed environment keys before spawning", async () => {
    const execFile = createServerPluginExecFile();

    await expect(execFile({
      file: process.execPath,
      args: ["-e", "process.exit(99)"],
      unsetEnv: ["INVALID=KEY"],
      signal: new AbortController().signal,
    })).rejects.toThrow("unsetEnv keys");
  });

  it("rejects an already-aborted operation without spawning", async () => {
    const execFile = createServerPluginExecFile();
    const controller = new AbortController();
    const reason = new Error("caller stopped");
    controller.abort(reason);

    await expect(execFile({
      file: process.execPath,
      args: ["-e", "process.exit(0)"],
      signal: controller.signal,
    })).rejects.toBe(reason);
  });

  it("rejects malformed AbortSignal lookalikes before spawning", async () => {
    const execFile = createServerPluginExecFile();
    const malformedSignal = { aborted: false, addEventListener() { /* incomplete untyped plugin input */ } };

    await expect(execFile({
      file: process.execPath,
      args: ["-e", "process.exit(99)"],
      // @ts-expect-error Exercise the runtime boundary used by plain JavaScript plugins.
      signal: malformedSignal,
    })).rejects.toThrow("AbortSignal");
  });

  it.skipIf(process.platform === "win32")("terminates the command process group when a deadline expires", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "pi-web-plugin-exec-tree-"));
    const pidPath = join(tempDir, "descendant.pid");
    let descendantPid: number | undefined;
    try {
      const execFile = createServerPluginExecFile({ maxTimeoutMs: 200 });
      const parentSource = `
        const { spawn } = require("node:child_process");
        const { writeFileSync } = require("node:fs");
        const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
        writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));
        setInterval(() => {}, 1000);
      `;

      await expect(execFile({
        file: process.execPath,
        args: ["-e", parentSource],
        signal: new AbortController().signal,
      })).rejects.toThrow("200ms");
      descendantPid = Number(await readFile(pidPath, "utf8"));

      await expectProcessExit(descendantPid);
    } finally {
      if (descendantPid !== undefined && processIsAlive(descendantPid)) {
        process.kill(descendantPid, "SIGKILL");
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("enforces the host timeout cap", async () => {
    const execFile = createServerPluginExecFile({ maxTimeoutMs: 40 });

    await expect(execFile({
      file: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      timeoutMs: 5_000,
      signal: new AbortController().signal,
    })).rejects.toThrow("40ms");
  });
});

async function expectProcessExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!processIsAlive(pid)) return;
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, 10); });
  }
  throw new Error(`Descendant process ${String(pid)} survived the command deadline`);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
