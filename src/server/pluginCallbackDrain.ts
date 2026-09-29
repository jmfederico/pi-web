/** Tracks raw in-process plugin callbacks so shutdown can await cooperative settlement. */
export class PluginCallbackDrain {
  private readonly pending = new Set<Promise<void>>();

  track<T>(callback: Promise<T>): void {
    const settled = callback.then(
      () => undefined,
      () => undefined,
    );
    this.pending.add(settled);
    void settled.then(() => { this.pending.delete(settled); });
  }

  async waitForSettled(timeoutMs: number, label: string): Promise<void> {
    if (this.pending.size === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${label} did not settle within ${String(timeoutMs)}ms`));
      }, timeoutMs);
      timer.unref();
    });
    try {
      await Promise.race([this.waitUntilEmpty(), deadline]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async waitUntilEmpty(): Promise<void> {
    while (this.pending.size !== 0) {
      await Promise.all([...this.pending]);
    }
  }
}
