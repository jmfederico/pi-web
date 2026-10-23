export interface PtySpawnOptions {
  shell: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  env: NodeJS.ProcessEnv;
}

export interface PtyHandlers {
  output(data: string): void;
  exit(exitCode: number | undefined): void;
}

/** One owned PTY. dispose is idempotent and suppresses all subsequent callbacks. */
export interface PtyHandle {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  dispose(): void;
}

export interface PtyProvider {
  readonly kind: "node" | "bun";
  /** Handlers are installed before spawn. Output precedes a single exit; exit releases the PTY. */
  spawn(options: PtySpawnOptions, handlers: PtyHandlers): PtyHandle;
}
