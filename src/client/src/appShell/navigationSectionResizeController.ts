import type { ReactiveController, ReactiveControllerHost } from "lit";

export type ResizableNavigationSection = "projects" | "workspaces";
export type NavigationSectionSizeStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export interface NavigationSectionResizeControllerOptions {
  storage?: NavigationSectionSizeStorage;
}

export const NAVIGATION_SECTION_SIZE_STORAGE_KEY = "pi-web:navigation-section-sizes:v1";
export const NAVIGATION_SECTION_MIN_HEIGHT = 44;

type SectionHeights = Partial<Record<ResizableNavigationSection, number>>;

export class NavigationSectionResizeController implements ReactiveController {
  private readonly storage: NavigationSectionSizeStorage | undefined;
  private readonly heights: SectionHeights;

  constructor(private readonly host: ReactiveControllerHost, options: NavigationSectionResizeControllerOptions = {}) {
    this.storage = options.storage ?? browserStorage();
    this.heights = readHeights(this.storage);
    host.addController(this);
  }

  hostConnected(): void {
    return;
  }

  height(section: ResizableNavigationSection): number | undefined {
    return this.heights[section];
  }

  resize(section: ResizableNavigationSection, height: number): void {
    if (!Number.isFinite(height)) return;
    const nextHeight = clampHeight(height);
    if (this.heights[section] === nextHeight) return;
    this.heights[section] = nextHeight;
    this.persist();
    this.host.requestUpdate();
  }

  reset(section: ResizableNavigationSection): void {
    if (this.heights[section] === undefined) return;
    if (section === "projects") delete this.heights.projects;
    else delete this.heights.workspaces;
    this.persist();
    this.host.requestUpdate();
  }

  private persist(): void {
    try {
      if (this.heights.projects === undefined && this.heights.workspaces === undefined) {
        this.storage?.removeItem(NAVIGATION_SECTION_SIZE_STORAGE_KEY);
      } else {
        this.storage?.setItem(NAVIGATION_SECTION_SIZE_STORAGE_KEY, JSON.stringify({ version: 1, ...this.heights }));
      }
    } catch {
      // Like panel resizing, storage restrictions must not prevent resizing in this tab.
    }
  }
}

export function navigationSectionHeightFromDrag(startHeight: number, startClientY: number, currentClientY: number): number {
  return clampHeight(startHeight + currentClientY - startClientY);
}

export function navigationSectionHeightFromKeyboard(currentHeight: number, key: string, options: { largeStep?: boolean } = {}): number | undefined {
  if (key === "Home") return NAVIGATION_SECTION_MIN_HEIGHT;
  const step = options.largeStep === true ? 72 : 24;
  if (key === "ArrowUp") return clampHeight(currentHeight - step);
  if (key === "ArrowDown") return clampHeight(currentHeight + step);
  return undefined;
}

function clampHeight(height: number): number {
  return Number.isFinite(height) ? Math.max(NAVIGATION_SECTION_MIN_HEIGHT, Math.round(height)) : NAVIGATION_SECTION_MIN_HEIGHT;
}

function readHeights(storage: NavigationSectionSizeStorage | undefined): SectionHeights {
  try {
    const raw = storage?.getItem(NAVIGATION_SECTION_SIZE_STORAGE_KEY);
    if (raw === undefined || raw === null || raw === "") return {};
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value["version"] !== 1) return {};
    const heights: SectionHeights = {};
    for (const section of ["projects", "workspaces"] as const) {
      const height = value[section];
      if (typeof height === "number" && Number.isFinite(height)) heights[section] = clampHeight(height);
    }
    return heights;
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function browserStorage(): NavigationSectionSizeStorage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}
