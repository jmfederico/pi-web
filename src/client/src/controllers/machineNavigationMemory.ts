import type { AppState } from "../appState";
import { LOCAL_MACHINE_ID } from "../machineKeys";
import type { AppRoute } from "../route";
import { browserLocalStorage, PersistentValueMap, type KeyValueStorage } from "./sessionStorageMemory";

export interface WorkspaceRouteSurface {
  selectedFilePath?: string | undefined;
  selectedDiffPath?: string | undefined;
  selectedTerminalId?: string | undefined;
}

export interface MachineNavigationSnapshot {
  machineId: string;
  projectId?: string | undefined;
  workspaceId?: string | undefined;
  sessionId?: string | undefined;
  tool?: AppRoute["tool"];
  view?: AppState["mainView"] | undefined;
  surface: WorkspaceRouteSurface;
}

export interface MachineNavigationMemory {
  latest(machineId: string): MachineNavigationSnapshot | undefined;
  remember(snapshot: MachineNavigationSnapshot): void;
  forget(machineId: string): void;
}

export class InMemoryMachineNavigationMemory implements MachineNavigationMemory {
  private readonly snapshotsByMachine = new Map<string, MachineNavigationSnapshot>();

  latest(machineId: string): MachineNavigationSnapshot | undefined {
    const snapshot = this.snapshotsByMachine.get(machineId);
    return snapshot === undefined ? undefined : cloneSnapshot(snapshot);
  }

  remember(snapshot: MachineNavigationSnapshot): void {
    this.snapshotsByMachine.set(snapshot.machineId, cloneSnapshot(snapshot));
  }

  forget(machineId: string): void {
    this.snapshotsByMachine.delete(machineId);
  }
}

const machineNavigationStorageKey = "pi-web:machine-navigation:v1";

export class SessionStorageMachineNavigationMemory implements MachineNavigationMemory {
  private readonly snapshotsByMachine: PersistentValueMap<MachineNavigationSnapshot>;

  constructor(storage: KeyValueStorage | undefined = browserLocalStorage()) {
    this.snapshotsByMachine = new PersistentValueMap(machineNavigationStorageKey, parseMachineNavigationSnapshot, storage);
  }

  latest(machineId: string): MachineNavigationSnapshot | undefined {
    const snapshot = this.snapshotsByMachine.get(machineId);
    return snapshot?.machineId === machineId ? cloneSnapshot(snapshot) : undefined;
  }

  remember(snapshot: MachineNavigationSnapshot): void {
    this.snapshotsByMachine.set(snapshot.machineId, cloneSnapshot(snapshot));
  }

  forget(machineId: string): void {
    this.snapshotsByMachine.delete(machineId);
  }
}

export function emptyMachineNavigationSnapshot(machineId: string): MachineNavigationSnapshot {
  return { machineId, surface: {} };
}

export function machineNavigationSnapshotFromState(state: AppState): MachineNavigationSnapshot {
  const hasWorkspace = state.selectedWorkspace !== undefined;
  return {
    machineId: state.selectedMachine?.id ?? LOCAL_MACHINE_ID,
    projectId: state.selectedProject?.id,
    workspaceId: state.selectedWorkspace?.id,
    sessionId: state.selectedSession?.id,
    tool: state.workspaceTool,
    view: state.mainView,
    surface: {
      selectedFilePath: hasWorkspace ? state.selectedFilePath : undefined,
      selectedDiffPath: hasWorkspace ? state.selectedDiffPath : undefined,
      selectedTerminalId: hasWorkspace ? state.selectedTerminalId : undefined,
    },
  };
}

export function routeFromMachineNavigationSnapshot(snapshot: MachineNavigationSnapshot): AppRoute {
  return {
    machineId: snapshot.machineId,
    projectId: snapshot.projectId,
    workspaceId: snapshot.workspaceId,
    sessionId: snapshot.sessionId,
    tool: snapshot.tool,
    view: snapshot.view === "navigation" ? undefined : snapshot.view,
  };
}

function cloneSnapshot(snapshot: MachineNavigationSnapshot): MachineNavigationSnapshot {
  return {
    ...snapshot,
    surface: { ...snapshot.surface },
  };
}

function parseMachineNavigationSnapshot(value: unknown): MachineNavigationSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  const machineId = optionalStringField(value, "machineId");
  if (machineId === undefined) return undefined;
  const tool = parseQualifiedId(optionalStringField(value, "tool"));
  const view = parseMainView(optionalStringField(value, "view"));
  return {
    machineId,
    projectId: optionalStringField(value, "projectId"),
    workspaceId: optionalStringField(value, "workspaceId"),
    sessionId: optionalStringField(value, "sessionId"),
    ...(tool === undefined ? {} : { tool }),
    ...(view === undefined ? {} : { view }),
    surface: parseWorkspaceRouteSurface(value["surface"]),
  };
}

function parseWorkspaceRouteSurface(value: unknown): WorkspaceRouteSurface {
  if (!isRecord(value)) return {};
  return {
    selectedFilePath: optionalStringField(value, "selectedFilePath"),
    selectedDiffPath: optionalStringField(value, "selectedDiffPath"),
    selectedTerminalId: optionalStringField(value, "selectedTerminalId"),
  };
}

function parseMainView(value: string | undefined): AppState["mainView"] | undefined {
  if (value === "navigation" || value === "chat") return value;
  return parseQualifiedId(value);
}

type QualifiedRouteId = NonNullable<AppRoute["tool"]>;

function parseQualifiedId(value: string | undefined): AppRoute["tool"] | undefined {
  return isQualifiedId(value) ? value : undefined;
}

function isQualifiedId(value: string | undefined): value is QualifiedRouteId {
  return value !== undefined && /^[a-z][a-z0-9.-]*:[a-z][a-z0-9.-]*$/u.test(value);
}

function optionalStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
