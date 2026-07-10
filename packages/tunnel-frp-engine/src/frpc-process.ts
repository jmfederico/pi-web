import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

export const defaultFrpcStopSignal: NodeJS.Signals = "SIGTERM";
export const frpcConfigFlag = "-c";

export interface FrpcLaunchOptions {
  readonly configPath: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly frpcPath: string;
}

export interface FrpcSpawnRequest {
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly frpcPath: string;
}

export interface ManagedFrpcChildProcess {
  readonly pid?: number | undefined;

  kill(signal: NodeJS.Signals): boolean;
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "exit", listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void): this;
}

export type FrpcLifecycleState =
  | { readonly kind: "idle" }
  | { readonly kind: "running"; readonly pid: number | null }
  | { readonly kind: "stopping"; readonly pid: number | null; readonly requestedSignal: NodeJS.Signals }
  | { readonly exitCode: number | null; readonly kind: "exited"; readonly pid: number | null; readonly signal: NodeJS.Signals | null }
  | { readonly errorMessage: string; readonly kind: "failed"; readonly pid: number | null };

export type FrpcProcessSpawner = (request: FrpcSpawnRequest) => ManagedFrpcChildProcess;

export interface FrpcProcessManagerDependencies {
  readonly spawnFrpc: FrpcProcessSpawner;
}

export class FrpcProcessManager {
  private activeProcess: ManagedFrpcChildProcess | undefined;
  private lifecycleState: FrpcLifecycleState = { kind: "idle" };
  private exitWaiters: ((state: FrpcLifecycleState) => void)[] = [];
  private readonly dependencies: FrpcProcessManagerDependencies;

  public constructor(dependencies: FrpcProcessManagerDependencies = createNodeFrpcProcessManagerDependencies()) {
    this.dependencies = dependencies;
  }

  public getState(): FrpcLifecycleState {
    return this.lifecycleState;
  }

  /**
   * Resolve once the current run ends (`exited` or `failed`). If no process is
   * active, resolve immediately with the current lifecycle state. Used by the
   * connector supervisor to keep `start` in the foreground until frpc stops.
   */
  public waitForExit(): Promise<FrpcLifecycleState> {
    if (this.activeProcess === undefined) {
      return Promise.resolve(this.lifecycleState);
    }

    return new Promise((resolve) => {
      this.exitWaiters.push(resolve);
    });
  }

  public start(options: FrpcLaunchOptions): FrpcLifecycleState {
    if (this.activeProcess !== undefined) {
      throw new Error(`frpc is already ${this.lifecycleState.kind}.`);
    }

    const request = createFrpcSpawnRequest(options);
    let childProcess: ManagedFrpcChildProcess;

    try {
      childProcess = this.dependencies.spawnFrpc(request);
    } catch (error) {
      this.lifecycleState = {
        errorMessage: formatUnknownError(error),
        kind: "failed",
        pid: null,
      };
      return this.lifecycleState;
    }

    const pid = normalizePid(childProcess.pid);

    this.activeProcess = childProcess;
    this.lifecycleState = {
      kind: "running",
      pid,
    };

    childProcess.once("exit", (exitCode, signal) => {
      this.handleProcessExit(childProcess, pid, exitCode, signal);
    });
    childProcess.once("error", (error) => {
      this.handleProcessError(childProcess, pid, error);
    });

    return this.lifecycleState;
  }

  public stop(signal: NodeJS.Signals = defaultFrpcStopSignal): FrpcLifecycleState {
    const childProcess = this.activeProcess;

    if (childProcess === undefined) {
      return this.lifecycleState;
    }

    const pid = normalizePid(childProcess.pid);
    const signaled = childProcess.kill(signal);

    if (!signaled) {
      this.activeProcess = undefined;
      this.lifecycleState = {
        errorMessage: `Failed to signal frpc process with ${signal}.`,
        kind: "failed",
        pid,
      };
      return this.lifecycleState;
    }

    this.lifecycleState = {
      kind: "stopping",
      pid,
      requestedSignal: signal,
    };

    return this.lifecycleState;
  }

  private handleProcessExit(
    childProcess: ManagedFrpcChildProcess,
    pid: number | null,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (this.activeProcess !== childProcess) {
      return;
    }

    this.activeProcess = undefined;
    this.lifecycleState = {
      exitCode,
      kind: "exited",
      pid,
      signal,
    };
    this.resolveExitWaiters();
  }

  private handleProcessError(childProcess: ManagedFrpcChildProcess, pid: number | null, error: Error): void {
    if (this.activeProcess !== childProcess) {
      return;
    }

    this.activeProcess = undefined;
    this.lifecycleState = {
      errorMessage: error.message,
      kind: "failed",
      pid,
    };
    this.resolveExitWaiters();
  }

  private resolveExitWaiters(): void {
    const waiters = this.exitWaiters;
    this.exitWaiters = [];

    for (const resolve of waiters) {
      resolve(this.lifecycleState);
    }
  }
}

export function createFrpcSpawnRequest(options: FrpcLaunchOptions): FrpcSpawnRequest {
  const baseRequest = {
    args: [frpcConfigFlag, requireNonEmptyString(options.configPath, "configPath")],
    frpcPath: requireNonEmptyString(options.frpcPath, "frpcPath"),
  };

  if (options.cwd !== undefined && options.env !== undefined) {
    return {
      ...baseRequest,
      cwd: requireNonEmptyString(options.cwd, "cwd"),
      env: options.env,
    };
  }

  if (options.cwd !== undefined) {
    return {
      ...baseRequest,
      cwd: requireNonEmptyString(options.cwd, "cwd"),
    };
  }

  if (options.env !== undefined) {
    return {
      ...baseRequest,
      env: options.env,
    };
  }

  return baseRequest;
}

export function createNodeFrpcProcessManagerDependencies(): FrpcProcessManagerDependencies {
  return {
    spawnFrpc(request): ChildProcess {
      return spawn(request.frpcPath, request.args, createNodeSpawnOptions(request));
    },
  };
}

function createNodeSpawnOptions(request: FrpcSpawnRequest): SpawnOptions {
  const options: SpawnOptions = {
    stdio: "inherit",
    windowsHide: true,
  };

  if (request.cwd !== undefined) {
    options.cwd = request.cwd;
  }

  if (request.env !== undefined) {
    options.env = {
      ...process.env,
      ...request.env,
    };
  }

  return options;
}

function normalizePid(pid: number | undefined): number | null {
  return pid ?? null;
}

function requireNonEmptyString(value: string, name: string): string {
  if (value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string.`);
  }

  return value;
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "unexpected non-error failure";
}
