import type { TemplateResult } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionDialogAnswer, PendingExtensionDialog, SessionInfo, SessionStatus } from "../api";
import { initialAppState, type AppState, type ClosedExtensionDialog } from "../appState";
import { SessionController } from "../controllers/sessionController";
// Template inspection here is the escape hatch for verifying the chat-view
// dialog callback wiring in a node environment (no DOM harness), mirroring
// PiWebApp.clearQueue.test.ts. See templateInspection.testSupport for the
// proportionality rationale.
import { templateValueAfterMarker } from "../templateInspection.testSupport";
import { PiWebApp } from "./PiWebApp";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PiWebApp extension-dialog wiring", () => {
  it("passes dialog state and stable SessionController callbacks through to chat-view", () => {
    const app = createApp();
    const state = stateWithDialogs();
    setAppState(app, state);
    const controller = appSessionController(app);
    const answerDialog = vi.spyOn(controller, "answerDialog").mockResolvedValue(undefined);
    const cancelDialog = vi.spyOn(controller, "cancelDialog").mockResolvedValue(undefined);
    const dismissClosedDialog = vi.spyOn(controller, "dismissClosedDialog").mockReturnValue(undefined);

    const firstRender = renderChatView(app, state);
    const secondRender = renderChatView(app, state);
    const onAnswer = templateDialogCallback(firstRender, ".onAnswerDialog=");
    const onCancel = templateDialogCallback(firstRender, ".onCancelDialog=");
    const onDismiss = templateDialogCallback(firstRender, ".onDismissClosedDialog=");

    expect(templateValueAfterMarker(firstRender, ".pendingDialogs=")).toBe(state.pendingDialogs);
    expect(templateValueAfterMarker(firstRender, ".closedDialogs=")).toBe(state.closedDialogs);
    expect(templateDialogCallback(secondRender, ".onAnswerDialog=")).toBe(onAnswer);
    expect(templateDialogCallback(secondRender, ".onCancelDialog=")).toBe(onCancel);
    expect(templateDialogCallback(secondRender, ".onDismissClosedDialog=")).toBe(onDismiss);

    onAnswer("dlg-1", true);
    onCancel("dlg-2");
    onDismiss("dlg-0");
    expect(answerDialog).toHaveBeenCalledWith("dlg-1", true);
    expect(cancelDialog).toHaveBeenCalledWith("dlg-2");
    expect(dismissClosedDialog).toHaveBeenCalledWith("dlg-0");
  });
});

type RenderChatView = (this: PiWebApp, state: AppState, session: SessionInfo) => TemplateResult;
type DialogCallback = (dialogId: string, value?: ExtensionDialogAnswer) => void;

function createApp(): PiWebApp {
  const storage = {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  };
  vi.stubGlobal("window", { location: { search: "" }, localStorage: storage });
  return new PiWebApp();
}

function stateWithDialogs(): AppState {
  const session: SessionInfo = {
    id: "session-1",
    cwd: "/repo",
    path: "/repo/session-1.jsonl",
    created: "2026-07-27T00:00:00.000Z",
    modified: "2026-07-27T00:00:00.000Z",
    messageCount: 1,
    firstMessage: "hello",
  };
  const open: PendingExtensionDialog = {
    dialogId: "dlg-1",
    kind: "confirm",
    title: "Allow file writes?",
    askedAt: "2026-07-27T10:00:00.000Z",
    runScoped: false,
  };
  const closed: ClosedExtensionDialog = {
    dialog: { ...open, dialogId: "dlg-0", title: "Allow reads?" },
    reason: "answered",
    answer: true,
  };
  return {
    ...initialAppState(),
    selectedSession: session,
    status: dialogStatus(),
    pendingDialogs: [open],
    closedDialogs: [closed],
  };
}

function dialogStatus(): SessionStatus {
  return {
    sessionId: "session-1",
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    pendingMessageCount: 0,
    queuedMessages: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
  };
}

function setAppState(app: PiWebApp, state: AppState): void {
  if (!Reflect.set(app, "state", state)) throw new Error("Could not set PiWebApp state");
}

function appSessionController(app: PiWebApp): SessionController {
  const controller: unknown = Reflect.get(app, "sessions");
  if (!(controller instanceof SessionController)) throw new Error("PiWebApp SessionController was unavailable");
  return controller;
}

function renderChatView(app: PiWebApp, state: AppState): TemplateResult {
  const method: unknown = Reflect.get(app, "renderChatView");
  if (!isRenderChatView(method)) throw new Error("PiWebApp.renderChatView is not callable");
  const session = state.selectedSession;
  if (session === undefined) throw new Error("Expected a selected session");
  return method.call(app, state, session);
}

function isRenderChatView(value: unknown): value is RenderChatView {
  return typeof value === "function";
}

function templateDialogCallback(template: TemplateResult, marker: string): DialogCallback {
  const value = templateValueAfterMarker(template, marker);
  if (!isDialogCallback(value)) throw new Error(`Expected callback after ${marker}`);
  return value;
}

function isDialogCallback(value: unknown): value is DialogCallback {
  return typeof value === "function";
}
