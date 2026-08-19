import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  NodeSafeTunnelFrpcProcessLauncher,
  type SafeTunnelFrpcProcessExit,
  type SafeTunnelNodeChildProcess,
  type SafeTunnelNodeProcessSpawner,
} from "./safeTunnelFrpcProcess.js";

class FakeNodeChild extends EventEmitter implements SafeTunnelNodeChildProcess {
  readonly signals: NodeJS.Signals[] = [];

  constructor(private readonly pid: number | null = 4242) {
    super();
  }

  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    return true;
  }

  offClose(
    listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void,
  ): void {
    this.off("close", listener);
  }

  offError(listener: (error: Error) => void): void {
    this.off("error", listener);
  }

  offSpawn(listener: () => void): void {
    this.off("spawn", listener);
  }

  onceClose(
    listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void,
  ): void {
    this.once("close", listener);
  }

  onceSpawn(listener: () => void): void {
    this.once("spawn", listener);
  }

  onError(listener: (error: Error) => void): void {
    this.on("error", listener);
  }

  processId(): number | undefined {
    return this.pid ?? undefined;
  }

  close(exitCode: number | null, signal: NodeJS.Signals | null): void {
    this.emit("close", exitCode, signal);
  }

  fail(error: Error): void {
    this.emit("error", error);
  }

  acknowledgeSpawn(): void {
    this.emit("spawn");
  }
}

describe("NodeSafeTunnelFrpcProcessLauncher", () => {
  it("launches without ambient environment or output and owns the exact returned child", async () => {
    const child = new FakeNodeChild();
    const calls: Parameters<SafeTunnelNodeProcessSpawner>[] = [];
    const launcher = new NodeSafeTunnelFrpcProcessLauncher({
      spawnProcess(command, args, options) {
        calls.push([command, args, options]);
        return child;
      },
    });
    const exits: SafeTunnelFrpcProcessExit[] = [];

    const handle = launcher.launch({
      configPath: "/data/pi-web/safe-tunnel/frpc.toml",
      frpcPath: "/data/pi-web/safe-tunnel/frpc/versions/0.69.1/frpc",
    }, {
      onExit: (exit) => { exits.push(exit); },
    });

    expect(calls).toEqual([[
      "/data/pi-web/safe-tunnel/frpc/versions/0.69.1/frpc",
      ["-c", "/data/pi-web/safe-tunnel/frpc.toml"],
      {
        cwd: "/data/pi-web/safe-tunnel",
        detached: false,
        env: {},
        shell: false,
        stdio: ["ignore", "ignore", "ignore"],
        windowsHide: true,
      },
    ]]);
    child.acknowledgeSpawn();
    await expect(handle.started).resolves.toBeUndefined();
    expect(handle.pid).toBe(4242);
    expect(handle.terminate("SIGTERM")).toBe(true);
    expect(child.signals).toEqual(["SIGTERM"]);

    child.close(null, "SIGTERM");
    child.close(1, null);

    expect(exits).toEqual([{ exitCode: null, kind: "exited", signal: "SIGTERM" }]);
    expect(child.listenerCount("close")).toBe(0);
    expect(child.listenerCount("error")).toBe(0);
  });

  it("rejects start on a pre-spawn error but retains exit ownership until close", async () => {
    const child = new FakeNodeChild(null);
    const launcher = new NodeSafeTunnelFrpcProcessLauncher({
      spawnProcess: () => child,
    });
    const exits: SafeTunnelFrpcProcessExit[] = [];
    const handle = launcher.launch({
      configPath: "/tmp/frpc.toml",
      frpcPath: "/opt/frpc",
    }, {
      onExit: (exit) => { exits.push(exit); },
    });

    child.fail(new Error("spawn failed"));
    expect(handle.pid).toBeUndefined();
    await expect(handle.started).rejects.toThrow("The frpc process did not start.");
    expect(exits).toEqual([]);

    child.close(1, null);
    expect(exits).toEqual([{ kind: "error" }]);
    expect(child.listenerCount("close")).toBe(0);
    expect(child.listenerCount("error")).toBe(0);
  });

  it("rejects start when the child closes before spawn acknowledgement", async () => {
    const child = new FakeNodeChild(null);
    const launcher = new NodeSafeTunnelFrpcProcessLauncher({
      spawnProcess: () => child,
    });
    const exits: SafeTunnelFrpcProcessExit[] = [];
    const handle = launcher.launch({
      configPath: "/tmp/frpc.toml",
      frpcPath: "/opt/frpc",
    }, {
      onExit: (exit) => { exits.push(exit); },
    });

    child.close(1, null);

    await expect(handle.started).rejects.toThrow("The frpc process did not start.");
    expect(exits).toEqual([{ kind: "error" }]);
  });

  it("rejects start for an ordinary missing executable", async () => {
    const launcher = new NodeSafeTunnelFrpcProcessLauncher();
    let resolveExit: (exit: SafeTunnelFrpcProcessExit) => void = () => undefined;
    const exited = new Promise<SafeTunnelFrpcProcessExit>((resolve) => {
      resolveExit = resolve;
    });
    const handle = launcher.launch({
      configPath: join(tmpdir(), "pi-web-safe-tunnel-frpc.toml"),
      frpcPath: join(tmpdir(), `missing-pi-web-frpc-${randomUUID()}`),
    }, {
      onExit: resolveExit,
    });

    await expect(handle.started).rejects.toThrow("The frpc process did not start.");
    await expect(exited).resolves.toEqual({ kind: "error" });
  });

  it("detaches its listeners without signaling the child", async () => {
    const child = new FakeNodeChild();
    const launcher = new NodeSafeTunnelFrpcProcessLauncher({
      spawnProcess: () => child,
    });
    const exits: SafeTunnelFrpcProcessExit[] = [];
    const handle = launcher.launch({
      configPath: "/tmp/frpc.toml",
      frpcPath: "/opt/frpc",
    }, {
      onExit: (exit) => { exits.push(exit); },
    });

    child.acknowledgeSpawn();
    await handle.started;
    handle.dispose();
    handle.dispose();
    child.close(0, null);

    expect(exits).toEqual([]);
    expect(child.signals).toEqual([]);
    expect(child.listenerCount("close")).toBe(0);
    expect(child.listenerCount("error")).toBe(0);
    expect(child.listenerCount("spawn")).toBe(0);
  });

  it.each([
    ["configPath", { configPath: "  ", frpcPath: "/opt/frpc" }],
    ["frpcPath", { configPath: "/tmp/frpc.toml", frpcPath: "" }],
  ] as const)("rejects an empty %s before spawning", (fieldName, request) => {
    let spawnCalls = 0;
    const launcher = new NodeSafeTunnelFrpcProcessLauncher({
      spawnProcess: () => {
        spawnCalls += 1;
        return new FakeNodeChild();
      },
    });

    expect(() => launcher.launch(request, { onExit: () => undefined }))
      .toThrow(`${fieldName} must be a non-empty path.`);
    expect(spawnCalls).toBe(0);
  });

  it.each([
    ["configPath", { configPath: "relative/frpc.toml", frpcPath: "/opt/frpc" }],
    ["frpcPath", { configPath: "/tmp/frpc.toml", frpcPath: "frpc" }],
  ] as const)("rejects a relative %s before spawning", (fieldName, request) => {
    let spawnCalls = 0;
    const launcher = new NodeSafeTunnelFrpcProcessLauncher({
      spawnProcess: () => {
        spawnCalls += 1;
        return new FakeNodeChild();
      },
    });

    expect(() => launcher.launch(request, { onExit: () => undefined }))
      .toThrow(`${fieldName} must be an absolute path.`);
    expect(spawnCalls).toBe(0);
  });
});
