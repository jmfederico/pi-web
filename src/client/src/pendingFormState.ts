import { clearAskDraft, loadAskDraft, saveAskDraft, type AskDraftAnswers } from "./askDrafts";

export interface PendingFormIdentity {
  /** Caller-supplied machineSessionKey, not a bare session id. */
  scope: string;
  kind: "ask" | "dialog";
  requestId: string;
}

interface FormEntry {
  identity: PendingFormIdentity;
  answers: AskDraftAnswers;
  input: string;
  confirmingPartial: boolean;
  operation?: Promise<void>;
  forgotten?: boolean;
}

export function pendingFormKey(identity: PendingFormIdentity): string {
  return JSON.stringify([identity.scope, identity.kind, identity.requestId]);
}

/** Instance-owned form memory. Dialog text never crosses a storage boundary. */
export class PendingFormState {
  private readonly entries = new Map<string, FormEntry>();
  private readonly listeners = new Map<string, Set<{ key: string; identity: PendingFormIdentity; callback: () => void }>>();

  constructor(private readonly maxIdleForms = 256) {
    if (!Number.isSafeInteger(maxIdleForms) || maxIdleForms < 1) throw new RangeError("maxIdleForms must be a positive safe integer");
  }

  get(identity: PendingFormIdentity): Readonly<FormEntry> {
    return this.getEntry(identity);
  }

  private getEntry(identity: PendingFormIdentity): FormEntry {
    const key = pendingFormKey(identity);
    let entry = this.entries.get(key);
    entry ??= {
      identity: { ...identity },
      answers: identity.kind === "ask" && identity.scope !== "" ? loadAskDraft(identity.scope, identity.requestId) : {},
      input: "",
      confirmingPartial: false,
    };
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.trim();
    return entry;
  }

  setAnswers(identity: PendingFormIdentity, answers: AskDraftAnswers): void {
    const entry = this.getEntry(identity);
    if (entry.operation !== undefined) return;
    entry.answers = answers;
    entry.confirmingPartial = false;
    if (identity.scope !== "") saveAskDraft(identity.scope, identity.requestId, answers);
    this.notify(identity);
  }

  setInput(identity: PendingFormIdentity, input: string): void {
    const entry = this.getEntry(identity);
    if (entry.operation !== undefined) return;
    entry.input = input;
    this.notify(identity);
  }

  setConfirmingPartial(identity: PendingFormIdentity, confirming: boolean): void {
    const entry = this.getEntry(identity);
    if (entry.operation !== undefined) return;
    entry.confirmingPartial = confirming;
    this.notify(identity);
  }

  subscribe(identity: PendingFormIdentity, listener: () => void): () => void {
    const key = pendingFormKey(identity);
    const listeners = this.listeners.get(key) ?? new Set<{ key: string; identity: PendingFormIdentity; callback: () => void }>();
    const subscription = { key, identity: { ...identity }, callback: listener };
    this.listeners.set(key, listeners);
    listeners.add(subscription);
    return () => {
      const current = this.listeners.get(subscription.key);
      current?.delete(subscription);
      if (current?.size === 0) this.listeners.delete(subscription.key);
      this.trim();
    };
  }

  /** Lock before invoking the captured operation, including synchronous reentry. */
  runExclusive(identity: PendingFormIdentity, operation: () => void | Promise<void>): Promise<void> {
    const entry = this.getEntry(identity);
    if (entry.operation !== undefined) return entry.operation;
    let resolve!: (value: void | PromiseLike<void>) => void;
    let reject!: (reason: unknown) => void;
    const result = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const locked = result.finally(() => {
      delete entry.operation;
      const key = pendingFormKey(entry.identity);
      if (entry.forgotten === true && this.entries.get(key) === entry) this.entries.delete(key);
      this.trim();
      this.notify(entry.identity);
    });
    entry.operation = locked;
    this.notify(identity);
    try { resolve(operation()); } catch (error) { reject(error); }
    // Resolution is not authoritative success: controllers can catch errors.
    return locked;
  }

  forgetDialog(scope: string, requestId: string): void {
    const identity: PendingFormIdentity = { scope, kind: "dialog", requestId };
    const key = pendingFormKey(identity);
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    entry.input = "";
    entry.forgotten = true;
    if (entry.operation === undefined) this.entries.delete(key);
    this.notify(identity);
  }

  /** Call only with an authoritative pending-dialog snapshot for this scope. */
  syncDialogs(scope: string, ids: Iterable<string>): void {
    const pending = new Set(ids);
    for (const entry of this.entries.values()) {
      const identity = entry.identity;
      if (identity.kind === "dialog" && identity.scope === scope && !pending.has(identity.requestId)) {
        this.forgetDialog(scope, identity.requestId);
      }
    }
  }

  /** Called only after the controller receives an accepted ask response. */
  clearAsk(scope: string, requestId: string): void {
    const identity: PendingFormIdentity = { scope, kind: "ask", requestId };
    const entry = this.entries.get(pendingFormKey(identity));
    if (entry === undefined) return;
    entry.answers = {};
    entry.confirmingPartial = false;
    this.notify(identity);
  }

  /** Synchronous startup handoff, before the real session replaces its temporary row. */
  promoteScope(previousScope: string, scope: string): void {
    if (previousScope === scope) return;
    for (const entry of this.entries.values()) {
      if (entry.identity.scope === previousScope && this.entries.has(pendingFormKey({ ...entry.identity, scope }))) {
        throw new Error("Cannot promote a form into an existing request owner");
      }
    }
    for (const [key, entry] of this.entries) {
      if (entry.identity.scope !== previousScope) continue;
      const identity = { ...entry.identity, scope };
      const target = pendingFormKey(identity);
      if (identity.kind === "ask") {
        saveAskDraft(scope, identity.requestId, entry.answers);
        clearAskDraft(previousScope, identity.requestId);
      }
      this.entries.delete(key);
      entry.identity = identity;
      this.entries.set(target, entry);
    }
    for (const [key, subscriptions] of this.listeners) {
      const first = subscriptions.values().next().value;
      if (first?.identity.scope !== previousScope) continue;
      const target = pendingFormKey({ ...first.identity, scope });
      this.listeners.delete(key);
      const destination = this.listeners.get(target) ?? new Set<typeof first>();
      for (const subscription of subscriptions) {
        subscription.key = target;
        subscription.identity = { ...subscription.identity, scope };
        destination.add(subscription);
      }
      this.listeners.set(target, destination);
    }
  }

  private notify(identity: PendingFormIdentity): void {
    this.listeners.get(pendingFormKey(identity))?.forEach((listener) => { listener.callback(); });
  }

  private trim(): void {
    const idleEntry = (key: string, entry: FormEntry) => entry.operation === undefined && !this.listeners.has(key);
    let idle = [...this.entries].filter(([key, entry]) => idleEntry(key, entry)).length;
    for (const [key, entry] of this.entries) {
      if (idle <= this.maxIdleForms) break;
      if (idleEntry(key, entry)) { this.entries.delete(key); idle--; }
    }
  }
}
