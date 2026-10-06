import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createServerPluginExecFile } from "./serverPluginExec.js";

// Readiness polling must use real time without advancing the fake command deadline.
const waitForIo = delay;

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
    const controller = new AbortController();
    const execFile = createServerPluginExecFile({ maxTimeoutMs: 200 });
    let command: ReturnType<typeof execFile> | undefined;
    let descendantPid: number | undefined;
    // Keep real process startup outside the 200 ms deadline, even under suite load.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const parentSource = `
        const { spawn } = require("node:child_process");
        const { writeFileSync } = require("node:fs");
        const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
        writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));
        setInterval(() => {}, 1000);
      `;

      command = execFile({
        file: process.execPath,
        args: ["-e", parentSource],
        signal: controller.signal,
      });
      // Observe early spawn errors; the original promise is still asserted below.
      void command.catch(() => undefined);
      descendantPid = await waitForDescendantPid(pidPath);
      expect(processIsAlive(descendantPid)).toBe(true);

      const timedOut = expect(command).rejects.toThrow("200ms");
      await vi.advanceTimersByTimeAsync(200);
      await timedOut;
      await vi.runOnlyPendingTimersAsync();
      await expectProcessExit(descendantPid);
    } finally {
      controller.abort();
      try {
        await vi.runOnlyPendingTimersAsync();
        await command?.catch(() => undefined);
      } finally {
        vi.useRealTimers();
        try {
          if (descendantPid !== undefined && processIsAlive(descendantPid)) {
            process.kill(descendantPid, "SIGKILL");
          }
        } finally {
          await rm(tempDir, { recursive: true, force: true });
        }
      }
    }
  }, 10_000);

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

async function waitForDescendantPid(pidPath: string): Promise<number> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      const pid = Number(await readFile(pidPath, "utf8"));
      if (Number.isSafeInteger(pid) && pid > 0) return pid;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    await waitForIo(10);
  }
  throw new Error("Command fixture did not publish its descendant PID");
}

async function expectProcessExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!processIsAlive(pid)) return;
    await waitForIo(10);
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
