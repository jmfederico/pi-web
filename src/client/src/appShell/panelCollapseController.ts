import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { AppState } from "../appState";

export interface PanelCollapsePreferences {
  navigationPanelCollapsed?: boolean;
  workspacePanelCollapsed?: boolean;
}

export interface PanelCollapseControllerOptions {
  storage?: PanelCollapseStorage;
}

export type PanelCollapseStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const PANEL_COLLAPSE_STORAGE_KEY = "pi-web:panel-collapsed:v1";

interface StoredPanelCollapseEnvelope {
  version: 1;
  navigationPanelCollapsed?: boolean;
  workspacePanelCollapsed?: boolean;
}

export class PanelCollapseController implements ReactiveController {
  navigationPanelCollapsed: boolean;
  workspacePanelCollapsed: boolean;

  private readonly storage: PanelCollapseStorage | undefined;

  hostConnected(): void {
    return;
  }

  constructor(private readonly host: ReactiveControllerHost, options: PanelCollapseControllerOptions = {}) {
    host.addController(this);
    this.storage = options.storage ?? browserPanelCollapseStorage();
    const stored = readStoredPanelCollapse(this.storage);
    this.navigationPanelCollapsed = stored.navigationPanelCollapsed ?? false;
    this.workspacePanelCollapsed = stored.workspacePanelCollapsed ?? false;
  }

  toggleNavigationPanel(): void {
    this.navigationPanelCollapsed = !this.navigationPanelCollapsed;
    this.persistPanelCollapse();
    this.host.requestUpdate();
  }

  toggleWorkspacePanel(): void {
    this.workspacePanelCollapsed = !this.workspacePanelCollapsed;
    this.persistPanelCollapse();
    this.host.requestUpdate();
  }

  expandNavigationPanel(): void {
    if (!this.navigationPanelCollapsed) return;
    this.navigationPanelCollapsed = false;
    this.host.requestUpdate();
  }

  expandWorkspacePanel(): void {
    if (!this.workspacePanelCollapsed) return;
    this.workspacePanelCollapsed = false;
    this.host.requestUpdate();
  }

  shellClass(mainView: AppState["mainView"]): string {
    return [
      "shell",
      mainViewClass(mainView),
      ...(this.navigationPanelCollapsed ? ["navigation-panel-collapsed"] : []),
      ...(this.workspacePanelCollapsed ? ["workspace-panel-collapsed"] : []),
    ].join(" ");
  }

  private persistPanelCollapse(): void {
    writeStoredPanelCollapse(
      { navigationPanelCollapsed: this.navigationPanelCollapsed, workspacePanelCollapsed: this.workspacePanelCollapsed },
      this.storage,
    );
  }
}

export function mainViewClass(mainView: AppState["mainView"]): "navigation-view" | "chat-view" | "workspace-view" {
  if (mainView === "navigation") return "navigation-view";
  if (mainView === "chat") return "chat-view";
  return "workspace-view";
}

export function readStoredPanelCollapse(storage: PanelCollapseStorage | undefined = browserPanelCollapseStorage()): PanelCollapsePreferences {
  try {
    const raw = storage?.getItem(PANEL_COLLAPSE_STORAGE_KEY);
    if (raw === undefined || raw === null || raw === "") return {};
    const value: unknown = JSON.parse(raw);
    return parseStoredPanelCollapse(value);
  } catch {
    return {};
  }
}

export function writeStoredPanelCollapse(panelCollapse: PanelCollapsePreferences, storage: PanelCollapseStorage | undefined = browserPanelCollapseStorage()): void {
  if (storage === undefined) return;
  try {
    if (panelCollapse.navigationPanelCollapsed !== true && panelCollapse.workspacePanelCollapsed !== true) {
      storage.removeItem(PANEL_COLLAPSE_STORAGE_KEY);
      return;
    }
    const envelope: StoredPanelCollapseEnvelope = { version: 1 };
    if (panelCollapse.navigationPanelCollapsed === true) envelope.navigationPanelCollapsed = true;
    if (panelCollapse.workspacePanelCollapsed === true) envelope.workspacePanelCollapsed = true;
    storage.setItem(PANEL_COLLAPSE_STORAGE_KEY, JSON.stringify(envelope));
  } catch {
    // Ignore localStorage quota/privacy errors; the collapsed state still applies in memory for this tab.
  }
}

function parseStoredPanelCollapse(value: unknown): PanelCollapsePreferences {
  if (!isRecord(value) || value["version"] !== 1) return {};
  const panelCollapse: PanelCollapsePreferences = {};
  if (value["navigationPanelCollapsed"] === true) panelCollapse.navigationPanelCollapsed = true;
  if (value["workspacePanelCollapsed"] === true) panelCollapse.workspacePanelCollapsed = true;
  return panelCollapse;
}

function browserPanelCollapseStorage(): PanelCollapseStorage | undefined {
  try {
    if (typeof window === "undefined") return undefined;
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
