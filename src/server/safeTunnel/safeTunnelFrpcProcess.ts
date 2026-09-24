import { spawn } from "node:child_process";
import { dirname, isAbsolute } from "node:path";

export interface SafeTunnelFrpcProcessRequest {
  readonly configPath: string;
  readonly frpcPath: string;
}

/** Terminal notification emitted only after the exact child reports close. */
export type SafeTunnelFrpcProcessExit =
  | {
    readonly exitCode: number | null;
    readonly kind: "exited";
    readonly signal: NodeJS.Signals | null;
  }
  | {
    readonly kind: "error";
  };

export interface SafeTunnelFrpcProcessObserver {
  readonly onExit: (exit: SafeTunnelFrpcProcessExit) => void;
}

/** The exact child returned by a launch. Callers never signal a persisted PID. */
export interface SafeTunnelFrpcProcessHandle {
  readonly pid?: number;
  /** Resolves only after Node confirms that the child was spawned. */
  readonly started: Promise<void>;
  dispose(): void;
  terminate(signal: NodeJS.Signals): boolean;
}

export interface SafeTunnelFrpcProcessLauncher {
  launch(
    request: SafeTunnelFrpcProcessRequest,
    observer: SafeTunnelFrpcProcessObserver,
  ): SafeTunnelFrpcProcessHandle;
}

export interface SafeTunnelNodeChildProcess {
  kill(signal: NodeJS.Signals): boolean;
  offClose(
    listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void,
  ): void;
  offError(listener: (error: Error) => void): void;
  offSpawn(listener: () => void): void;
  onceClose(
    listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void,
  ): void;
  onceSpawn(listener: () => void): void;
  onError(listener: (error: Error) => void): void;
  processId(): number | undefined;
}

export type SafeTunnelNodeProcessSpawner = (
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly detached: false;
    readonly env: NodeJS.ProcessEnv;
    readonly shell: false;
    readonly stdio: ["ignore", "ignore", "ignore"];
    readonly windowsHide: true;
  },
) => SafeTunnelNodeChildProcess;

export interface NodeSafeTunnelFrpcProcessLauncherOptions {
  readonly spawnProcess?: SafeTunnelNodeProcessSpawner;
}

/** Concrete Node adapter that owns only listeners attached to its returned child. */
export class NodeSafeTunnelFrpcProcessLauncher implements SafeTunnelFrpcProcessLauncher {
  private readonly spawnProcess: SafeTunnelNodeProcessSpawner;

  constructor(options: NodeSafeTunnelFrpcProcessLauncherOptions = {}) {
    this.spawnProcess = options.spawnProcess ?? spawnNodeFrpcProcess;
  }

  launch(
    request: SafeTunnelFrpcProcessRequest,
    observer: SafeTunnelFrpcProcessObserver,
  ): SafeTunnelFrpcProcessHandle {
    const configPath = requireAbsolutePath(request.configPath, "configPath");
    const frpcPath = requireAbsolutePath(request.frpcPath, "frpcPath");
    const child = this.spawnProcess(frpcPath, ["-c", configPath], {
      cwd: dirname(configPath),
      detached: false,
      // frpc supports environment-backed Go templates. Never make the web
      // process environment, including service credentials, visible to it.
      env: {},
      shell: false,
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
    });
    const pid = child.processId();
    let disposed = false;
    let settled = false;
    let spawnAcknowledged = false;
    let spawnFailed = false;
    let rejectStarted: (error: Error) => void = () => undefined;
    let resolveStarted = (): void => undefined;
    const started = new Promise<void>((resolve, reject) => {
      rejectStarted = reject;
      resolveStarted = resolve;
    });

    const cleanup = (): void => {
      if (disposed) return;
      disposed = true;
      child.offError(onError);
      child.offClose(onClose);
      child.offSpawn(onSpawn);
    };
    const rejectPreSpawn = (): void => {
      spawnFailed = true;
      rejectStarted(new Error("The frpc process did not start."));
    };
    const onSpawn = (): void => {
      spawnAcknowledged = true;
      resolveStarted();
    };
    const onError = (): void => {
      if (!spawnAcknowledged) rejectPreSpawn();
    };
    const onClose = (
      exitCode: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      if (settled) return;
      settled = true;
      if (!spawnAcknowledged) rejectPreSpawn();
      cleanup();
      observer.onExit(spawnFailed
        ? { kind: "error" }
        : { exitCode, kind: "exited", signal });
    };

    child.onError(onError);
    child.onceClose(onClose);
    child.onceSpawn(onSpawn);

    return {
      ...(pid === undefined ? {} : { pid }),
      started,
      dispose: cleanup,
      terminate: (signal) => child.kill(signal),
    };
  }
}

function spawnNodeFrpcProcess(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly detached: false;
    readonly env: NodeJS.ProcessEnv;
    readonly shell: false;
    readonly stdio: ["ignore", "ignore", "ignore"];
    readonly windowsHide: true;
  },
): SafeTunnelNodeChildProcess {
  const child = spawn(command, [...args], options);
  return {
    kill: (signal) => child.kill(signal),
    offClose: (listener) => { child.off("close", listener); },
    offError: (listener) => { child.off("error", listener); },
    offSpawn: (listener) => { child.off("spawn", listener); },
    onceClose: (listener) => { child.once("close", listener); },
    onceSpawn: (listener) => { child.once("spawn", listener); },
    onError: (listener) => { child.on("error", listener); },
    processId: () => child.pid,
  };
}

function requireAbsolutePath(value: string, fieldName: string): string {
  if (value.trim() === "") throw new Error(`${fieldName} must be a non-empty path.`);
  if (!isAbsolute(value)) throw new Error(`${fieldName} must be an absolute path.`);
  return value;
}
