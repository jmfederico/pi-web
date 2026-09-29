import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { AppState } from "../appState";
import { createPwaDisplayModeMedia, detectPwaDisplayMode } from "../pwaDisplayMode";
import { ViewportPositionRepairer } from "./viewportPositionRepair";

export const DESKTOP_SIDE_BY_SIDE_MEDIA_QUERY = "(min-width: 1181px)";
export const MOBILE_NAVIGATION_MEDIA_QUERY = "(max-width: 760px)";

export interface AppShellControllerOptions {
  desktopSideBySideMedia?: MediaQueryList | undefined;
  mobileNavigationMedia?: MediaQueryList | undefined;
  pwaDisplayModeMedia?: MediaQueryList[] | undefined;
  viewportPositionRepairer?: ViewportPositionRepairer | undefined;
}

export class AppShellController implements ReactiveController {
  private readonly desktopSideBySideMedia: MediaQueryList | undefined;
  isDesktopSideBySideLayout: boolean;
  private readonly mobileNavigationMedia: MediaQueryList | undefined;
  private readonly pwaDisplayModeMedia: MediaQueryList[];
  private readonly viewportPositionRepairer: ViewportPositionRepairer;
  isMobileNavigationLayout: boolean;
  isPwaDisplayMode: boolean;

  constructor(private readonly host: ReactiveControllerHost, options: AppShellControllerOptions = {}) {
    host.addController(this);
    this.desktopSideBySideMedia = options.desktopSideBySideMedia ?? createLayoutMedia(DESKTOP_SIDE_BY_SIDE_MEDIA_QUERY);
    this.isDesktopSideBySideLayout = this.desktopSideBySideMedia?.matches ?? true;
    this.mobileNavigationMedia = options.mobileNavigationMedia ?? createLayoutMedia(MOBILE_NAVIGATION_MEDIA_QUERY);
    this.pwaDisplayModeMedia = options.pwaDisplayModeMedia ?? createPwaDisplayModeMedia();
    this.viewportPositionRepairer = options.viewportPositionRepairer ?? new ViewportPositionRepairer();
    this.isMobileNavigationLayout = this.mobileNavigationMedia?.matches ?? false;
    this.isPwaDisplayMode = detectPwaDisplayMode(this.pwaDisplayModeMedia);
  }

  hostConnected(): void {
    this.desktopSideBySideMedia?.addEventListener("change", this.onDesktopSideBySideMediaChange);
    this.mobileNavigationMedia?.addEventListener("change", this.onMobileNavigationMediaChange);
    for (const media of this.pwaDisplayModeMedia) media.addEventListener("change", this.onPwaDisplayModeChange);
  }

  hostDisconnected(): void {
    this.desktopSideBySideMedia?.removeEventListener("change", this.onDesktopSideBySideMediaChange);
    this.mobileNavigationMedia?.removeEventListener("change", this.onMobileNavigationMediaChange);
    for (const media of this.pwaDisplayModeMedia) media.removeEventListener("change", this.onPwaDisplayModeChange);
    this.viewportPositionRepairer.clear();
  }

  shouldAutoFocusPrompt(): boolean {
    return !this.isMobileNavigationLayout && !this.isPwaDisplayMode;
  }

  shouldShowAppRefreshInHeader(): boolean {
    return this.isPwaDisplayMode && !this.isMobileNavigationLayout;
  }

  shouldShowAppRefreshInContextBar(): boolean {
    return this.isPwaDisplayMode && this.isMobileNavigationLayout;
  }

  defaultRouteView(): AppState["mainView"] {
    return this.isMobileNavigationLayout ? "navigation" : "chat";
  }

  repairViewportPosition(): void {
    this.viewportPositionRepairer.repair(this.shouldRepairViewportPosition());
  }

  private shouldRepairViewportPosition(): boolean {
    return this.isMobileNavigationLayout || this.isPwaDisplayMode;
  }

  private readonly onDesktopSideBySideMediaChange = (event: MediaQueryListEvent) => {
    if (this.isDesktopSideBySideLayout === event.matches) return;
    this.isDesktopSideBySideLayout = event.matches;
    this.host.requestUpdate();
  };

  private readonly onMobileNavigationMediaChange = (event: MediaQueryListEvent) => {
    if (this.isMobileNavigationLayout === event.matches) return;
    this.isMobileNavigationLayout = event.matches;
    this.host.requestUpdate();
  };

  private readonly onPwaDisplayModeChange = () => {
    const isPwaDisplayMode = detectPwaDisplayMode(this.pwaDisplayModeMedia);
    if (this.isPwaDisplayMode === isPwaDisplayMode) return;
    this.isPwaDisplayMode = isPwaDisplayMode;
    this.host.requestUpdate();
  };
}

function createLayoutMedia(query: string): MediaQueryList | undefined {
  if (typeof window === "undefined" || !("matchMedia" in window)) return undefined;
  return window.matchMedia(query);
}
