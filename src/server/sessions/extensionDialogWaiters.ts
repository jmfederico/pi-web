import type { ExtensionDialogAnswer, ExtensionDialogKind, PendingExtensionDialog } from "../../shared/apiTypes.js";

/** Why a parked wait ended without the browser: its timer elapsed, or the extension aborted its own signal. */
export type ExtensionDialogWaiterTrigger = "timeout" | "cancelled";

export interface ExtensionDialogWaiterTriggers {
  /** Effective auto-cancel delay; omitted (or resolved away) means the dialog waits forever. */
  timeoutMs?: number | undefined;
  /** The extension's own abort signal, subscribed once and unsubscribed on settle. */
  signal?: AbortSignal | undefined;
  /**
   * Fired exactly once when the wait ends without a browser close. The caller
   * owns closing the store record and settling the waiter; the waiters only
   * guarantee the trigger cannot fire after a settle. Omit when nothing but
   * the browser can end the wait.
   */
  onTrigger?: ((reason: ExtensionDialogWaiterTrigger) => void) | undefined;
}

interface ParkedExtensionDialog {
  /** The value the extension's Promise resolves with when the dialog closes without an answer. */
  cancelValue: boolean | undefined;
  resolve: (value: boolean | string | undefined) => void;
  cancelArmedTimeout?: (() => void) | undefined;
  removeSignalListener?: (() => void) | undefined;
}

/** The value an extension's dialog Promise settles with on any close without an answer. */
export function extensionDialogCancelValue(kind: ExtensionDialogKind): boolean | undefined {
  return kind === "confirm" ? false : undefined;
}

/**
 * The auto-cancel delay of one dialog: the sooner of the extension's own
 * `timeout` and the daemon's `extensionDialogsTimeoutMs` default, where `0`
 * (or an invalid extension value, defensively ignored) means "waits forever".
 */
export function effectiveExtensionDialogTimeoutMs(extensionTimeoutMs: number | undefined, daemonDefaultMs: number): number | undefined {
  const fromExtension = typeof extensionTimeoutMs === "number" && Number.isFinite(extensionTimeoutMs) && extensionTimeoutMs > 0 ? extensionTimeoutMs : undefined;
  const fromDaemon = daemonDefaultMs > 0 ? daemonDefaultMs : undefined;
  if (fromExtension === undefined) return fromDaemon;
  if (fromDaemon === undefined) return fromExtension;
  return Math.min(fromExtension, fromDaemon);
}

/**
 * The parked Promise resolvers behind open extension dialogs, plus the timers
 * and signal subscriptions that can end a wait without the browser. Timers use
 * the global `setTimeout`/`clearTimeout` looked up per call, the same seam the
 * rest of the service's timer tests fake.
 *
 * Kept deliberately separate from {@link PendingExtensionDialogStore}: the
 * store owns the domain state every browser sees, the waiters own the one
 * in-memory resolver each open dialog parks inside extension code — state no
 * browser ever observes and that must not survive the runtime. The pairing is
 * the wiring's invariant: every open store record has exactly one parked
 * waiter, and whoever closes the record settles the waiter exactly once.
 */
export class ExtensionDialogWaiters {
  private readonly parked = new Map<string, ParkedExtensionDialog>();

  /**
   * Park the extension-facing Promise for a dialog the store just opened. Arms
   * the timeout and signal triggers; both are disarmed when the wait settles,
   * so a settled wait can never be triggered (nor trigger twice).
   */
  park(dialog: PendingExtensionDialog, triggers: ExtensionDialogWaiterTriggers = {}): Promise<boolean | string | undefined> {
    return new Promise((resolve) => {
      const parked: ParkedExtensionDialog = { cancelValue: extensionDialogCancelValue(dialog.kind), resolve };
      if (triggers.timeoutMs !== undefined) {
        const handle = setTimeout(() => { triggers.onTrigger?.("timeout"); }, triggers.timeoutMs);
        parked.cancelArmedTimeout = () => { clearTimeout(handle); };
      }
      if (triggers.signal !== undefined) {
        const signal = triggers.signal;
        const onAbort = () => { triggers.onTrigger?.("cancelled"); };
        signal.addEventListener("abort", onAbort, { once: true });
        parked.removeSignalListener = () => { signal.removeEventListener("abort", onAbort); };
      }
      this.parked.set(dialog.dialogId, parked);
    });
  }

  /** Resolve the parked wait with the user's answer, which the store has already validated and recorded. */
  settleWithAnswer(dialogId: string, answer: ExtensionDialogAnswer): boolean {
    return this.settle(dialogId, (parked) => { parked.resolve(answer); });
  }

  /** Resolve the parked wait with the dialog kind's cancel value after a close without an answer. */
  settleWithCancelValue(dialogId: string): boolean {
    return this.settle(dialogId, (parked) => { parked.resolve(parked.cancelValue); });
  }

  private settle(dialogId: string, resolveParked: (parked: ParkedExtensionDialog) => void): boolean {
    const parked = this.parked.get(dialogId);
    if (parked === undefined) return false;
    this.parked.delete(dialogId);
    parked.cancelArmedTimeout?.();
    parked.removeSignalListener?.();
    resolveParked(parked);
    return true;
  }
}
