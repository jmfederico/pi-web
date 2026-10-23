import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { AppState } from "../appState";

type PanelCollapseStorage = Pick<Storage, "getItem" | "setItem">;

export const PANEL_COLLAPSE_STORAGE_KEY = "pi-web:panel-collapse:v1";

export class PanelCollapseController implements ReactiveController {
  navigationPanelCollapsed = false;
  workspacePanelCollapsed = false;
  private readonly storage: PanelCollapseStorage | undefined;

  hostConnected(): void {
    return;
  }

  constructor(private readonly host: ReactiveControllerHost, options: { storage?: PanelCollapseStorage } = {}) {
    host.addController(this);
    this.storage = options.storage ?? browserPanelCollapseStorage();
    try {
      const raw = this.storage?.getItem(PANEL_COLLAPSE_STORAGE_KEY);
      if (raw === undefined || raw === null || raw === "") return;
      const value: unknown = JSON.parse(raw);
      if (typeof value !== "object" || value === null || !("version" in value) || value.version !== 1) return;
      this.navigationPanelCollapsed = "navigationPanelCollapsed" in value && value.navigationPanelCollapsed === true;
      this.workspacePanelCollapsed = "workspacePanelCollapsed" in value && value.workspacePanelCollapsed === true;
    } catch (error) {
      console.warn("Could not restore panel collapse preferences", error);
    }
  }

  toggleNavigationPanel(): void {
    this.navigationPanelCollapsed = !this.navigationPanelCollapsed;
    this.persistAndUpdate();
  }

  toggleWorkspacePanel(): void {
    this.workspacePanelCollapsed = !this.workspacePanelCollapsed;
    this.persistAndUpdate();
  }

  expandNavigationPanel(): void {
    if (!this.navigationPanelCollapsed) return;
    this.navigationPanelCollapsed = false;
    this.persistAndUpdate();
  }

  expandWorkspacePanel(): void {
    if (!this.workspacePanelCollapsed) return;
    this.workspacePanelCollapsed = false;
    this.persistAndUpdate();
  }

  private persistAndUpdate(): void {
    try {
      this.storage?.setItem(PANEL_COLLAPSE_STORAGE_KEY, JSON.stringify({
        version: 1,
        navigationPanelCollapsed: this.navigationPanelCollapsed,
        workspacePanelCollapsed: this.workspacePanelCollapsed,
      }));
    } catch (error) {
      // Storage restrictions must not prevent changing the layout in this tab.
      console.warn("Could not save panel collapse preferences", error);
    }
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
}

export function mainViewClass(mainView: AppState["mainView"]): "navigation-view" | "chat-view" | "workspace-view" {
  if (mainView === "navigation") return "navigation-view";
  if (mainView === "chat") return "chat-view";
  return "workspace-view";
}

function browserPanelCollapseStorage(): PanelCollapseStorage | undefined {
  try {
    if (typeof window === "undefined") return undefined;
    return window.localStorage;
  } catch (error) {
    console.warn("Panel collapse storage is unavailable", error);
    return undefined;
  }
}
