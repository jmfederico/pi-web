import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { executeMcpCheck } from "./mcpCheckProcess.js";
import { MCP_CHECK_BOOTSTRAP, MCP_CHECK_OWNER_ENV } from "./mcpCheckBootstrap.js";

import { expectStopped, killFixtureProcess } from "./mcpCheckProcess.testSupport.js";

describe("diagnostic process ownership", () => {
  it.skipIf(process.platform === "win32").each(["complete", "cancel", "deadline"])("cleans an orphaned, separately detached helper on %s without killing unrelated processes", async (reason) => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-mcp-orphan-"));
    const helperPidPath = join(root, "helper.pid");
    const latePidPath = join(root, "late-helper.pid");
    const wrapperPidPath = join(root, "wrapper.pid");
    const exitedPath = join(root, "wrapper-exited");
    const cliPath = join(root, "cli.mjs");
    const lateHelper = `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(latePidPath)}, String(process.pid)); setInterval(() => {}, 1000);`;
    const helper = `
      process.on('SIGTERM', () => {
        // A shutdown handler can start yet another detached process.
        const late = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(lateHelper)}], {detached: true, stdio: 'ignore'});
        require('node:fs').writeFileSync(${JSON.stringify(latePidPath)}, String(late.pid));
      });
      require('node:fs').writeFileSync(${JSON.stringify(helperPidPath)}, String(process.pid));
      process.stdout.write('ready');
      setInterval(() => {}, 1000);
    `;
    const wrapper = `
      require('node:fs').writeFileSync(${JSON.stringify(wrapperPidPath)}, String(process.pid));
      const helper = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(helper)}], {detached: true, stdio: ['ignore', 'pipe', 'ignore']});
      helper.stdout.once('data', () => process.exit(0));
    `;
    await writeFile(cliPath, `
      import {spawn} from 'node:child_process';
      import {writeFileSync} from 'node:fs';
      // An explicit environment must not discard the host's ownership marker.
      const wrapper = spawn(process.execPath, ['-e', ${JSON.stringify(wrapper)}], {detached: true, stdio: 'ignore', env: {PATH: process.env.PATH}});
      await new Promise(resolve => wrapper.once('exit', resolve));
      writeFileSync(${JSON.stringify(exitedPath)}, 'exited');
      ${reason === "complete" ? "process.stdout.write('synthetic success'); process.exit(0);" : "setInterval(() => {}, 1000);"}
    `);
    // Same key, different check: neither this PID nor its group is ours to kill.
    const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true, stdio: "ignore", env: { ...process.env, [MCP_CHECK_OWNER_ENV]: "another-check" },
    });
    const unrelatedExited = new Promise<void>((resolve) => { unrelated.once("exit", () => { resolve(); }); });
    const controller = new AbortController();
    if (reason === "deadline") vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const outcome = executeMcpCheck({ file: process.execPath, args: ["--input-type=module", "--eval", MCP_CHECK_BOOTSTRAP, cliPath], signal: controller.signal, timeoutMs: 90_000 }).catch((error: unknown) => error);
    let finished = false;
    void outcome.then(() => { finished = true; });
    let helperPid: number | undefined;
    let wrapperPid: number | undefined;
    try {
      await vi.waitFor(async () => {
        helperPid = Number(await readFile(helperPidPath, "utf8"));
        wrapperPid = Number(await readFile(wrapperPidPath, "utf8"));
        expect(await readFile(exitedPath, "utf8")).toBe("exited");
      }, { timeout: 5_000 });
      if (wrapperPid === undefined || helperPid === undefined) throw new Error("Missing fixture pid");
      const wrapperId = wrapperPid;
      const helperId = helperPid;
      await vi.waitFor(async () => { await expectStopped(wrapperId); }, { timeout: 5_000 });
      if (reason !== "complete") {
        // The wrapper is already gone; neither its group nor its PPID ancestry
        // can identify the live helper when cancellation/deadline begins.
        process.kill(helperId, 0);
        if (reason === "cancel") controller.abort(new Error("cancelled"));
        else vi.advanceTimersByTime(90_000);
      }
      await vi.waitFor(() => { expect(finished).toBe(true); }, { timeout: 5_000 });
      const result: unknown = await outcome;
      if (reason === "complete") expect(result).toMatchObject({ exitCode: 0, signal: null, stdout: "synthetic success" });
      else {
        expect(result).toBeInstanceOf(Error);
        if (result instanceof AggregateError) throw result;
        expect(result).toMatchObject({ message: reason === "cancel" ? "cancelled" : "MCP connection check timed out" });
      }
      await vi.waitFor(async () => { await expectStopped(helperId); }, { timeout: 5_000 });
      if (reason !== "complete") {
        await vi.waitFor(async () => {
          const latePid = Number(await readFile(latePidPath, "utf8"));
          await expectStopped(latePid);
        }, { timeout: 5_000 });
      }
      expect(unrelated.exitCode).toBeNull();
      if (unrelated.pid === undefined) throw new Error("Missing unrelated fixture pid");
      process.kill(unrelated.pid, 0);
    } finally {
      try {
        controller.abort();
        await vi.waitFor(() => { expect(finished).toBe(true); }, { timeout: 5_000 });
        await outcome;
      } finally {
        vi.useRealTimers();
        try {
          // Read fixture-owned PID files even when startup/assertions fail.
          await killFixtureProcess(helperPidPath);
          await killFixtureProcess(latePidPath);
          await killFixtureProcess(wrapperPidPath);
        } finally {
          unrelated.kill("SIGKILL");
          await unrelatedExited;
          await rm(root, { recursive: true, force: true });
        }
      }
    }
  }, 15_000);

  it.skipIf(process.platform === "win32").each(["cancel", "deadline"])("stops separately detached SIGTERM-resistant servers with a cleared env on %s", async (reason) => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-mcp-process-"));
    const pidPath = join(root, "child.pid");
    const childCode = `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); setInterval(() => {}, 1000);`;
    const parentCode = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], {detached: true, stdio: 'ignore', env: {}}); setInterval(() => {}, 1000);`;
    const controller = new AbortController();
    const outcome = executeMcpCheck({ file: process.execPath, args: ["-e", parentCode], signal: controller.signal, timeoutMs: reason === "deadline" ? 2_000 : 10_000 }).catch((error: unknown) => error);
    let pid: number | undefined;
    try {
      await vi.waitFor(async () => { pid = Number(await readFile(pidPath, "utf8")); }, { timeout: 5_000 });
      if (reason === "cancel") controller.abort(new Error("cancelled"));
      const error: unknown = await outcome;
      expect(error).toBeInstanceOf(Error);
      if (error instanceof AggregateError) throw error;
      if (reason === "deadline" && error instanceof Error) expect(error.message).toContain("timed out");
      await vi.waitFor(async () => {
        if (pid === undefined) throw new Error("No child pid");
        await expectStopped(pid);
      }, { timeout: 5_000 });
    } finally {
      controller.abort();
      await outcome;
      try { await killFixtureProcess(pidPath); }
      finally { await rm(root, { recursive: true, force: true }); }
    }
  });
});
