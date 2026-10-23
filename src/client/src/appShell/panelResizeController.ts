import type { ReactiveController, ReactiveControllerHost } from "lit";

export type ResizablePanelSide = "navigation" | "workspace";

export interface PanelResizeConstraints {
  minWidth: number;
  maxWidth: number;
  defaultWidth: number;
  keyboardStep: number;
  largeKeyboardStep: number;
}

export interface PanelSizePreferences {
  navigationPanelWidth?: number;
  workspacePanelWidth?: number;
}

export interface PanelResizeControllerOptions {
  storage?: PanelSizeStorage;
}

export interface PanelResizeOptions {
  persist?: boolean;
}

export interface PanelResetOptions {
  persist?: boolean;
}

export interface PanelKeyboardResizeOptions {
  largeStep?: boolean;
  constraints?: PanelResizeConstraints;
}

export type PanelSizeStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type PanelResizeConstraintsBySide = Partial<Record<ResizablePanelSide, PanelResizeConstraints>>;

export const PANEL_SIZE_STORAGE_KEY = "pi-web:panel-sizes:v1";
export const PANEL_RESIZE_CONSTRAINTS = {
  navigation: { minWidth: 260, maxWidth: 4096, defaultWidth: 340, keyboardStep: 24, largeKeyboardStep: 72 },
  workspace: { minWidth: 240, maxWidth: 4096, defaultWidth: 480, keyboardStep: 24, largeKeyboardStep: 72 },
} as const satisfies Record<ResizablePanelSide, PanelResizeConstraints>;

interface StoredPanelSizeEnvelope {
  version: 1;
  navigationPanelWidth?: number;
  workspacePanelWidth?: number;
}

export class PanelResizeController implements ReactiveController {
  private readonly storage: PanelSizeStorage | undefined;
  private panelSizes: PanelSizePreferences;

  constructor(private readonly host: ReactiveControllerHost, options: PanelResizeControllerOptions = {}) {
    host.addController(this);
    this.storage = options.storage ?? browserPanelSizeStorage();
    this.panelSizes = readStoredPanelSizes(this.storage);
  }

  hostConnected(): void {
    return;
  }

  constraints(side: ResizablePanelSide): PanelResizeConstraints {
    return panelResizeConstraints(side);
  }

  panelWidth(side: ResizablePanelSide, measuredWidth?: number): number {
    return clampPanelWidth(side, measuredWidth ?? this.storedPanelWidth(side) ?? this.constraints(side).defaultWidth);
  }

  resizePanel(side: ResizablePanelSide, width: number, options: PanelResizeOptions = {}): void {
    const nextWidth = clampPanelWidth(side, width);
    if (this.storedPanelWidth(side) === nextWidth) return;
    this.panelSizes = panelSizesWithWidth(this.panelSizes, side, nextWidth);
    if (options.persist !== false) this.persistPanelSizes();
    this.host.requestUpdate();
  }

  resetPanel(side: ResizablePanelSide, options: PanelResetOptions = {}): void {
    if (this.storedPanelWidth(side) === undefined) return;
    this.panelSizes = panelSizesWithoutSide(this.panelSizes, side);
    if (options.persist !== false) this.persistPanelSizes();
    this.host.requestUpdate();
  }

  resetPanels(options: PanelResetOptions = {}): void {
    if (this.panelSizes.navigationPanelWidth === undefined && this.panelSizes.workspacePanelWidth === undefined) return;
    this.panelSizes = {};
    if (options.persist !== false) this.persistPanelSizes();
    this.host.requestUpdate();
  }

  persistPanelSizes(): void {
    writeStoredPanelSizes(this.panelSizes, this.storage);
  }

  shellStyle(constraintsBySide: PanelResizeConstraintsBySide = {}): string {
    const declarations: string[] = [];
    if (this.panelSizes.navigationPanelWidth !== undefined) {
      declarations.push(`--navigation-panel-size: ${formatPanelWidth(clampPanelWidth("navigation", this.panelSizes.navigationPanelWidth, constraintsBySide.navigation))};`);
    }
    if (this.panelSizes.workspacePanelWidth !== undefined) {
      declarations.push(`--workspace-panel-size: ${formatPanelWidth(clampPanelWidth("workspace", this.panelSizes.workspacePanelWidth, constraintsBySide.workspace))};`);
    }
    return declarations.join(" ");
  }

  private storedPanelWidth(side: ResizablePanelSide): number | undefined {
    return side === "navigation" ? this.panelSizes.navigationPanelWidth : this.panelSizes.workspacePanelWidth;
  }
}

export function panelResizeConstraints(side: ResizablePanelSide): PanelResizeConstraints {
  return PANEL_RESIZE_CONSTRAINTS[side];
}

export function panelResizeDelta(side: ResizablePanelSide, startClientX: number, currentClientX: number): number {
  return side === "navigation" ? currentClientX - startClientX : startClientX - currentClientX;
}

export function panelWidthFromDrag(side: ResizablePanelSide, startWidth: number, startClientX: number, currentClientX: number, constraints = panelResizeConstraints(side)): number {
  return clampPanelWidth(side, startWidth + panelResizeDelta(side, startClientX, currentClientX), constraints);
}

export function panelWidthFromKeyboard(side: ResizablePanelSide, currentWidth: number, key: string, options: PanelKeyboardResizeOptions = {}): number | undefined {
  const constraints = options.constraints ?? panelResizeConstraints(side);
  if (key === "Home") return constraints.minWidth;
  if (key === "End") return constraints.maxWidth;

  const step = options.largeStep === true ? constraints.largeKeyboardStep : constraints.keyboardStep;
  const delta = keyboardResizeDelta(side, key, step);
  if (delta === undefined) return undefined;
  return clampPanelWidth(side, currentWidth + delta, constraints);
}

export function clampPanelWidth(side: ResizablePanelSide, width: number, constraints = panelResizeConstraints(side)): number {
  if (!Number.isFinite(width)) return constraints.defaultWidth;
  return Math.round(Math.min(Math.max(width, constraints.minWidth), constraints.maxWidth));
}

export function readStoredPanelSizes(storage: PanelSizeStorage | undefined = browserPanelSizeStorage()): PanelSizePreferences {
  try {
    const raw = storage?.getItem(PANEL_SIZE_STORAGE_KEY);
    if (raw === undefined || raw === null || raw === "") return {};
    const value: unknown = JSON.parse(raw);
    return parseStoredPanelSizes(value);
  } catch {
    return {};
  }
}

export function writeStoredPanelSizes(panelSizes: PanelSizePreferences, storage: PanelSizeStorage | undefined = browserPanelSizeStorage()): void {
  if (storage === undefined) return;
  try {
    if (panelSizes.navigationPanelWidth === undefined && panelSizes.workspacePanelWidth === undefined) {
      storage.removeItem(PANEL_SIZE_STORAGE_KEY);
      return;
    }
    const envelope: StoredPanelSizeEnvelope = { version: 1 };
    if (panelSizes.navigationPanelWidth !== undefined) envelope.navigationPanelWidth = clampPanelWidth("navigation", panelSizes.navigationPanelWidth);
    if (panelSizes.workspacePanelWidth !== undefined) envelope.workspacePanelWidth = clampPanelWidth("workspace", panelSizes.workspacePanelWidth);
    storage.setItem(PANEL_SIZE_STORAGE_KEY, JSON.stringify(envelope));
  } catch {
    // Ignore localStorage quota/privacy errors; the resized layout still applies in memory for this tab.
  }
}

function parseStoredPanelSizes(value: unknown): PanelSizePreferences {
  if (!isRecord(value) || value["version"] !== 1) return {};
  const panelSizes: PanelSizePreferences = {};
  const navigationWidth = parseStoredPanelWidth(value["navigationPanelWidth"]);
  const workspaceWidth = parseStoredPanelWidth(value["workspacePanelWidth"]);
  if (navigationWidth !== undefined) panelSizes.navigationPanelWidth = clampPanelWidth("navigation", navigationWidth);
  if (workspaceWidth !== undefined) panelSizes.workspacePanelWidth = clampPanelWidth("workspace", workspaceWidth);
  return panelSizes;
}

function parseStoredPanelWidth(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function panelSizesWithWidth(panelSizes: PanelSizePreferences, side: ResizablePanelSide, width: number): PanelSizePreferences {
  if (side === "navigation") return { ...panelSizes, navigationPanelWidth: width };
  return { ...panelSizes, workspacePanelWidth: width };
}

function panelSizesWithoutSide(panelSizes: PanelSizePreferences, side: ResizablePanelSide): PanelSizePreferences {
  if (side === "navigation") {
    return panelSizes.workspacePanelWidth === undefined ? {} : { workspacePanelWidth: panelSizes.workspacePanelWidth };
  }
  return panelSizes.navigationPanelWidth === undefined ? {} : { navigationPanelWidth: panelSizes.navigationPanelWidth };
}

function keyboardResizeDelta(side: ResizablePanelSide, key: string, step: number): number | undefined {
  if (side === "navigation") {
    if (key === "ArrowRight") return step;
    if (key === "ArrowLeft") return -step;
    return undefined;
  }
  if (key === "ArrowLeft") return step;
  if (key === "ArrowRight") return -step;
  return undefined;
}

function formatPanelWidth(width: number): string {
  return `${String(Math.round(width))}px`;
}

function browserPanelSizeStorage(): PanelSizeStorage | undefined {
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
