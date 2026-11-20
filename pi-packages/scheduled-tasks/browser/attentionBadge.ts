import type { ApplicationPanelContextV5 } from "@jmfederico/pi-web/plugin-api";

type BadgeContext = Pick<ApplicationPanelContextV5, "machine" | "backend" | "host">;
const refreshMs = 30_000;

/** The host reads badges synchronously, including while their panels are closed. */
export class AttentionBadge {
  private machineId: string | undefined;
  private count: number | undefined;
  private pending: AbortController | undefined;
  private pollGeneration = 0;
  private wake: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly lifetime: AbortSignal) {
    lifetime.addEventListener("abort", () => { this.reset(); }, { once: true });
  }

  read(context: BadgeContext): number | undefined {
    if (this.machineId !== context.machine.id || !context.backend) this.reset();
    if (this.lifetime.aborted || !context.backend) return undefined;
    this.machineId = context.machine.id;
    if (!this.pending && this.wake === undefined) {
      if (document.hidden) this.schedule(context);
      else void this.refresh(context);
    }
    return this.count;
  }

  /** A slow overview may supersede an older poll, but never one started after it. */
  beginOverview(context: BadgeContext): (count: number) => void {
    const generation = this.pollGeneration;
    return (count) => {
      if (this.lifetime.aborted || this.machineId !== context.machine.id || generation !== this.pollGeneration) return;
      this.pending?.abort();
      this.pending = undefined;
      this.schedule(context);
      this.publish(context, count);
    };
  }

  private async refresh(context: BadgeContext): Promise<void> {
    this.pollGeneration++;
    const controller = new AbortController();
    this.pending = controller;
    let count: number | undefined;
    try {
      const peer = context.backend?.forScope({ kind: "machine" });
      const result = await peer?.request?.("attentionCount", {}, { signal: controller.signal });
      if (typeof result !== "number" || !Number.isSafeInteger(result) || result < 0) throw new Error("Invalid scheduled task attention count");
      count = result;
    } catch (error) {
      if (!controller.signal.aborted) console.warn("Could not refresh the scheduled task badge", error);
    }
    if (controller.signal.aborted) return;
    this.pending = undefined;
    this.schedule(context);
    this.publish(context, count);
  }

  private publish(context: BadgeContext, count: number | undefined): void {
    const badge = count === 0 ? undefined : count;
    if (this.count === badge) return;
    this.count = badge;
    context.host.requestRender();
  }

  private schedule(context: BadgeContext): void {
    clearTimeout(this.wake);
    // Ask for a fresh context instead of polling a machine whose tab is no longer visible.
    this.wake = setTimeout(() => {
      this.wake = undefined;
      context.host.requestRender();
    }, refreshMs);
  }

  private reset(): void {
    this.pending?.abort();
    this.pending = undefined;
    clearTimeout(this.wake);
    this.wake = undefined;
    this.machineId = undefined;
    this.count = undefined;
  }
}
