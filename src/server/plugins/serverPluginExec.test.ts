import { fork, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServerPluginExecFile } from "./serverPluginExec.js";

// Node's ESM exports are not configurable; replace only the helper fork boundary.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, fork: vi.fn(actual.fork) };
});

// Readiness polling must use real time without advancing the fake command deadline.
const waitForIo = delay;

afterEach(() => {
  vi.mocked(fork).mockClear();
});

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

  it("starts commands from a helper process instead of the calling process", async () => {
    const execFile = createServerPluginExecFile();
    const parentPid = async (): Promise<string> => (await execFile({
      file: process.execPath,
      args: ["-e", "process.stdout.write(String(process.ppid))"],
      signal: new AbortController().signal,
    })).stdout;

    const first = await parentPid();

    expect(first).not.toBe(String(process.pid));
    expect(await parentPid()).toBe(first);
  });

  it.skipIf(process.platform === "win32")("keeps the helper outside the calling process's process group", async () => {
    const execFile = createServerPluginExecFile();
    const helperPid = Number((await execFile({
      file: process.execPath,
      args: ["-e", "process.stdout.write(String(process.ppid))"],
      signal: new AbortController().signal,
    })).stdout);

    // Signal 0 only probes. The group exists only if the helper leads its own, so a signal
    // sent to the caller's group, as service supervisors do, leaves its commands running.
    expect(() => process.kill(-helperPid, 0)).not.toThrow();
  });

  it("starts the helper before the first command only when asked", () => {
    createServerPluginExecFile();
    expect(fork).not.toHaveBeenCalled();

    createServerPluginExecFile({ prestartHelper: true });
    expect(fork).toHaveBeenCalledOnce();
  });

  it("rejects a command whose helper cannot be started without leaving its deadline armed", async () => {
    const execFile = createServerPluginExecFile();
    vi.mocked(fork).mockImplementationOnce(() => { throw new Error("spawn ENOMEM"); });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await expect(execFile({
        file: process.execPath,
        signal: new AbortController().signal,
      })).rejects.toThrow("spawn ENOMEM");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("kills and rejects running commands when the helper exits, then starts a new helper", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "pi-web-plugin-exec-helper-"));
    const pidPath = join(tempDir, "command.pid");
    const execFile = createServerPluginExecFile();
    const running = execFile({
      file: process.execPath,
      args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(pidPath)}, process.pid + " " + process.ppid); setInterval(() => {}, 1000)`],
      signal: new AbortController().signal,
    });
    void running.catch(() => undefined);
    let commandPid: number | undefined;
    try {
      const [command, helper] = (await waitForPidFile(pidPath)).split(" ").map(Number);
      if (command === undefined || helper === undefined || helper === process.pid) throw new Error("Command fixture published invalid PIDs");
      commandPid = command;
      process.kill(helper, "SIGKILL");
      await expect(running).rejects.toThrow("helper exited");
      await expectProcessExit(command);
    } finally {
      if (commandPid !== undefined && processIsAlive(commandPid)) process.kill(commandPid, "SIGKILL");
      await rm(tempDir, { recursive: true, force: true });
    }
    const next = await execFile({
      file: process.execPath,
      args: ["-e", "process.stdout.write('ok')"],
      signal: new AbortController().signal,
    });
    expect(next.stdout).toBe("ok");
  });

  it.skipIf(process.platform === "win32")("kills a command whose start is still unread when a later send to the lost helper fails", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "pi-web-plugin-exec-unread-"));
    const pidPath = join(tempDir, "command.pid");
    const execFile = createServerPluginExecFile();
    const signal = new AbortController().signal;
    await execFile({ file: process.execPath, args: ["-e", ""], signal });
    const running = execFile({
      file: process.execPath,
      args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(pidPath)}, process.pid + " " + process.ppid); setInterval(() => {}, 1000)`],
      signal,
    });
    void running.catch(() => undefined);
    let commandPid: number | undefined;
    try {
      // Stay in one turn, like a busy daemon, so the helper's report of the command's PID stays unread.
      let pids = "";
      for (let attempt = 0; pids === "" && attempt < 500; attempt += 1) {
        sleepSync(10);
        pids = existsSync(pidPath) ? readFileSync(pidPath, "utf8") : "";
      }
      const [command, helper] = pids.split(" ").map(Number);
      if (command === undefined || helper === undefined || helper === process.pid) throw new Error("Command fixture published invalid PIDs");
      commandPid = command;
      process.kill(helper, "SIGKILL");
      // Long enough for the helper's end of the channel to close, so the next send fails.
      sleepSync(100);
      const next = execFile({ file: process.execPath, args: ["-e", ""], signal });

      await expect(next).rejects.toThrow("helper exited");
      await expect(running).rejects.toThrow("helper exited");
      await expectProcessExit(command);
    } finally {
      if (commandPid !== undefined && processIsAlive(commandPid)) process.kill(commandPid, "SIGKILL");
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("still kills a cancelled command after the calling process is gone", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "pi-web-plugin-exec-caller-"));
    const pidPath = join(tempDir, "command.pid");
    const callerPath = join(tempDir, "caller.mjs");
    // Only the helper's SIGKILL after the grace period can end this command.
    const stubbornSource = `process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(${JSON.stringify(pidPath)}, process.pid + " " + process.ppid); setInterval(() => {}, 1000)`;
    await writeFile(callerPath, `
      import { readFileSync } from "node:fs";
      import { createServerPluginExecFile } from ${JSON.stringify(pathToFileURL(resolve("src/server/plugins/serverPluginExec.ts")).href)};
      const execFile = createServerPluginExecFile();
      const controller = new AbortController();
      execFile({ file: process.execPath, args: ["-e", ${JSON.stringify(stubbornSource)}], signal: controller.signal }).catch(() => undefined);
      let pids = "";
      for (let attempt = 0; pids === "" && attempt < 500; attempt += 1) {
        await new Promise((resolve) => { setTimeout(resolve, 10); });
        try { pids = readFileSync(${JSON.stringify(pidPath)}, "utf8"); } catch {}
      }
      if (pids === "") process.exit(1);
      // The stopped helper handles the cancellation and the next command only after this process is gone.
      process.kill(Number(pids.split(" ")[1]), "SIGSTOP");
      controller.abort();
      execFile({ file: process.execPath, args: ["-e", ""], signal: new AbortController().signal }).catch(() => undefined);
      process.kill(process.pid, "SIGKILL");
    `, "utf8");
    const caller = spawn(process.execPath, ["--import", "tsx", callerPath], { stdio: ["ignore", "ignore", "inherit"] });
    try {
      expect(await once(caller, "exit")).toEqual([null, "SIGKILL"]);
      const [command, helper] = (await waitForPidFile(pidPath)).split(" ").map(Number);
      if (command === undefined || helper === undefined) throw new Error("Command fixture published invalid PIDs");
      process.kill(helper, "SIGCONT");
      await expectProcessExit(command);
    } finally {
      if (caller.exitCode === null && caller.signalCode === null) caller.kill("SIGKILL");
      const pids = await readFile(pidPath, "utf8").catch(() => "");
      for (const pid of pids.split(" ").map(Number)) {
        if (pid > 0 && processIsAlive(pid)) process.kill(pid, "SIGKILL");
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 10_000);

  it("reports a missing executable with its spawn error code", async () => {
    const execFile = createServerPluginExecFile();

    await expect(execFile({
      file: "pi-web-missing-command-for-test",
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "ENOENT" });
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
      await expectProcessExit(descendantPid);
    } finally {
      controller.abort();
      try {
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
  const pid = Number(await waitForPidFile(pidPath));
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Command fixture published an invalid PID");
  return pid;
}

async function waitForPidFile(pidPath: string): Promise<string> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      const content = await readFile(pidPath, "utf8");
      if (content !== "") return content;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    await waitForIo(10);
  }
  throw new Error("Command fixture did not publish its PID");
}

async function expectProcessExit(pid: number): Promise<void> {
  // Longer than the helper's grace period before SIGKILL.
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (!processIsAlive(pid)) return;
    await waitForIo(10);
  }
  throw new Error(`Descendant process ${String(pid)} survived the command deadline`);
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
