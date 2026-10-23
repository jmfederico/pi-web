export type NavigationOrderScope =
  | { kind: "projects"; machineId: string }
  | { kind: "workspaces"; machineId: string; projectId: string }
  | { kind: "sessionPins"; machineId: string; projectId: string; workspaceId: string };

export interface NavigationOrderSnapshot {
  ids: string[];
  revision: number;
}

export interface NavigationOrderPort {
  load(scope: NavigationOrderScope): Promise<NavigationOrderSnapshot>;
  save(scope: NavigationOrderScope, ids: readonly string[], revision: number): Promise<NavigationOrderSnapshot>;
}

export interface NavigationOrderControllerOptions {
  onChange?: (scope: NavigationOrderScope) => void;
  onError?: (scope: NavigationOrderScope, error: unknown) => void;
}

interface ScopeState {
  snapshot: NavigationOrderSnapshot | undefined;
  tail: Promise<void>;
  ensuring: Promise<void> | undefined;
  pending: number;
}

function scopeKey(scope: NavigationOrderScope): string {
  switch (scope.kind) {
    case "projects": return JSON.stringify([scope.kind, scope.machineId]);
    case "workspaces": return JSON.stringify([scope.kind, scope.machineId, scope.projectId]);
    case "sessionPins": return JSON.stringify([scope.kind, scope.machineId, scope.projectId, scope.workspaceId]);
  }
}

/** Owns cached sequences independently of active UI selection. Saves render only after
 * acknowledgement; queued mutations evaluate against the preceding acknowledged state.
 */
export class NavigationOrderController {
  private readonly states = new Map<string, ScopeState>();

  constructor(private readonly port: NavigationOrderPort, private readonly options: NavigationOrderControllerOptions = {}) {}

  ids(scope: NavigationOrderScope): readonly string[] {
    return [...(this.state(scope).snapshot?.ids ?? [])];
  }

  pending(scope: NavigationOrderScope): boolean {
    return this.state(scope).pending > 0;
  }

  /** Load once, coalescing concurrent callers. Failed loads remain retryable. */
  ensure(scope: NavigationOrderScope): Promise<void> {
    const state = this.state(scope);
    if (state.ensuring) return state.ensuring;
    if (state.snapshot) return Promise.resolve();
    const promise = this.load(scope);
    state.ensuring = promise;
    void promise.finally(() => { state.ensuring = undefined; }).catch(() => undefined);
    return promise;
  }

  /** Explicit refresh, serialized with writes so a late read cannot replace a save. */
  load(scope: NavigationOrderScope): Promise<void> {
    scope = { ...scope };
    return this.enqueue(scope, async (state) => { state.snapshot = await this.port.load(scope); });
  }

  mutate(scope: NavigationOrderScope, mutation: (ids: readonly string[]) => readonly string[]): Promise<void> {
    scope = { ...scope };
    return this.enqueue(scope, async (state) => {
      state.snapshot ??= await this.port.load(scope);
      const previous = state.snapshot;
      const ids = [...mutation([...previous.ids])];
      if (ids.length === previous.ids.length && ids.every((id, index) => id === previous.ids[index])) return;
      try {
        state.snapshot = await this.port.save(scope, ids, previous.revision);
      } catch (error) {
        // The write may have succeeded despite a transport failure. Never retry with
        // a stale revision or silently overwrite another browser's update.
        state.snapshot = undefined;
        try {
          state.snapshot = await this.port.load(scope);
        } catch (reloadError) {
          this.options.onError?.(scope, reloadError);
        }
        throw error;
      }
    });
  }

  private state(scope: NavigationOrderScope): ScopeState {
    const key = scopeKey(scope);
    let state = this.states.get(key);
    if (!state) {
      state = { snapshot: undefined, tail: Promise.resolve(), ensuring: undefined, pending: 0 };
      this.states.set(key, state);
    }
    return state;
  }

  private enqueue(scope: NavigationOrderScope, operation: (state: ScopeState) => Promise<void>): Promise<void> {
    // Capture immutable scope values; callers may subsequently change UI selection.
    scope = { ...scope };
    const state = this.state(scope);
    state.pending++;
    this.options.onChange?.(scope);
    const result = state.tail.then(async () => {
      try {
        await operation(state);
      } catch (error) {
        this.options.onError?.(scope, error);
        throw error;
      } finally {
        state.pending--;
        this.options.onChange?.(scope);
      }
    });
    state.tail = result.catch(() => undefined);
    return result;
  }
}
