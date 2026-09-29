import type { TerminalInfo } from "./terminalProtocol";

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface TerminalSelectionMemory {
  latestTerminalId(scope: string): string | undefined;
  rememberTerminal(scope: string, terminalId: string): void;
  forgetWorkspace(scope: string): void;
  forgetTerminal(terminalId: string): void;
}

export class InMemoryTerminalSelectionMemory implements TerminalSelectionMemory {
  protected readonly terminalIdsByScope = new Map<string, string>();

  latestTerminalId(scope: string): string | undefined {
    return this.terminalIdsByScope.get(scope);
  }

  rememberTerminal(scope: string, terminalId: string): void {
    this.terminalIdsByScope.set(scope, terminalId);
  }

  forgetWorkspace(scope: string): void {
    this.terminalIdsByScope.delete(scope);
  }

  forgetTerminal(terminalId: string): void {
    for (const [scope, rememberedTerminalId] of this.terminalIdsByScope.entries()) {
      if (rememberedTerminalId === terminalId) this.terminalIdsByScope.delete(scope);
    }
  }
}

const terminalSelectionStorageKey = "pi-web:terminal-selection:v1";

export class SessionStorageTerminalSelectionMemory extends InMemoryTerminalSelectionMemory {
  constructor(private readonly storage: KeyValueStorage | undefined = browserSessionStorage()) {
    super();
    for (const [scope, terminalId] of loadEntries(storage)) this.terminalIdsByScope.set(scope, terminalId);
  }

  override latestTerminalId(scope: string): string | undefined {
    if (this.storage === undefined) return super.latestTerminalId(scope);
    const stored = new Map(loadEntries(this.storage));
    const terminalId = stored.get(scope);
    if (terminalId === undefined) this.terminalIdsByScope.delete(scope);
    else this.terminalIdsByScope.set(scope, terminalId);
    return terminalId;
  }

  override rememberTerminal(scope: string, terminalId: string): void {
    super.rememberTerminal(scope, terminalId);
    this.mutateStoredEntries((entries) => { entries.set(scope, terminalId); });
  }

  override forgetWorkspace(scope: string): void {
    super.forgetWorkspace(scope);
    this.mutateStoredEntries((entries) => { entries.delete(scope); });
  }

  override forgetTerminal(terminalId: string): void {
    super.forgetTerminal(terminalId);
    this.mutateStoredEntries((entries) => {
      for (const [scope, rememberedTerminalId] of entries) {
        if (rememberedTerminalId === terminalId) entries.delete(scope);
      }
    });
  }

  private mutateStoredEntries(mutate: (entries: Map<string, string>) => void): void {
    try {
      const entries = new Map(loadEntries(this.storage));
      mutate(entries);
      if (entries.size === 0) {
        this.storage?.removeItem(terminalSelectionStorageKey);
        return;
      }
      this.storage?.setItem(terminalSelectionStorageKey, JSON.stringify({
        version: 1,
        entries: [...entries],
      }));
    } catch {
      // Keep the in-memory selection when session storage is unavailable or full.
    }
  }
}

export function terminalSelectionScope(machineId: string, workspacePath: string): string {
  return `${machineId}:${workspacePath}`;
}

export function selectPreferredTerminal(terminals: readonly TerminalInfo[], options?: { targetTerminalId?: string | undefined; latestTerminalId?: string | undefined }): TerminalInfo | undefined {
  const targetTerminalId = options?.targetTerminalId;
  if (targetTerminalId !== undefined && targetTerminalId !== "") return terminals.find((terminal) => terminal.id === targetTerminalId);

  const latestTerminalId = options?.latestTerminalId;
  if (latestTerminalId !== undefined && latestTerminalId !== "") {
    return terminals.find((terminal) => terminal.id === latestTerminalId) ?? terminals.find((terminal) => !terminal.exited) ?? terminals[0];
  }

  return terminals.find((terminal) => !terminal.exited) ?? terminals[0];
}

export function selectFallbackTerminal(terminals: readonly TerminalInfo[]): TerminalInfo | undefined {
  return terminals.find((terminal) => !terminal.exited) ?? terminals[0];
}

function browserSessionStorage(): KeyValueStorage | undefined {
  try {
    return typeof sessionStorage === "undefined" ? undefined : sessionStorage;
  } catch {
    return undefined;
  }
}

function loadEntries(storage: KeyValueStorage | undefined): [string, string][] {
  try {
    const raw = storage?.getItem(terminalSelectionStorageKey);
    if (raw === undefined || raw === null || raw === "") return [];
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value["version"] !== 1 || !Array.isArray(value["entries"])) return [];
    return value["entries"].flatMap((entry): [string, string][] => {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || entry[0] === "" || typeof entry[1] !== "string" || entry[1] === "") return [];
      return [[entry[0], entry[1]]];
    });
  } catch {
    return [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
