/* eslint-disable @typescript-eslint/consistent-type-assertions */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
/* eslint-disable @typescript-eslint/no-extraneous-class -- empty-class stubs are the Bun global fakes */
import { BunPTYBackend, NodePTYBackend } from "./ptyBackend.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

type GlobalRecord = Record<string, unknown>;

interface FakeBunTerminal {
  write: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

interface FakeBunHarness {
  terminal: FakeBunTerminal;
  dataCb: ((terminal: unknown, data: Uint8Array) => void) | undefined;
  spawn: ReturnType<typeof vi.fn>;
  spawnExitCb: ((subprocess: unknown, exitCode: number | null, signal: string | null) => void) | undefined;
}

/** Installs a controllable fake `Bun` global with `Bun.Terminal` capability and returns its harness. */
function installFakeBun(): FakeBunHarness {
  const harness: FakeBunHarness = {
    terminal: { write: vi.fn(), resize: vi.fn(), close: vi.fn() },
    dataCb: undefined,
    spawn: vi.fn(),
    spawnExitCb: undefined,
  };
  (globalThis as GlobalRecord)["Bun"] = {
    spawn: harness.spawn,
    Terminal: class {
      readonly write = harness.terminal.write;
      readonly resize = harness.terminal.resize;
      readonly close = harness.terminal.close;
      constructor(options: { data?: (terminal: unknown, data: Uint8Array) => void }) {
        harness.dataCb = options.data;
      }
    },
  };
  harness.spawn.mockImplementation((_cmd: unknown, opts: { onExit?: (sub: unknown, code: number | null, signal: string | null) => void }) => {
    harness.spawnExitCb = opts.onExit;
    return { kill: vi.fn(), onExit: vi.fn() };
  });
  return harness;
}

const originalBun = (globalThis as GlobalRecord)["Bun"];

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  if (originalBun === undefined) delete (globalThis as GlobalRecord)["Bun"];
  else (globalThis as GlobalRecord)["Bun"] = originalBun;
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */
/*  Backend factory selection                                          */
/* ------------------------------------------------------------------ */

describe("createDefaultBackend selection", () => {
  it("selects the Bun PTY backend under a Bun with Bun.Terminal", async () => {
    (globalThis as GlobalRecord)["Bun"] = { spawn: vi.fn(), Terminal: class {} };
    const { createDefaultBackend: freshFactory, BunPTYBackend: FreshBun } = await import("./ptyBackend.js");
    expect(freshFactory()).toBeInstanceOf(FreshBun);
  });

  it("falls back to the node-pty backend under a Bun without Bun.Terminal", async () => {
    (globalThis as GlobalRecord)["Bun"] = { spawn: vi.fn() };
    const { createDefaultBackend: freshFactory, NodePTYBackend: FreshNode } = await import("./ptyBackend.js");
    expect(freshFactory()).toBeInstanceOf(FreshNode);
  });

  it("falls back to the node-pty backend under Node.js", async () => {
    delete (globalThis as GlobalRecord)["Bun"];
    const { createDefaultBackend: freshFactory, NodePTYBackend: FreshNode } = await import("./ptyBackend.js");
    expect(freshFactory()).toBeInstanceOf(FreshNode);
  });

  // The launcher gate, doctor, and this factory must agree on what counts as a
  // usable Bun PTY: one shared check keeps SPEC D4/F5's drift class impossible.
  it("agrees with the canonical shared runtime detector under every Bun shape", async () => {
    const { piWebRuntimeKind, bunTerminalCapability } = await import("../../../src/shared/piWebRuntime.js");
    for (const bun of [
      undefined,
      { spawn: vi.fn() },
      { spawn: vi.fn(), Terminal: class {} },
      { Terminal: class {} },
    ]) {
      if (bun === undefined) delete (globalThis as GlobalRecord)["Bun"];
      else (globalThis as GlobalRecord)["Bun"] = bun;
      const fresh = await import("./ptyRuntime.js");
      expect(fresh.piWebRuntimeKind()).toBe(piWebRuntimeKind());
      expect(fresh.bunTerminalCapability()).toBe(bunTerminalCapability());
      expect(fresh.isBunRuntime()).toBe(piWebRuntimeKind() === "bun");
    }
  });
});

/* ------------------------------------------------------------------ */
/*  BunPTYBackend                                                      */
/* ------------------------------------------------------------------ */

describe("BunPTYBackend", () => {
  it("is available under a Bun with Bun.Terminal and not without it", async () => {
    (globalThis as GlobalRecord)["Bun"] = { spawn: vi.fn(), Terminal: class {} };
    const { BunPTYBackend: Fresh } = await import("./ptyBackend.js");
    expect(new Fresh().available()).toBe(true);

    (globalThis as GlobalRecord)["Bun"] = { spawn: vi.fn() };
    const without = new Fresh();
    expect(without.available()).toBe(false);
    without.dispose();
  });

  it("is not available outside Bun even if a Terminal-shaped global exists", async () => {
    (globalThis as GlobalRecord)["Bun"] = undefined;
    (globalThis as GlobalRecord)["Terminal"] = class {};
    try {
      const { BunPTYBackend: Fresh } = await import("./ptyBackend.js");
      expect(new Fresh().available()).toBe(false);
    } finally {
      delete (globalThis as GlobalRecord)["Terminal"];
    }
  });

  it("spawns the shell detached with the PTY attached and the requested environment", () => {
    const harness = installFakeBun();
    const backend = new BunPTYBackend();
    try {
      backend.create({
        cwd: "/tmp",
        shell: "/bin/bash",
        shellArgs: ["-l"],
        cols: 80,
        rows: 24,
        env: { HOME: "/root", TERM: "xterm-256color", PI_WEB_TERMINAL: "1" },
      });

      expect(harness.spawn).toHaveBeenCalledTimes(1);
      const [cmd, opts] = harness.spawn.mock.calls[0] as [string[], Record<string, unknown>];
      expect(cmd).toEqual(["/bin/bash", "-l"]);
      // `detached` (setsid) gives the shell a controlling terminal on the PTY —
      // job control (oven-sh/bun#33240); see ptyBackend.ts for the probe notes.
      expect(opts["detached"]).toBe(true);
      expect(opts["cwd"]).toBe("/tmp");
      expect(opts["terminal"]).toBeTypeOf("object");
      const env = opts["env"] as Record<string, string>;
      expect(env["HOME"]).toBe("/root");
      expect(env["TERM"]).toBe("xterm-256color");
      expect(env["PI_WEB_TERMINAL"]).toBe("1");
    } finally {
      backend.dispose();
    }
  });

  it("closes the terminal when the spawn fails so the master fd does not leak", () => {
    const harness = installFakeBun();
    harness.spawn.mockImplementation(() => {
      throw new Error("spawn ENOENT");
    });
    const backend = new BunPTYBackend();
    expect(() =>
      backend.create({ cwd: "/tmp", shell: "/nonexistent", shellArgs: [], env: {} }),
    ).toThrow("spawn ENOENT");
    expect(harness.terminal.close).toHaveBeenCalled();
  });

  it("delivers decoded terminal output through the attached output handler", () => {
    const harness = installFakeBun();
    const backend = new BunPTYBackend();
    const { id } = backend.create({ cwd: "/tmp", shell: "/bin/bash", shellArgs: [], env: {} });
    const output = vi.fn();
    const exit = vi.fn();
    backend.attach(id, { output, exit });

    harness.dataCb?.(undefined, new TextEncoder().encode("hello\n"));
    harness.dataCb?.(undefined, new TextEncoder().encode("world\n"));

    expect(output).toHaveBeenCalledWith("hello\n");
    expect(output).toHaveBeenCalledWith("world\n");
    expect(exit).not.toHaveBeenCalled();
    backend.dispose();
  });

  // Multi-byte UTF-8 sequences can be split across data chunks; a per-chunk
  // decode would corrupt them, so the backend streams through a TextDecoder.
  it("reassembles multi-byte characters split across data chunks", () => {
    const harness = installFakeBun();
    const backend = new BunPTYBackend();
    const { id } = backend.create({ cwd: "/tmp", shell: "/bin/bash", shellArgs: [], env: {} });
    const output = vi.fn();
    backend.attach(id, { output, exit: vi.fn() });

    const encoder = new TextEncoder();
    const bytes = encoder.encode("ññ");
    // Split inside the first multi-byte sequence: the first chunk ends mid-character.
    harness.dataCb?.(undefined, bytes.slice(0, 1));
    harness.dataCb?.(undefined, bytes.slice(1));

    expect(output).toHaveBeenCalledWith("ññ");
    backend.dispose();
  });

  it("delivers the subprocess exit code through the attached exit handler and releases the entry", () => {
    const harness = installFakeBun();
    const backend = new BunPTYBackend();
    const { id } = backend.create({ cwd: "/tmp", shell: "/bin/bash", shellArgs: [], env: {} });
    const exit = vi.fn();
    backend.attach(id, { output: vi.fn(), exit });

    harness.spawnExitCb?.(undefined, 3, null);

    expect(exit).toHaveBeenCalledWith(3);
    // Released: later writes are no-ops and a re-attach finds no entry.
    backend.write(id, "ignored");
    expect(harness.terminal.write).not.toHaveBeenCalled();
    const detached = vi.fn();
    backend.attach(id, { output: detached, exit: vi.fn() });
    expect(detached).not.toHaveBeenCalled();
    backend.dispose();
  });

  it("write and resize delegate to the Bun terminal", () => {
    const harness = installFakeBun();
    const backend = new BunPTYBackend();
    const { id } = backend.create({ cwd: "/tmp", shell: "/bin/bash", shellArgs: [], env: {} });

    backend.write(id, "ls\n");
    backend.resize(id, 120, 40);
    backend.write("missing-id", "ignored");
    backend.resize("missing-id", 10, 10);

    expect(harness.terminal.write).toHaveBeenCalledWith("ls\n");
    expect(harness.terminal.resize).toHaveBeenCalledWith(120, 40);
    expect(harness.terminal.resize).toHaveBeenCalledTimes(1);
    backend.dispose();
  });

  it("kill terminates the subprocess and closes the terminal, idempotently", () => {
    const harness = installFakeBun();
    const kill = vi.fn();
    harness.spawn.mockImplementation((_cmd: unknown, opts: { onExit?: (sub: unknown, code: number | null) => void }) => {
      harness.spawnExitCb = opts.onExit;
      return { kill, onExit: vi.fn() };
    });
    const backend = new BunPTYBackend();
    const { id } = backend.create({ cwd: "/tmp", shell: "/bin/bash", shellArgs: [], env: {} });

    backend.kill(id);
    backend.kill(id);

    expect(kill).toHaveBeenCalledWith("SIGKILL");
    expect(harness.terminal.close).toHaveBeenCalledTimes(1);
    backend.dispose();
  });

  it("dispose kills and closes every live terminal once", () => {
    const harness = installFakeBun();
    const kill = vi.fn();
    harness.spawn.mockImplementation(() => ({ kill, onExit: vi.fn() }));
    const backend = new BunPTYBackend();
    const first = backend.create({ cwd: "/tmp", shell: "/bin/bash", shellArgs: [], env: {} });
    const second = backend.create({ cwd: "/tmp", shell: "/bin/bash", shellArgs: [], env: {} });

    backend.dispose();
    const closeCallsAfterDispose = harness.terminal.close.mock.calls.length;

    backend.dispose();
    backend.write(first.id, "ignored");
    backend.kill(second.id);

    expect(kill).toHaveBeenCalledTimes(2);
    expect(harness.terminal.close).toHaveBeenCalledTimes(closeCallsAfterDispose);
  });
});

/* ------------------------------------------------------------------ */
/*  NodePTYBackend                                                     */
/* ------------------------------------------------------------------ */

describe("NodePTYBackend", () => {
  function fakeNodePtyModule() {
    const processHandle = {
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      onData: vi.fn(),
      onExit: vi.fn(),
    };
    const spawn = vi.fn(() => processHandle);
    return { module: { spawn }, processHandle, spawn };
  }

  it("uses the injected node-pty module and wires output and exit", () => {
    const { module, processHandle } = fakeNodePtyModule();
    const backend = new NodePTYBackend(module);
    expect(backend.available()).toBe(true);

    const { id } = backend.create({
      cwd: "/tmp",
      shell: "/bin/bash",
      shellArgs: ["-l"],
      cols: 80,
      rows: 24,
      env: { TERM: "xterm-256color", PI_WEB_TERMINAL: "1" },
    });
    expect(processHandle.onData).toHaveBeenCalledTimes(1);
    expect(processHandle.onExit).toHaveBeenCalledTimes(1);
    expect(module.spawn).toHaveBeenCalledWith(
      "/bin/bash",
      ["-l"],
      expect.objectContaining({ cwd: "/tmp", cols: 80, rows: 24, env: { TERM: "xterm-256color", PI_WEB_TERMINAL: "1" } }),
    );

    const output = vi.fn();
    const exit = vi.fn();
    backend.attach(id, { output, exit });
    const onData = processHandle.onData.mock.calls[0]?.[0] as (data: string) => void;
    const onExit = processHandle.onExit.mock.calls[0]?.[0] as (event: { exitCode: number }) => void;
    onData("out\n");
    expect(output).toHaveBeenCalledWith("out\n");
    onExit({ exitCode: 0 });
    expect(exit).toHaveBeenCalledWith(0);
    backend.dispose();
  });

  it("delegates write, resize, and kill to the node-pty process", () => {
    const { module, processHandle } = fakeNodePtyModule();
    const backend = new NodePTYBackend(module);
    const { id } = backend.create({ cwd: "/tmp", shell: "/bin/bash", shellArgs: [], env: {} });

    backend.write(id, "ls\n");
    backend.resize(id, 120, 40);
    backend.write("missing-id", "ignored");
    backend.kill(id);

    expect(processHandle.write).toHaveBeenCalledTimes(1);
    expect(processHandle.resize).toHaveBeenCalledWith(120, 40);
    expect(processHandle.kill).toHaveBeenCalledWith("SIGKILL");
    // Idempotent: the second kill finds no entry.
    backend.kill(id);
    expect(processHandle.kill).toHaveBeenCalledTimes(1);
    backend.dispose();
  });

  it("reports unavailable and throws a recovery action when the binding is missing", () => {
    const backend = new NodePTYBackend(undefined, () => {
      throw new Error("Cannot find package 'node-pty'");
    });
    expect(backend.available()).toBe(false);
    expect(() =>
      backend.create({ cwd: "/tmp", shell: "/bin/bash", shellArgs: [], env: {} }),
    ).toThrow(/node-pty/);
  });

  it("dispose kills every live process once", () => {
    const { module, processHandle } = fakeNodePtyModule();
    const backend = new NodePTYBackend(module);
    backend.create({ cwd: "/tmp", shell: "/bin/bash", shellArgs: [], env: {} });
    backend.create({ cwd: "/tmp", shell: "/bin/bash", shellArgs: [], env: {} });

    backend.dispose();
    backend.dispose();
    backend.write("any", "ignored");

    expect(processHandle.kill).toHaveBeenCalledTimes(2);
  });
});
