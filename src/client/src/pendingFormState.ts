import { clearAskDraft, loadAskDraft, saveAskDraft, type AskDraftAnswers } from "./askDrafts";

export interface PendingFormIdentity {
  /** Caller-supplied machineSessionKey, not a bare session id. */
  scope: string;
  kind: "ask" | "dialog";
  requestId: string;
}

interface FormEntry {
  kind: PendingFormIdentity["kind"];
  requestId: string;
  answers: AskDraftAnswers;
  input: string;
  operation?: Promise<void>;
  closed?: boolean;
}

interface ScopeOwner {
  scope: string;
  forms: Map<string, FormEntry>;
  listeners: Map<string, Set<() => void>>;
}

export function pendingFormKey(identity: PendingFormIdentity): string {
  return JSON.stringify([identity.scope, identity.kind, identity.requestId]);
}

function requestKey(identity: PendingFormIdentity): string {
  return JSON.stringify([identity.kind, identity.requestId]);
}

/** Pending request memory. Dialog text never crosses a storage boundary. */
export class PendingFormState {
  private readonly scopes = new Map<string, ScopeOwner>();

  /** Reading historical cards must not create request owners. */
  get(identity: PendingFormIdentity): Readonly<FormEntry> {
    return this.scopes.get(identity.scope)?.forms.get(requestKey(identity)) ?? this.initialEntry(identity);
  }

  private initialEntry(identity: PendingFormIdentity): FormEntry {
    return {
      kind: identity.kind,
      requestId: identity.requestId,
      answers: identity.kind === "ask" && identity.scope !== "" ? loadAskDraft(identity.scope, identity.requestId) : {},
      input: "",
    };
  }

  private owner(scope: string): ScopeOwner {
    let owner = this.scopes.get(scope);
    if (owner === undefined) {
      owner = { scope, forms: new Map(), listeners: new Map() };
      this.scopes.set(scope, owner);
    }
    return owner;
  }

  private entry(owner: ScopeOwner, identity: PendingFormIdentity): FormEntry {
    const key = requestKey(identity);
    let entry = owner.forms.get(key);
    if (entry === undefined) {
      entry = this.initialEntry(identity);
      owner.forms.set(key, entry);
    }
    return entry;
  }

  setAnswers(identity: PendingFormIdentity, answers: AskDraftAnswers): void {
    const owner = this.owner(identity.scope);
    const entry = this.entry(owner, identity);
    if (entry.operation !== undefined || entry.closed === true) return;
    entry.answers = answers;
    if (owner.scope !== "") saveAskDraft(owner.scope, identity.requestId, answers);
    this.notify(owner, requestKey(identity));
  }

  setInput(identity: PendingFormIdentity, input: string): void {
    const owner = this.owner(identity.scope);
    const entry = this.entry(owner, identity);
    if (entry.operation !== undefined || entry.closed === true) return;
    entry.input = input;
    this.notify(owner, requestKey(identity));
  }

  subscribe(identity: PendingFormIdentity, listener: () => void): () => void {
    const owner = this.owner(identity.scope);
    this.entry(owner, identity);
    const key = requestKey(identity);
    const listeners = owner.listeners.get(key) ?? new Set<() => void>();
    owner.listeners.set(key, listeners);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) owner.listeners.delete(key);
      // Navigation does not close a request or discard its draft.
    };
  }

  /** Lock before invoking the captured operation, including synchronous reentry. */
  runExclusive(identity: PendingFormIdentity, operation: () => void | Promise<void>): Promise<void> {
    const owner = this.owner(identity.scope);
    const entry = this.entry(owner, identity);
    if (entry.operation !== undefined) return entry.operation;
    if (entry.closed === true) return Promise.resolve();
    const key = requestKey(identity);
    const locked = Promise.resolve().then(operation).finally(() => {
      delete entry.operation;
      if (entry.closed === true) this.release(owner, key);
      this.notify(owner, key);
    });
    entry.operation = locked;
    this.notify(owner, key);
    // Resolution is not authoritative success: controllers can catch errors.
    return locked;
  }

  forgetDialog(scope: string, requestId: string): void {
    this.close({ scope, kind: "dialog", requestId });
  }

  /** Call only with an authoritative pending-dialog snapshot for this scope. */
  syncDialogs(scope: string, ids: Iterable<string>): void {
    const owner = this.scopes.get(scope);
    if (owner === undefined) return;
    const pending = new Set(ids);
    for (const entry of owner.forms.values()) {
      if (entry.kind === "dialog" && !pending.has(entry.requestId)) this.forgetDialog(scope, entry.requestId);
    }
  }

  /** Called only after the controller receives an accepted ask response. */
  clearAsk(scope: string, requestId: string): void {
    clearAskDraft(scope, requestId);
    this.close({ scope, kind: "ask", requestId });
  }

  /** A failed or discarded startup can no longer accept any of its forms. */
  clearScope(scope: string): void {
    const owner = this.scopes.get(scope);
    if (owner === undefined) return;
    for (const entry of owner.forms.values()) {
      if (entry.kind === "ask") this.clearAsk(scope, entry.requestId);
      else this.forgetDialog(scope, entry.requestId);
    }
  }

  private close(identity: PendingFormIdentity): void {
    const owner = this.scopes.get(identity.scope);
    const key = requestKey(identity);
    const entry = owner?.forms.get(key);
    if (owner === undefined || entry === undefined) return;
    entry.answers = {};
    entry.input = "";
    entry.closed = true;
    if (entry.operation === undefined) this.release(owner, key);
    this.notify(owner, key);
  }

  private release(owner: ScopeOwner, key: string): void {
    owner.forms.delete(key);
    if (owner.forms.size === 0 && this.scopes.get(owner.scope) === owner) this.scopes.delete(owner.scope);
  }

  /** Startup dialogs keep the same owner, listeners, and locks at the real key. */
  promoteScope(previousScope: string, scope: string): void {
    if (previousScope === scope) return;
    const owner = this.scopes.get(previousScope);
    if (owner === undefined) return;
    if (this.scopes.has(scope)) throw new Error("Cannot promote into an existing request owner");
    this.scopes.delete(previousScope);
    owner.scope = scope;
    this.scopes.set(scope, owner);
  }

  private notify(owner: ScopeOwner, key: string): void {
    owner.listeners.get(key)?.forEach((listener) => { listener(); });
  }
}
