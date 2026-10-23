import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBunPtyProvider, type BunPtyRuntime, type BunTerminalHandle } from "./bunPtyProvider.js";
import { createNodePtyProvider } from "./nodePtyProvider.js";
import { createDefaultPtyProvider, inspectPtyProvider } from "./ptyComposition.js";
import type { PtyHandle } from "./ptyProvider.js";

function bunFixture() {
  let callbacks: Parameters<BunPtyRuntime["spawn"]>[1] | undefined;
  const terminal = { write: vi.fn(() => 0), resize: vi.fn(), close: vi.fn() };
  const kill = vi.fn();
  const runtime: BunPtyRuntime = {
    Terminal: class implements BunTerminalHandle {
      write = terminal.write;
      resize = terminal.resize;
      close = terminal.close;
    },
    spawn(_command, options) {
      callbacks = options;
      return { terminal, kill };
    },
  };
  return {
    runtime, terminal, kill,
    data(bytes: number[]) { callbacks?.terminal.data(terminal, new Uint8Array(bytes)); },
    eof() { callbacks?.terminal.exit(terminal); },
    exit(code: number | null) { callbacks?.onExit({}, code); },
  };
}

const spawnOptions = { shell: "/bin/sh", args: [], cwd: process.cwd(), cols: 80, rows: 24, env: process.env };

describe("PTY composition", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it("uses factual runtime identity despite conflicting runtime environment hints", () => {
    vi.stubEnv("PI_WEB_RUNTIME", process.versions["bun"] === undefined ? "bun" : "node");
    expect(createDefaultPtyProvider().kind).toBe(process.versions["bun"] === undefined ? "node" : "bun");
    expect(inspectPtyProvider().kind).toBe(process.versions["bun"] === undefined ? "node" : "bun");
  });

  it("fails explicitly for Bun without native PTY support", () => {
    expect(() => createBunPtyProvider({ spawn: vi.fn() })).toThrow(/Bun native Terminal/);
  });

  it("does not load node-pty until a terminal is requested and retains the loading cause", () => {
    const cause = new Error("binding missing");
    const load = vi.fn(() => { throw cause; });
    const provider = createNodePtyProvider(load);
    expect(load).not.toHaveBeenCalled();
    expect(() => provider.spawn(spawnOptions, { output: vi.fn(), exit: vi.fn() })).toThrow(expect.objectContaining({ cause }));
  });
});

describe("Node PTY lifecycle adapter", () => {
  it.each(["exit", "dispose"] as const)("releases subscriptions and suppresses late events after %s", (action) => {
    let onData: (data: string) => void = () => undefined;
    let onExit: (event: { exitCode: number }) => void = () => undefined;
    const unsubscribeData = vi.fn();
    const unsubscribeExit = vi.fn();
    const kill = vi.fn();
    const provider = createNodePtyProvider(() => ({
      spawn: () => ({
        write: vi.fn(), resize: vi.fn(), kill,
        onData(callback) { onData = callback; return { dispose: unsubscribeData }; },
        onExit(callback) { onExit = callback; return { dispose: unsubscribeExit }; },
      }),
    }));
    const output = vi.fn();
    const exit = vi.fn();
    const handle = provider.spawn(spawnOptions, { output, exit });
    onData("last output");
    if (action === "exit") onExit({ exitCode: 7 });
    else handle.dispose();
    onData("late output");
    onExit({ exitCode: 9 });
    handle.dispose();
    handle.dispose();
    expect(output).toHaveBeenCalledExactlyOnceWith("last output");
    if (action === "exit") {
      expect(exit).toHaveBeenCalledExactlyOnceWith(7);
      expect(kill).not.toHaveBeenCalled();
    } else {
      expect(exit).not.toHaveBeenCalled();
      expect(kill).toHaveBeenCalledTimes(1);
    }
    // Explicit dispose after natural exit may re-dispose an event subscription.
    expect(unsubscribeData).toHaveBeenCalled();
    expect(unsubscribeExit).toHaveBeenCalled();
  });
});

describe("Bun PTY lifecycle adapter", () => {
  it.each(["process-first", "eof-first"])("waits for output EOF and process status (%s), decodes UTF-8, and closes once", (order) => {
    const fake = bunFixture();
    const events: string[] = [];
    const handle = createBunPtyProvider(fake.runtime).spawn(spawnOptions, {
      output(data) { events.push(data); }, exit(code) { events.push(`exit:${String(code)}`); },
    });
    fake.data([0xe2]);
    if (order === "process-first") fake.exit(7);
    fake.data([0x82, 0xac]);
    expect(events).toEqual(["€"]);
    if (order === "eof-first") fake.eof();
    expect(fake.terminal.close).not.toHaveBeenCalled();
    if (order === "process-first") fake.eof();
    else fake.exit(7);
    expect(events).toEqual(["€", "exit:7"]);
    expect(fake.terminal.close).toHaveBeenCalledTimes(1);
    fake.data([65]);
    fake.exit(9);
    fake.eof();
    handle.dispose();
    handle.dispose();
    expect(events).toEqual(["€", "exit:7"]);
    expect(fake.terminal.close).toHaveBeenCalledTimes(1);
    expect(fake.kill).not.toHaveBeenCalled();
  });

  it("flushes an incomplete UTF-8 sequence before exit", () => {
    const fake = bunFixture();
    const events: string[] = [];
    createBunPtyProvider(fake.runtime).spawn(spawnOptions, {
      output(data) { events.push(data); }, exit() { events.push("exit"); },
    });
    fake.data([0xe2]);
    fake.eof();
    fake.exit(0);
    expect(events).toEqual(["�", "exit"]);
  });

  it("disposes live processes once and ignores late callbacks", () => {
    const fake = bunFixture();
    const output = vi.fn();
    const exit = vi.fn();
    const handle = createBunPtyProvider(fake.runtime).spawn(spawnOptions, { output, exit });
    handle.write("hi");
    handle.resize(100, 30);
    expect(fake.terminal.write).toHaveBeenCalledWith("hi");
    expect(fake.terminal.resize).toHaveBeenCalledWith(100, 30);
    handle.dispose();
    handle.dispose();
    fake.data([65]);
    fake.exit(0);
    fake.eof();
    handle.write("ignored");
    expect(fake.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    expect(fake.terminal.close).toHaveBeenCalledTimes(1);
    expect(fake.terminal.write).toHaveBeenCalledTimes(1);
    expect(output).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });
});

// Run this same contract in the parent's Node and Bun Docker jobs. A missing native
// binding/capability is a failure, not a skipped test or a fallback to another provider.
describe.skipIf(process.platform === "win32")("real runtime PTY contract", () => {
  const handles: PtyHandle[] = [];
  afterEach(() => { for (const handle of handles.splice(0)) handle.dispose(); });

  it("is a TTY, propagates env/cwd, resizes, and delivers final output before the process exit", async () => {
    let output = "";
    let resolveExit: (code: number | undefined) => void = () => undefined;
    const exited = new Promise<number | undefined>((resolve) => { resolveExit = resolve; });
    let sentInput = false;
    const handle = createDefaultPtyProvider().spawn({
      ...spawnOptions, args: ["-c", "test -t 0 && test -t 1 || exit 90; printf 'READY\\n'; read line; stty size; printf 'ENV:%s\\n' \"$PTY_CONTRACT\"; pwd; printf 'FINAL:€'; exit 7"],
      env: { ...process.env, PTY_CONTRACT: "present" },
    }, {
      output(data) {
        output += data;
        if (output.includes("READY") && !sentInput) {
          sentInput = true;
          handle.resize(101, 37);
          handle.write("go\n");
        }
      },
      exit: resolveExit,
    });
    handles.push(handle);
    expect(await exited).toBe(7);
    expect(output).toContain("37 101");
    expect(output).toContain("ENV:present");
    expect(output).toContain(process.cwd());
    expect(output).toContain("FINAL:€");
  }, 10_000);

  it("disposal terminates and reaps the real child without publishing callbacks afterward", async () => {
    let output = "";
    let resolvePid: (pid: number) => void = () => undefined;
    const ready = new Promise<number>((resolve) => { resolvePid = resolve; });
    const exit = vi.fn();
    const handle = createDefaultPtyProvider().spawn({
      ...spawnOptions, args: ["-c", "printf 'PID:%s\\n' \"$$\"; read line"],
    }, {
      output(data) {
        output += data;
        const match = /PID:(\d+)/u.exec(output);
        if (match !== null) resolvePid(Number(match[1]));
      }, exit,
    });
    handles.push(handle);
    const pid = await ready;
    handle.dispose();
    handle.dispose();
    const deadline = Date.now() + 5_000;
    const alive = (): boolean => {
      try { process.kill(pid, 0); return true; } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
        throw error;
      }
    };
    while (alive() && Date.now() < deadline) await delay(10);
    expect(alive()).toBe(false);
    expect(exit).not.toHaveBeenCalled();
  }, 10_000);

  it("delivers Ctrl-C through the PTY to the foreground process", async () => {
    let output = "";
    let interrupted = false;
    let resolveExit: (code: number | undefined) => void = () => undefined;
    const exited = new Promise<number | undefined>((resolve) => { resolveExit = resolve; });
    const handle = createDefaultPtyProvider().spawn({
      ...spawnOptions, shell: "/bin/bash", args: ["--noprofile", "--norc", "-c", "trap 'exit 23' INT; printf BLOCKING; while :; do :; done"],
    }, {
      output(data) {
        output += data;
        if (output.includes("BLOCKING") && !interrupted) {
          interrupted = true;
          handle.write("\x03");
        }
      }, exit: resolveExit,
    });
    handles.push(handle);
    expect(await exited).toBe(23);
    expect(output).not.toContain("no job control");
  }, 10_000);
});
