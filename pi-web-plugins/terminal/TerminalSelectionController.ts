import { type TerminalContext, type TerminalScope } from "./TerminalContext";
import { maintenanceTerminalSelectionScope, selectFallbackTerminal, terminalSelectionScope, type TerminalSelectionMemory } from "./terminalSelection";
import type { TerminalInfo } from "./terminalProtocol";

export function terminalContextScope(context: TerminalContext): string {
  const workspace = context.workspace?.workspace;
  return workspace === undefined ? JSON.stringify([context.machine.id, "maintenance"])
    : JSON.stringify([context.machine.id, workspace.projectId, workspace.id, workspace.path]);
}

export function selectionMemoryScope(context: TerminalContext): string {
  return context.workspace === undefined ? maintenanceTerminalSelectionScope(context.machine.id)
    : terminalSelectionScope(context.machine.id, context.workspace.workspace.path);
}

function query(context: TerminalContext, key: string): string | undefined {
  const value = context.workspace?.navigation?.query[key];
  const first = typeof value === "string" ? value : value?.[0];
  return first === "" ? undefined : first;
}

interface SelectionState {
  route: string | undefined;
  publishedRoute: string | undefined;
  target: string | undefined;
  selected: string | undefined;
  revision: number;
  terminals: readonly TerminalInfo[] | undefined;
  reloadUsed: boolean;
  awaitingReload: boolean;
  starting: boolean;
  consumedStart: string | undefined;
  appliedOpen: number | undefined;
}

export interface TerminalSelectionSnapshot {
  readonly terminalId: string | undefined;
  readonly revision: number;
}

/** The only owner of intent precedence and selection effects. Context identity is not an intent. */
export class TerminalSelectionController {
  private readonly states = new Map<string, SelectionState>();
  private readonly machineSelections = new Map<string, { id: string; scope: TerminalScope }>();
  private readonly opens = new Map<string, { id: string; sequence: number }>();
  private openSequence = 0;
  private activeScope: string | undefined;

  constructor(private readonly memory: TerminalSelectionMemory) {}

  synchronize(context: TerminalContext): TerminalSelectionSnapshot {
    const state = this.state(context);
    const route = query(context, "terminal");
    const scope = terminalContextScope(context);
    const changedScope = scope !== this.activeScope;
    this.activeScope = scope;
    const open = context.maintenance === undefined ? undefined : this.opens.get(context.machine.id);
    if (open !== undefined && state.appliedOpen !== open.sequence) {
      // An explicit open is a new intent even when its target is already selected.
      state.appliedOpen = open.sequence;
      this.intent(state, open.id);
    } else if (open === undefined && (route !== state.route || changedScope)) {
      if (route !== state.route) state.publishedRoute = route;
      const target = route ?? this.remembered(context);
      if (state.target !== target || route !== state.route) this.intent(state, target);
    }
    state.route = route;
    this.reconcile(context, state);
    return { terminalId: state.selected, revision: state.revision };
  }

  requested(context: TerminalContext): string | undefined {
    this.synchronize(context);
    return this.state(context).target;
  }

  routed(context: TerminalContext): string | undefined { return query(context, "terminal"); }
  autoStartRequest(context: TerminalContext): string | undefined { return query(context, "start"); }

  requestMaintenanceTerminal(machineId: string, terminalId: string): void {
    this.opens.set(machineId, { id: terminalId, sequence: ++this.openSequence });
  }

  loaded(context: TerminalContext, terminals: readonly TerminalInfo[]): TerminalSelectionSnapshot {
    this.synchronize(context);
    const state = this.state(context);
    state.terminals = terminals;
    state.awaitingReload = false;
    this.reconcile(context, state);
    return { terminalId: state.selected, revision: state.revision };
  }

  takeReload(context: TerminalContext): boolean {
    const state = this.state(context);
    if (state.terminals === undefined || state.target === undefined || state.reloadUsed
      || state.terminals.some((item) => item.id === state.target)) return false;
    state.reloadUsed = true;
    state.awaitingReload = true;
    return true;
  }

  takeAutoStart(context: TerminalContext): boolean {
    const state = this.state(context);
    const request = query(context, "start");
    if (request === undefined || state.terminals === undefined || state.consumedStart === request) return false;
    const accepted: unknown = context.workspace?.navigation?.set("start", undefined, { replace: true });
    if (accepted === false) return false;
    state.consumedStart = request;
    return context.workspace !== undefined && state.terminals.length === 0 && !state.starting;
  }

  beginStart(context: TerminalContext): number {
    const state = this.state(context);
    state.revision += 1;
    state.starting = true;
    return state.revision;
  }

  finishStart(context: TerminalContext, revision: number): void {
    const state = this.state(context);
    if (state.revision === revision) state.starting = false;
  }

  select(context: TerminalContext, terminalId: string | undefined, options?: { replace?: boolean | undefined; scope?: TerminalScope | undefined }): boolean {
    const state = this.state(context);
    const scope = options?.scope ?? state.terminals?.find((item) => item.id === terminalId)?.scope
      ?? (terminalId === undefined ? this.machineSelections.get(context.machine.id)?.scope : undefined)
      ?? (context.workspace === undefined ? "maintenance" : "workspace");
    if (!this.publish(context, state, terminalId, scope, options?.replace)) return false;
    if (state.target !== terminalId || state.selected !== terminalId) this.intent(state, terminalId);
    state.selected = terminalId;
    state.starting = false;
    return true;
  }

  closed(context: TerminalContext, terminalId: string, terminals: readonly TerminalInfo[]): void {
    this.synchronize(context);
    const state = this.state(context);
    state.terminals = terminals;
    this.forgetTerminal(terminalId);
    if (state.target === terminalId && !state.starting) {
      const fallback = selectFallbackTerminal(terminals);
      this.select(context, fallback?.id, { replace: true, scope: fallback?.scope });
    }
  }

  forgetTerminal(terminalId: string): void {
    this.memory.forgetTerminal(terminalId);
    for (const [machine, open] of this.opens) if (open.id === terminalId) this.opens.delete(machine);
    for (const [machine, selected] of this.machineSelections) if (selected.id === terminalId) this.machineSelections.delete(machine);
  }

  dispose(): void { this.states.clear(); this.opens.clear(); this.machineSelections.clear(); }

  private state(context: TerminalContext): SelectionState {
    const key = terminalContextScope(context);
    let state = this.states.get(key);
    if (state === undefined) {
      const route = query(context, "terminal");
      state = { route, publishedRoute: route, target: (context.maintenance === undefined ? undefined : this.opens.get(context.machine.id)?.id) ?? route ?? this.remembered(context), selected: undefined,
        revision: 0, terminals: undefined, reloadUsed: false, awaitingReload: false, starting: false, consumedStart: undefined, appliedOpen: undefined };
      this.states.set(key, state);
    }
    return state;
  }

  private remembered(context: TerminalContext): string | undefined {
    const machine = this.machineSelections.get(context.machine.id);
    return (machine?.scope === "maintenance" && context.maintenance !== undefined ? machine.id : undefined)
      ?? this.memory.latestTerminalId(selectionMemoryScope(context));
  }

  private intent(state: SelectionState, target: string | undefined): void {
    state.target = target;
    state.revision += 1;
    state.reloadUsed = false;
    state.awaitingReload = false;
    state.starting = false;
  }

  private reconcile(context: TerminalContext, state: SelectionState): void {
    if (state.terminals === undefined || state.starting || state.awaitingReload) return;
    const target = state.terminals.find((item) => item.id === state.target);
    // A newly opened terminal may not be in the first list yet. Keep the intent
    // through exactly one reload before treating it as unavailable.
    if (state.target !== undefined && target === undefined && !state.reloadUsed) return;
    const terminal = target ?? selectFallbackTerminal(state.terminals);
    this.select(context, terminal?.id, { replace: true, scope: terminal?.scope });
  }

  private publish(context: TerminalContext, state: SelectionState, id: string | undefined, scope: TerminalScope, replace?: boolean): boolean {
    const memoryScope = scope === "maintenance" ? maintenanceTerminalSelectionScope(context.machine.id) : selectionMemoryScope(context);
    const remembered = this.memory.latestTerminalId(memoryScope);
    const navigation = context.workspace?.navigation;
    // Once accepted, an unchanged route snapshot is not a fresh history intent.
    // This also makes panels without URL navigation idempotent by construction.
    const selectionChanged = state.selected !== id;
    const routeChanged = navigation !== undefined && (state.publishedRoute !== id || selectionChanged);
    if (routeChanged) {
      // Portable navigation is typed void; PI WEB returns false for stale contexts.
      const result: unknown = context.workspace?.navigation?.set("terminal", id, replace === undefined ? undefined : { replace });
      if (result === false) return false;
      state.publishedRoute = id;
    }
    const open = this.opens.delete(context.machine.id);
    if (id === undefined) this.machineSelections.delete(context.machine.id);
    else this.machineSelections.set(context.machine.id, { id, scope });
    if (remembered !== id) {
      if (id === undefined) this.memory.forgetWorkspace(memoryScope);
      else this.memory.rememberTerminal(memoryScope, id);
    }
    if (selectionChanged || remembered !== id || open) context.host.requestRender();
    return true;
  }
}
