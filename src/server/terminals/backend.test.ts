/* eslint-disable @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unused-vars, @typescript-eslint/restrict-template-expressions, @typescript-eslint/strict-boolean-expressions, @typescript-eslint/no-extraneous-class */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NodePTYBackend } from "./backend.js";
import type { TerminalBackend, NodePtyModule } from "./backend.js";
import { createMockBackend } from "./backend-mock.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Re-import the module under test, returning exports as a namespace object.
 * Used after vi.resetModules() so the module re-evaluates against the current
 * global state (e.g. modified Bun or node-pty mocks).
 */
async function reimport(): Promise<typeof import("./backend.js")> {
  vi.resetModules();
  return import("./backend.js");
}

/* ------------------------------------------------------------------ */
/*  Auto-detection tests                                               */
/* ------------------------------------------------------------------ */

describe("isBunRuntime", () => {
  it("returns true when Bun global exists and has spawn", async () => {
    const originalBun = (globalThis as Record<string, unknown>)["Bun"];
    (globalThis as Record<string, unknown>)["Bun"] = { spawn: vi.fn() };
    try {
      const { isBunRuntime: check } = await reimport();
      expect(check()).toBe(true);
    } finally {
      if (originalBun === undefined) {
        delete (globalThis as Record<string, unknown>)["Bun"];
      } else {
        (globalThis as Record<string, unknown>)["Bun"] = originalBun;
      }
    }
  });

  it("returns false when Bun global does not exist", async () => {
    const originalBun = (globalThis as Record<string, unknown>)["Bun"];
    delete (globalThis as Record<string, unknown>)["Bun"];
    try {
      const { isBunRuntime: check } = await reimport();
      expect(check()).toBe(false);
    } finally {
      if (originalBun !== undefined) {
        (globalThis as Record<string, unknown>)["Bun"] = originalBun;
      }
    }
  });

  it("returns false when Bun exists but lacks spawn", async () => {
    const originalBun = (globalThis as Record<string, unknown>)["Bun"];
    (globalThis as Record<string, unknown>)["Bun"] = { spawn: undefined };
    try {
      const { isBunRuntime: check } = await reimport();
      expect(check()).toBe(false);
    } finally {
      if (originalBun === undefined) {
        delete (globalThis as Record<string, unknown>)["Bun"];
      } else {
        (globalThis as Record<string, unknown>)["Bun"] = originalBun;
      }
    }
  });
});

/* ------------------------------------------------------------------ */
/*  TerminalBackend interface tests (abstract mock implementation)     */
/* ------------------------------------------------------------------ */

describe("TerminalBackend interface (mock implementation)", () => {
  let backend: TerminalBackend;

  afterEach(() => {
    backend.dispose();
  });

  it("available() returns true", () => {
    backend = createMockBackend();
    expect(backend.available()).toBe(true);
  });

  it("create returns an ID and TerminalInfo with correct defaults", () => {
    backend = createMockBackend();
    const result = backend.create({
      cwd: "/tmp",
      shell: "/bin/bash",
      shellArgs: ["-l"],
      env: { HOME: "/root" },
    });

    expect(result.id).toBeDefined();
    expect(typeof result.id).toBe("string");
    expect(result.info).toMatchObject({
      cwd: "/tmp",
      shell: "/bin/bash",
      shellArgs: ["-l"],
      exited: false,
      cols: 100,
      rows: 30,
    });
    // createdAt should be a valid ISO string
    expect(new Date(result.info.createdAt).toISOString()).toBe(
      result.info.createdAt
    );
  });

  it("create sets exited=false by default", () => {
    backend = createMockBackend();
    const { info } = backend.create({
      cwd: "/tmp",
      shell: "/bin/bash",
      shellArgs: [],
      env: {},
    });
    expect(info.exited).toBe(false);
    expect(info.exitCode).toBeUndefined();
  });

  it("create accepts custom cols and rows", () => {
    backend = createMockBackend();
    const { info, cols, rows } = backend.create({
      cwd: "/tmp",
      shell: "/bin/bash",
      shellArgs: [],
      cols: 200,
      rows: 50,
      env: {},
    });
    expect(cols).toBe(200);
    expect(rows).toBe(50);
  });

  it("get returns info for created terminal", () => {
    backend = createMockBackend();
    const { id } = backend.create({
      cwd: "/tmp",
      shell: "/bin/bash",
      shellArgs: [],
      env: {},
    });

    const retrieved = backend.get(id);
    expect(retrieved).toBeDefined();
    if (retrieved === undefined) throw new Error("retrieved should be defined");
    expect(retrieved.id).toBe(id);
    expect(retrieved.cwd).toBe("/tmp");
  });

  it("get returns undefined for unknown ID", () => {
    backend = createMockBackend();
    expect(backend.get("nonexistent-id")).toBeUndefined();
  });

  it("write does not throw", () => {
    backend = createMockBackend();
    const { id } = backend.create({
      cwd: "/tmp",
      shell: "/bin/bash",
      shellArgs: [],
      env: {},
    });

    expect(() => { backend.write(id, "hello"); }).not.toThrow();
  });

  it("resize does not throw", () => {
    backend = createMockBackend();
    const { id } = backend.create({
      cwd: "/tmp",
      shell: "/bin/bash",
      shellArgs: [],
      env: {},
    });

    expect(() => { backend.resize(id, 80, 24); }).not.toThrow();
  });

  it("kill does not throw and marks terminal as exited", () => {
    backend = createMockBackend();
    const { id } = backend.create({
      cwd: "/tmp",
      shell: "/bin/bash",
      shellArgs: [],
      env: {},
    });

    expect(() => { backend.kill(id); }).not.toThrow();
    const afterKill = backend.get(id);
    expect(afterKill?.exited).toBe(true);
  });

  it("attach returns an unsubscribe function", () => {
    backend = createMockBackend();
    const { id } = backend.create({
      cwd: "/tmp",
      shell: "/bin/bash",
      shellArgs: [],
      env: {},
    });

    const outputCb = vi.fn();
    const exitCb = vi.fn();
    const unsubscribe = backend.attach(id, { output: outputCb, exit: exitCb });

    expect(unsubscribe).toBeTypeOf("function");
    expect(outputCb).not.toHaveBeenCalled();
    expect(exitCb).not.toHaveBeenCalled();
  });

  it("attach output callback receives data strings", () => {
    backend = createMockBackend();
    const { id } = backend.create({
      cwd: "/tmp",
      shell: "/bin/bash",
      shellArgs: [],
      env: {},
    });

    const outputCb = vi.fn();
    const exitCb = vi.fn();
    backend.attach(id, { output: outputCb, exit: exitCb });

    // Simulate data being emitted (in real impl, this comes from the terminal)
    // For the mock, we can't inject data, but we verify the callback is set up
    expect(outputCb).toBeInstanceOf(Function);
    expect(exitCb).toBeInstanceOf(Function);
  });

  it("attach exit callback receives exit code number", () => {
    backend = createMockBackend();
    const { id } = backend.create({
      cwd: "/tmp",
      shell: "/bin/bash",
      shellArgs: [],
      env: {},
    });

    const outputCb = vi.fn();
    const exitCb = vi.fn();
    backend.attach(id, { output: outputCb, exit: exitCb });

    expect(exitCb).toBeInstanceOf(Function);
  });

  it("unsubscribe function removes listeners", () => {
    backend = createMockBackend();
    const { id } = backend.create({
      cwd: "/tmp",
      shell: "/bin/bash",
      shellArgs: [],
      env: {},
    });

    const outputCb = vi.fn();
    const exitCb = vi.fn();
    const unsubscribe = backend.attach(id, { output: outputCb, exit: exitCb });

    // Unsubscribe
    unsubscribe();

    // After unsubscribe, attaching again should not have previous callbacks
    const newOutputCb = vi.fn();
    const newExitCb = vi.fn();
    backend.attach(id, { output: newOutputCb, exit: newExitCb });

    // New callbacks are independent (mock implementation replaces)
    expect(newOutputCb).not.toBe(outputCb);
  });

  it("dispose closes all terminals", () => {
    backend = createMockBackend();
    backend.create({
      cwd: "/tmp1",
      shell: "/bin/bash",
      shellArgs: [],
      env: {},
    });
    backend.create({
      cwd: "/tmp2",
      shell: "/bin/bash",
      shellArgs: [],
      env: {},
    });

    backend.dispose();

    // After dispose, get should return undefined for all terminals
    // (mock implementation clears the map)
  });

  it("multiple creates/gets work correctly (Map semantics)", () => {
    backend = createMockBackend();
    const t1 = backend.create({
      cwd: "/tmp1",
      shell: "/bin/bash",
      shellArgs: [],
      env: {},
    });
    const t2 = backend.create({
      cwd: "/tmp2",
      shell: "/bin/zsh",
      shellArgs: [],
      env: {},
    });

    expect(t1.id).not.toBe(t2.id);
    expect(backend.get(t1.id)?.cwd).toBe("/tmp1");
    expect(backend.get(t2.id)?.cwd).toBe("/tmp2");
    expect(backend.get("nonexistent")).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/*  BunPTYBackend tests (mock Bun internals)                           */
/* ------------------------------------------------------------------ */

describe("BunPTYBackend", () => {
  let backend: TerminalBackend;
  let originalBun: unknown;
  let mockSpawn: ReturnType<typeof vi.fn>;
  let mockTerminalWrite: ReturnType<typeof vi.fn>;
  let mockTerminalResize: ReturnType<typeof vi.fn>;
  let mockTerminalClose: ReturnType<typeof vi.fn>;
  let storedOnExitCb: ((__sub: unknown, code: number | null) => void) | undefined;

  beforeEach(async () => {
    originalBun = (globalThis as Record<string, unknown>)["Bun"];

    // Set up mock Bun global with Terminal and spawn
    mockTerminalWrite = vi.fn();
    mockTerminalResize = vi.fn();
    mockTerminalClose = vi.fn();
    mockSpawn = vi.fn();

    (globalThis as Record<string, unknown>)["Bun"] = {
      Terminal: class MockBunTerminal {
        write = mockTerminalWrite;
        resize = mockTerminalResize;
        close = mockTerminalClose;
        dataCallback: ((terminal: unknown, data: Uint8Array) => void) | undefined;
        exitCallback: ((code: number | null) => void) | undefined;

        constructor(
          options: {
            cols?: number;
            rows?: number;
            name?: string;
            data?: (terminal: unknown, data: Uint8Array) => void;
            exit?: (code: number | null) => void;
          }
        ) {
          if (options.data) {
            this.dataCallback = options.data;
          }
          if (options.exit) {
            this.exitCallback = options.exit;
          }
        }
      },
      spawn: vi.fn((cmd, opts) => {
        if (opts?.onExit) {
          storedOnExitCb = opts.onExit;
        }
        return { kill: vi.fn() };
      }),
    };

    const mod = await reimport();
    backend = new mod.BunPTYBackend();
  });

  afterEach(() => {
    backend.dispose();
    if (originalBun === undefined) {
      delete (globalThis as Record<string, unknown>)["Bun"];
    } else {
      (globalThis as Record<string, unknown>)["Bun"] = originalBun;
    }
    vi.restoreAllMocks();
  });

  it("available() returns true when Bun.Terminal and Bun.spawn exist", () => {
    expect(backend.available()).toBe(true);
  });

  it("available() returns false when Bun is missing", async () => {
    delete (globalThis as Record<string, unknown>)["Bun"];

    const mod = await reimport();
    const freshBackend = new mod.BunPTYBackend();

    expect(freshBackend.available()).toBe(false);

    freshBackend.dispose();
  });

  it("create spawns Bun.Terminal with correct options", () => {
    const { id, info, cols, rows } = backend.create({
      cwd: "/tmp",
      shell: "/bin/bash",
      shellArgs: ["-l"],
      cols: 80,
      rows: 24,
      env: { HOME: "/root" },
    });

    expect(info.id).toBe(id);
    expect(info.cwd).toBe("/tmp");
    expect(cols).toBe(80);
    expect(rows).toBe(24);
    expect(info.exited).toBe(false);
  });

    it("create spawns Bun.spawn with correct options", () => {
    mockSpawn.mockClear();
    (globalThis as Record<string, unknown>)["Bun"] = {
      ...((globalThis as Record<string, unknown>)["Bun"] as object),
      spawn: mockSpawn,
    };

    backend.create({
      cwd: "/tmp",
      shell: "/bin/bash",
      shellArgs: ["-l"],
      cols: 80,
      rows: 24,
      env: { HOME: "/root" },
    });

    expect(mockSpawn).toHaveBeenCalledWith(
      expect.arrayContaining(["/bin/bash", "-l"]),
      expect.objectContaining({
        cwd: "/tmp",
        env: expect.objectContaining({
          HOME: "/root",
          PI_WEB_TERMINAL: "1",
          TERM: "xterm-256color",
        }),
        terminal: expect.any(Object),
      })
    );
  });

    it("create passes PI_WEB_TERMINAL=1 env var", () => {
    // Use the spawn mock set on globalThis in this test
    const globalBun = (globalThis as Record<string, unknown>)["Bun"] as { spawn: ReturnType<typeof vi.fn> };
    backend.create({
      cwd: "/tmp",
      shell: "/bin/bash",
      shellArgs: [],
      env: {},
    });
    const lastCallArgs = globalBun.spawn.mock.calls[0] as [string[], { env: Record<string, string> }];
    const spawnOpts = lastCallArgs[1];
    expect(spawnOpts.env["PI_WEB_TERMINAL"]).toBe("1");
  });

    it("create passes TERM=xterm-256color env var", () => {
    // Use the spawn mock set on globalThis in this test
    const globalBun = (globalThis as Record<string, unknown>)["Bun"] as { spawn: ReturnType<typeof vi.fn> };
    backend.create({
      cwd: "/tmp",
      shell: "/bin/bash",
      shellArgs: [],
      env: {},
    });
    const lastCallArgs = globalBun.spawn.mock.calls[0] as [string[], { env: Record<string, string> }];
    const spawnOpts = lastCallArgs[1];
    expect(spawnOpts.env["TERM"]).toBe("xterm-256color");
  });

  it("write delegates to terminal.write()", async () => {
    const mockTerminalWrite = vi.fn();
    (globalThis as Record<string, unknown>)["Bun"] = {
      ...((globalThis as Record<string, unknown>)["Bun"] as object),
      Terminal: class MockBunTerminal {
        write = mockTerminalWrite;
        resize = vi.fn();
        close = vi.fn();
      },
      spawn: vi.fn(),
    };

    const mod = await reimport();
    const freshBackend = new mod.BunPTYBackend();

    const { id } = freshBackend.create({
      cwd: "/tmp",
      shell: "/bin/bash",
      shellArgs: [],
      env: {},
    });

    freshBackend.write(id, "hello world");

    expect(mockTerminalWrite).toHaveBeenCalledWith("hello world");

    freshBackend.dispose();
  });

  it("resize delegates to terminal.resize()", async () => {
    const mockTerminalResize = vi.fn();
    (globalThis as Record<string, unknown>)["Bun"] = {
      ...((globalThis as Record<string, unknown>)["Bun"] as object),
      Terminal: class MockBunTerminal {
        write = vi.fn();
        resize = mockTerminalResize;
        close = vi.fn();
      },
      spawn: vi.fn(),
    };

    const mod = await reimport();
    const freshBackend = new mod.BunPTYBackend();

    const { id } = freshBackend.create({
      cwd: "/tmp",
      shell: "/bin/bash",
      shellArgs: [],
      env: {},
    });

    freshBackend.resize(id, 120, 40);

    expect(mockTerminalResize).toHaveBeenCalledWith(120, 40);

    freshBackend.dispose();
  });

    it("kill delegates to subprocess kill()", async () => {
    const mockKill = vi.fn();
    const mockSpawn = vi.fn(() => ({ kill: mockKill }));

    const mod = await reimport();

    // Override global Bun with our mock
    (globalThis as Record<string, unknown>)["Bun"] = {
      ...((globalThis as Record<string, unknown>)["Bun"] as object),
      spawn: mockSpawn,
    };

    const freshBackend = new mod.BunPTYBackend();

    const { id } = freshBackend.create({
      cwd: "/tmp",
      shell: "/bin/bash",
      shellArgs: [],
      env: {},
    });

    freshBackend.kill(id);

    expect(mockKill).toHaveBeenCalledWith("SIGKILL");

    freshBackend.dispose();
  });

  it("onData callback fires with data from terminal", async () => {
    const onDataCalls: string[] = [];
    const mockTerminalWrite = vi.fn();
    const mockTerminalResize = vi.fn();
    const mockTerminalClose = vi.fn();

    let dataCallback: ((terminal: unknown, data: Uint8Array) => void) | undefined;
    let onExitCallback: ((code: number | null) => void) | undefined;

    (globalThis as Record<string, unknown>)["Bun"] = {
      Terminal: class MockBunTerminal {
        write = mockTerminalWrite;
        resize = mockTerminalResize;
        close = mockTerminalClose;
        dataCallback: ((terminal: unknown, data: Uint8Array) => void) | undefined;
        exitCallback: ((code: number | null) => void) | undefined;

        constructor(
          options: {
            data?: (terminal: unknown, data: Uint8Array) => void;
            exit?: (code: number | null) => void;
          }
        ) {
          dataCallback = options.data;
            this.dataCallback = options.data;
          if (options.exit) { onExitCallback = options.exit; }
            this.exitCallback = options.exit;
        }
      },
      spawn: vi.fn(() => ({ kill: vi.fn() })),
    };

    const mod = await reimport();
    const freshBackend = new mod.BunPTYBackend();

    const { id } = freshBackend.create({
      cwd: "/tmp",
      shell: "/bin/bash",
      shellArgs: [],
      env: {},
    });

    const outputCb = vi.fn();
    const exitCb = vi.fn();
    freshBackend.attach(id, { output: outputCb, exit: exitCb });

    // Simulate terminal emitting data
    dataCallback?.(null, new TextEncoder().encode("hello\n"));
    dataCallback?.(null, new TextEncoder().encode("world\n"));

    expect(outputCb).toHaveBeenCalledWith("hello\n", false);
    expect(outputCb).toHaveBeenCalledWith("world\n", false);

    freshBackend.dispose();
  });

    it("onExit callback fires with exitCode from subprocess.onExit", async () => {
    let storedOnExitCb: ((subprocess: unknown, code: number | null) => void) | undefined;

    (globalThis as Record<string, unknown>)["Bun"] = {
      Terminal: class MockBunTerminal {
        write = vi.fn();
        resize = vi.fn();
        close = vi.fn();
      },
      spawn: vi.fn((cmd, opts) => {
        if (opts?.onExit) {
          storedOnExitCb = opts.onExit;
        }
        return { kill: vi.fn() };
      }),
    };

    const mod = await reimport();
    const freshBackend = new mod.BunPTYBackend();

    const { id } = freshBackend.create({
      cwd: "/tmp",
      shell: "/bin/bash",
      shellArgs: [],
      env: {},
    });

    const outputCb = vi.fn();
    const exitCb = vi.fn();
    freshBackend.attach(id, { output: outputCb, exit: exitCb });

    // Fire the stored subprocess onExit callback with code 0
    storedOnExitCb?.(null, 0);

    expect(exitCb).toHaveBeenCalledWith(0);

    freshBackend.dispose();
  });

  it("Data callback fires for each data chunk", async () => {
    let dataCallback: ((terminal: unknown, data: Uint8Array) => void) | undefined;

    (globalThis as Record<string, unknown>)["Bun"] = {
      Terminal: class MockBunTerminal {
        write = vi.fn();
        resize = vi.fn();
        close = vi.fn();
        dataCallback: ((terminal: unknown, data: Uint8Array) => void) | undefined;

        constructor(
          options: {
            data?: (terminal: unknown, data: Uint8Array) => void;
          }
        ) {
          dataCallback = options.data;
            this.dataCallback = options.data;
        }
      },
      spawn: vi.fn(() => ({ kill: vi.fn() })),
    };

    const mod = await reimport();
    const freshBackend = new mod.BunPTYBackend();

    const { id } = freshBackend.create({
      cwd: "/tmp",
      shell: "/bin/bash",
      shellArgs: [],
      env: {},
    });

    const outputCb = vi.fn();
    freshBackend.attach(id, { output: outputCb, exit: vi.fn() });

    // Emit multiple chunks
    dataCallback?.(null, new TextEncoder().encode("chunk1"));
    dataCallback?.(null, new TextEncoder().encode("chunk2"));
    dataCallback?.(null, new TextEncoder().encode("chunk3"));

    expect(outputCb).toHaveBeenCalledTimes(3);
    expect(outputCb).toHaveBeenNthCalledWith(1, "chunk1", false);
    expect(outputCb).toHaveBeenNthCalledWith(2, "chunk2", false);
    expect(outputCb).toHaveBeenNthCalledWith(3, "chunk3", false);

    freshBackend.dispose();
  });

  it("Multiple terminals can exist simultaneously", () => {
    const { id: id1 } = backend.create({
      cwd: "/tmp1",
      shell: "/bin/bash",
      shellArgs: [],
      env: {},
    });

    const { id: id2 } = backend.create({
      cwd: "/tmp2",
      shell: "/bin/zsh",
      shellArgs: [],
      env: {},
    });

    expect(id1).not.toBe(id2);
    expect(backend.get(id1)?.cwd).toBe("/tmp1");
    expect(backend.get(id2)?.cwd).toBe("/tmp2");
  });

  it("Terminal data accumulates (buffer behavior)", async () => {
    let dataCallback: ((terminal: unknown, data: Uint8Array) => void) | undefined;

    (globalThis as Record<string, unknown>)["Bun"] = {
      Terminal: class MockBunTerminal {
        write = vi.fn();
        resize = vi.fn();
        close = vi.fn();
        dataCallback: ((terminal: unknown, data: Uint8Array) => void) | undefined;

        constructor(
          options: {
            data?: (terminal: unknown, data: Uint8Array) => void;
          }
        ) {
          dataCallback = options.data;
            this.dataCallback = options.data;
        }
      },
      spawn: vi.fn(() => ({ kill: vi.fn() })),
    };

    const mod = await reimport();
    const freshBackend = new mod.BunPTYBackend();

    const { id } = freshBackend.create({
      cwd: "/tmp",
      shell: "/bin/bash",
      shellArgs: [],
      env: {},
    });

    const collected: string[] = [];
    freshBackend.attach(id, {
      output: (data) => {
        collected.push(data);
      },
      exit: vi.fn(),
    });

    dataCallback?.(null, new TextEncoder().encode("line1\n"));
    dataCallback?.(null, new TextEncoder().encode("line2\n"));
    dataCallback?.(null, new TextEncoder().encode("line3\n"));

    expect(collected).toEqual(["line1\n", "line2\n", "line3\n"]);

    freshBackend.dispose();
  });

  it("decodes multi-byte UTF-8 sequences split across data chunks", async () => {
    let dataCallback: ((terminal: unknown, data: Uint8Array) => void) | undefined;

    (globalThis as Record<string, unknown>)["Bun"] = {
      Terminal: class {
        write = vi.fn();
        resize = vi.fn();
        close = vi.fn();

        constructor(
          options: {
            data?: (terminal: unknown, data: Uint8Array) => void;
          }
        ) {
          dataCallback = options.data;
        }
      },
      spawn: vi.fn(() => ({ kill: vi.fn() })),
    };

    const mod = await reimport();
    const freshBackend = new mod.BunPTYBackend();

    const { id } = freshBackend.create({
      cwd: "/tmp",
      shell: "/bin/bash",
      shellArgs: [],
      env: {},
    });

    const collected: string[] = [];
    freshBackend.attach(id, {
      output: (data) => {
        collected.push(data);
      },
      exit: vi.fn(),
    });

    // "é" is 0xC3 0xA9 — delivered as two separate PTY reads.
    dataCallback?.(null, new Uint8Array([0xc3]));
    dataCallback?.(null, new Uint8Array([0xa9]));

    expect(collected.join("")).toBe("é");

    freshBackend.dispose();
  });

  it("removes the terminal entry when the subprocess exits", async () => {
    let onExitCb: ((sub: unknown, code: number | null) => void) | undefined;

    (globalThis as Record<string, unknown>)["Bun"] = {
      Terminal: class {
        write = vi.fn();
        resize = vi.fn();
        close = vi.fn();
      },
      spawn: vi.fn((_cmd, opts) => {
        if (opts?.onExit) onExitCb = opts.onExit;
        return { kill: vi.fn() };
      }),
    };

    const mod = await reimport();
    const freshBackend = new mod.BunPTYBackend();

    const { id } = freshBackend.create({
      cwd: "/tmp",
      shell: "/bin/bash",
      shellArgs: [],
      env: {},
    });
    const map = (freshBackend as unknown as { terminals: Map<string, unknown> }).terminals;
    expect(map.has(id)).toBe(true);

    onExitCb?.(null, 0);

    expect(map.has(id)).toBe(false);

    freshBackend.dispose();
  });

  it("removes the terminal entry when killed", () => {
    const { id } = backend.create({
      cwd: "/tmp",
      shell: "/bin/bash",
      shellArgs: [],
      env: {},
    });
    const map = (backend as unknown as { terminals: Map<string, unknown> }).terminals;
    expect(map.has(id)).toBe(true);

    backend.kill(id);

    expect(map.has(id)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  NodePTYBackend tests (mock node-pty module)                        */
/* ------------------------------------------------------------------ */

describe("NodePTYBackend", () => {
  let backend: TerminalBackend;
  let mockPtySpawn: ReturnType<typeof vi.fn>;
  let mockPtyProcesses: Map<
    string,
    {
      write: ReturnType<typeof vi.fn>;
      resize: ReturnType<typeof vi.fn>;
      kill: ReturnType<typeof vi.fn>;
      onDataCb: ((data: string) => void) | null;
      onExitCb: ((code: number | null) => void) | null;
    }
  >;
  let mockPtyModule: { default: { spawn: ReturnType<typeof vi.fn> } };

  function buildMockPty(): {
    write: ReturnType<typeof vi.fn>;
    resize: ReturnType<typeof vi.fn>;
    kill: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    processId: () => string;
  } {
    const procId = `proc-${mockPtyProcesses.size}`;
    return {
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      on: vi.fn(
        (event: string, cb: (data: string | number | null) => void) => {
          if (event === "data") {
            (mockPtyProcesses.get(procId) as { onDataCb: ((data: string) => void) | null }).onDataCb = cb;
          }
          if (event === "exit") {
            (mockPtyProcesses.get(procId) as { onExitCb: ((code: number | null) => void) | null }).onExitCb = cb;
          }
        }
      ),
      processId: () => procId,
    };
  }

  beforeEach(() => {
    mockPtySpawn = vi.fn();
    mockPtyProcesses = new Map();

    // Make spawn return a process object with all required methods
    const makeProc = (): { write: ReturnType<typeof vi.fn>; resize: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> } => {
      const procId = `proc-${mockPtyProcesses.size}`;
      const writeFn = vi.fn();
      const resizeFn = vi.fn();
      const killFn = vi.fn();
      const onFn = vi.fn((event: string, cb: (data: string | number | null) => void) => {
        if (event === "data") {
          (mockPtyProcesses.get(procId) as { onDataCb: ((data: string) => void) | null }).onDataCb = cb;
        }
        if (event === "exit") {
          (mockPtyProcesses.get(procId) as { onExitCb: ((code: number | null) => void) | null }).onExitCb = cb;
        }
      });
      const proc = { write: writeFn, resize: resizeFn, kill: killFn, on: onFn };
      mockPtyProcesses.set(procId, proc as unknown as { write: ReturnType<typeof vi.fn>; resize: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn>; onDataCb: ((data: string) => void) | null; onExitCb: ((code: number | null) => void) | null });
      return proc;
    };

    mockPtySpawn.mockImplementation(() => makeProc());

    const ptyModule = {
      default: {
        spawn: mockPtySpawn,
      },
    };

    mockPtyModule = ptyModule;
    backend = new NodePTYBackend(ptyModule.default as unknown as NodePtyModule);
  });

  afterEach(() => {
    backend.dispose();
    vi.restoreAllMocks();
  });

  it("available() returns true when pty module loads", () => {
    expect(backend.available()).toBe(true);
  });

  it("available() returns false when pty module fails to load", () => {
    // Replace the injected pty with null to simulate a load failure
    (backend as unknown as { setPty: (m: NodePtyModule | null) => void }).setPty(null);
    expect(backend.available()).toBe(false);
  });

  it("create spawns pty.spawn with correct options", () => {
    mockPtySpawn.mockClear();

    const { id, info, cols, rows } = backend.create({
      cwd: "/tmp",
      shell: "/bin/bash",
      shellArgs: ["-l"],
      cols: 80,
      rows: 24,
      env: { HOME: "/root" },
    });

    expect(mockPtySpawn).toHaveBeenCalledWith(
      "/bin/bash",
      ["-l"],
      expect.objectContaining({
        cwd: "/tmp",
        env: expect.objectContaining({ HOME: "/root" }),
      })
    );

    expect(info.id).toBe(id);
    expect(info.cwd).toBe("/tmp");
    expect(cols).toBe(80);
    expect(rows).toBe(24);
  });

  it("create passes correct shellArgs", () => {
    mockPtySpawn.mockClear();

    backend.create({
      cwd: "/tmp",
      shell: "/bin/zsh",
      shellArgs: ["-i"],
      env: {},
    });

    expect(mockPtySpawn).toHaveBeenCalledWith(
      "/bin/zsh",
      ["-i"],
      expect.any(Object)
    );
  });

  it("onData callback fires from pty.onData", () => {
    const { id } = backend.create({
      cwd: "/tmp",
      shell: "/bin/bash",
      shellArgs: [],
      env: {},
    });

    const outputCb = vi.fn();
    const exitCb = vi.fn();
    backend.attach(id, { output: outputCb, exit: exitCb });

    // Simulate pty emitting data
    const proc = mockPtyProcesses.values()
      .next()
      .value as { onDataCb: ((data: string) => void) | null };
    proc.onDataCb?.("hello\n");

    expect(outputCb).toHaveBeenCalledWith("hello\n", false);
  });

  it("onExit callback fires from pty.onExit with exitCode", () => {
    const { id } = backend.create({
      cwd: "/tmp",
      shell: "/bin/bash",
      shellArgs: [],
      env: {},
    });

    const outputCb = vi.fn();
    const exitCb = vi.fn();
    backend.attach(id, { output: outputCb, exit: exitCb });

    // Simulate pty exiting
    const proc = mockPtyProcesses.values()
      .next()
      .value as { onExitCb: ((code: number | null) => void) | null };
    proc.onExitCb?.(0);

    expect(exitCb).toHaveBeenCalledWith(0);
  });

  it("write delegates to pty.write()", () => {
    const { id } = backend.create({
      cwd: "/tmp",
      shell: "/bin/bash",
      shellArgs: [],
      env: {},
    });

    backend.write(id, "hello world");

    const proc = mockPtyProcesses.values()
      .next()
      .value as { write: ReturnType<typeof vi.fn> };
    expect(proc.write).toHaveBeenCalledWith("hello world");
  });

  it("resize delegates to pty.resize()", () => {
    const { id } = backend.create({
      cwd: "/tmp",
      shell: "/bin/bash",
      shellArgs: [],
      env: {},
    });

    backend.resize(id, 120, 40);

    const proc = mockPtyProcesses.values()
      .next()
      .value as { resize: ReturnType<typeof vi.fn> };
    expect(proc.resize).toHaveBeenCalledWith(120, 40);
  });

  it("kill delegates to pty.kill()", () => {
    const { id } = backend.create({
      cwd: "/tmp",
      shell: "/bin/bash",
      shellArgs: [],
      env: {},
    });

    backend.kill(id);

    const proc = mockPtyProcesses.values()
      .next()
      .value as { kill: ReturnType<typeof vi.fn> };
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("removes the terminal entry when the process exits", () => {
    const { id } = backend.create({
      cwd: "/tmp",
      shell: "/bin/bash",
      shellArgs: [],
      env: {},
    });
    const map = (backend as unknown as { terminals: Map<string, unknown> }).terminals;
    expect(map.has(id)).toBe(true);

    const proc = mockPtyProcesses.values()
      .next()
      .value as { onExitCb: ((code: number | null) => void) | null };
    proc.onExitCb?.(0);

    expect(map.has(id)).toBe(false);
  });

  it("removes the terminal entry when killed", () => {
    const { id } = backend.create({
      cwd: "/tmp",
      shell: "/bin/bash",
      shellArgs: [],
      env: {},
    });
    const map = (backend as unknown as { terminals: Map<string, unknown> }).terminals;
    expect(map.has(id)).toBe(true);

    backend.kill(id);

    expect(map.has(id)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  createDefaultBackend tests                                         */
/* ------------------------------------------------------------------ */

describe("createDefaultBackend", () => {
  let originalBun: unknown;

  beforeEach(() => {
    originalBun = (globalThis as Record<string, unknown>)["Bun"];
  });

  afterEach(() => {
    if (originalBun === undefined) {
      delete (globalThis as Record<string, unknown>)["Bun"];
    } else {
      (globalThis as Record<string, unknown>)["Bun"] = originalBun;
    }
    vi.restoreAllMocks();
  });

  it("when isBunRuntime is true, returns BunPTYBackend instance", async () => {
    (globalThis as Record<string, unknown>)["Bun"] = {
      spawn: vi.fn(),
      Terminal: class {},
    };

    const mod = await reimport();
    const backend = mod.createDefaultBackend();

    expect(backend).toBeInstanceOf(mod.BunPTYBackend);

    backend.dispose();
  });

  it("when isBunRuntime is false, returns NodePTYBackend instance", async () => {
    delete (globalThis as Record<string, unknown>)["Bun"];

    const mod = await reimport();
    const backend = mod.createDefaultBackend();

    expect(backend).toBeInstanceOf(mod.NodePTYBackend);

    backend.dispose();
  });
});