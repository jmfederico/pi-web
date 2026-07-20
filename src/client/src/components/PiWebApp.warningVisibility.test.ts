import type { TemplateResult } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo, SessionStatus } from "../api";
import { initialAppState, type AppState } from "../appState";
// Template inspection is proportionate here because this test verifies only the
// sibling-component callback/property wiring in a node environment without DOM.
import { templateValueAfterMarker } from "../templateInspection.testSupport";
import { PiWebApp } from "./PiWebApp";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PiWebApp session-warning visibility wiring", () => {
  it("collapses the existing warning area and restores it from the status bar", () => {
    const app = createApp();
    const state = stateWithWarnings();
    setAppState(app, state);
    syncWarningVisibility(app);

    const visibleChat = renderChatView(app, state);
    expect(templateValueAfterMarker(visibleChat, ".warningsVisible=")).toBe(true);

    const collapse = templateCallbackAfterMarker(visibleChat, ".onCollapseWarnings=");
    collapse();

    const collapsedChat = renderChatView(app, state);
    expect(templateValueAfterMarker(collapsedChat, ".warningsVisible=")).toBe(false);
    expect(templateValueAfterMarker(renderStatusBar(app, state), ".collapsedWarningCount=")).toBe(2);

    const otherState = stateWithWarnings("session-2");
    setAppState(app, otherState);
    syncWarningVisibility(app);
    expect(templateValueAfterMarker(renderChatView(app, otherState), ".warningsVisible=")).toBe(true);

    const returningState = { ...state, status: undefined };
    setAppState(app, returningState);
    syncWarningVisibility(app);
    expect(templateValueAfterMarker(renderChatView(app, returningState), ".warningsVisible=")).toBe(true);

    setAppState(app, state);
    syncWarningVisibility(app);
    const returnedStatusBar = renderStatusBar(app, state);
    expect(templateValueAfterMarker(renderChatView(app, state), ".warningsVisible=")).toBe(false);
    expect(templateValueAfterMarker(returnedStatusBar, ".collapsedWarningCount=")).toBe(2);

    const restore = templateCallbackAfterMarker(returnedStatusBar, ".onRestoreWarnings=");
    restore();

    expect(templateValueAfterMarker(renderChatView(app, state), ".warningsVisible=")).toBe(true);
    expect(templateValueAfterMarker(renderStatusBar(app, state), ".collapsedWarningCount=")).toBe(0);
  });
});

type RenderChatView = (this: PiWebApp, state: AppState, session: SessionInfo) => TemplateResult;
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
      { severity: "warning", message: "subscription auth is active" },
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

function renderChatView(app: PiWebApp, state: AppState): TemplateResult {
  const method: unknown = Reflect.get(app, "renderChatView");
  if (!isRenderChatView(method)) throw new Error("PiWebApp.renderChatView is not callable");
  const session = state.selectedSession;
  if (session === undefined) throw new Error("Expected a selected session");
  return method.call(app, state, session);
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

function isRenderChatView(value: unknown): value is RenderChatView {
  return typeof value === "function";
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
