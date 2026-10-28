// @vitest-environment happy-dom
import type { TemplateResult } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo, SessionStatus } from "../api";
import { initialAppState, type AppState } from "../appState";
// Template inspection is proportionate here because this test verifies only the
// sibling-component callback/property wiring in the existing unmounted harness.
import { templateText, templateValueAfterMarker } from "../templateInspection.testSupport";
import { PiWebApp } from "./PiWebApp";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const warningText = "subscription auth is active";

describe("PiWebApp session-warning visibility wiring", () => {
  it("keeps the warning control present and toggles the warning area from the status bar", () => {
    const app = createApp();
    const state = stateWithWarnings();
    setAppState(app, state);
    syncWarningVisibility(app);

    expect(warningAreaRendered(app)).toBe(true);
    expect(templateValueAfterMarker(renderStatusBar(app, state), ".warningCount=")).toBe(2);
    expect(templateValueAfterMarker(renderStatusBar(app, state), ".warningsExpanded=")).toBe(true);

    templateCallbackAfterMarker(renderStatusBar(app, state), ".onToggleWarnings=")();

    expect(warningAreaRendered(app)).toBe(false);
    expect(templateValueAfterMarker(renderStatusBar(app, state), ".warningCount=")).toBe(2);
    expect(templateValueAfterMarker(renderStatusBar(app, state), ".warningsExpanded=")).toBe(false);

    // A session without status keeps the visibility it was last given, so the
    // control must not flip to expanded just because no warnings arrived yet.
    const otherState = stateWithWarnings("session-2");
    setAppState(app, otherState);
    syncWarningVisibility(app);
    expect(warningAreaRendered(app)).toBe(true);
    expect(warningsCollapsed(app)).toBe(false);

    const returningState = { ...state, status: undefined };
    setAppState(app, returningState);
    syncWarningVisibility(app);
    expect(warningsCollapsed(app)).toBe(false);
    expect(templateValueAfterMarker(renderStatusBar(app, returningState), ".warningCount=")).toBe(0);

    setAppState(app, state);
    syncWarningVisibility(app);
    expect(warningAreaRendered(app)).toBe(false);
    expect(templateValueAfterMarker(renderStatusBar(app, state), ".warningCount=")).toBe(2);
    expect(templateValueAfterMarker(renderStatusBar(app, state), ".warningsExpanded=")).toBe(false);

    templateCallbackAfterMarker(renderStatusBar(app, state), ".onToggleWarnings=")();

    expect(warningAreaRendered(app)).toBe(true);
    expect(templateValueAfterMarker(renderStatusBar(app, state), ".warningCount=")).toBe(2);
    expect(templateValueAfterMarker(renderStatusBar(app, state), ".warningsExpanded=")).toBe(true);
  });
});

type RenderStatusBar = (this: PiWebApp, state: AppState) => TemplateResult;
type SyncWarningVisibility = (this: PiWebApp) => void;
type WarningVisibilityCallback = () => void;

function createApp(): PiWebApp {
  const storage = {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  };
  vi.stubGlobal("window", { location: { search: "" }, localStorage: storage });
  return new PiWebApp();
}

function stateWithWarnings(sessionId = "session-1"): AppState {
  const selectedSession: SessionInfo = {
    id: sessionId,
    cwd: "/repo",
    path: `/repo/${sessionId}.jsonl`,
    created: "2026-07-14T00:00:00.000Z",
    modified: "2026-07-14T00:00:00.000Z",
    messageCount: 1,
    firstMessage: "hello",
  };
  return {
    ...initialAppState(),
    selectedSession,
    status: warningStatus(sessionId),
  };
}

function warningStatus(sessionId: string): SessionStatus {
  return {
    sessionId,
    isStreaming: true,
    isCompacting: false,
    isBashRunning: false,
    pendingMessageCount: 0,
    queuedMessages: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
    warnings: [
      { severity: "warning", message: warningText },
      { severity: "error", message: "skill failed to load" },
    ],
  };
}

function setAppState(app: PiWebApp, state: AppState): void {
  if (!Reflect.set(app, "state", state)) throw new Error("Could not set PiWebApp state");
}

function syncWarningVisibility(app: PiWebApp): void {
  const method: unknown = Reflect.get(app, "syncSessionWarningVisibility");
  if (!isSyncWarningVisibility(method)) throw new Error("PiWebApp.syncSessionWarningVisibility is not callable");
  method.call(app);
}

/** The warnings ride in the app's own top chrome, so the shell render owns them. */
function warningAreaRendered(app: PiWebApp): boolean {
  return renderApp(app).includes(warningText);
}

function warningsCollapsed(app: PiWebApp): boolean {
  const visibility: unknown = Reflect.get(app, "sessionWarningVisibility");
  const collapsed: unknown = typeof visibility === "object" && visibility !== null
    ? Reflect.get(visibility, "collapsed")
    : undefined;
  if (typeof collapsed !== "boolean") throw new Error("PiWebApp.sessionWarningVisibility is not readable");
  return collapsed;
}

function renderApp(app: PiWebApp): string {
  const render: unknown = Reflect.get(app, "render");
  if (typeof render !== "function") throw new Error("PiWebApp.render is not callable");
  return templateText(render.call(app));
}

function renderStatusBar(app: PiWebApp, state: AppState): TemplateResult {
  const method: unknown = Reflect.get(app, "renderStatusBar");
  if (!isRenderStatusBar(method)) throw new Error("PiWebApp.renderStatusBar is not callable");
  return method.call(app, state);
}

function templateCallbackAfterMarker(template: TemplateResult, marker: string): WarningVisibilityCallback {
  const value = templateValueAfterMarker(template, marker);
  if (!isWarningVisibilityCallback(value)) throw new Error(`Expected callback after ${marker}`);
  return value;
}

function isRenderStatusBar(value: unknown): value is RenderStatusBar {
  return typeof value === "function";
}

function isSyncWarningVisibility(value: unknown): value is SyncWarningVisibility {
  return typeof value === "function";
}

function isWarningVisibilityCallback(value: unknown): value is WarningVisibilityCallback {
  return typeof value === "function";
}
