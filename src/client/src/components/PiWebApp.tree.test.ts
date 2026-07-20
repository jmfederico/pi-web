import type { TemplateResult } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionTreeNavigateResult, SessionTreeSnapshot, SessionTreeSummaryChoice } from "../api";
import { initialAppState, type AppState } from "../appState";
import { SessionController } from "../controllers/sessionController";
// This node-environment test uses the shared, type-guarded template inspection
// escape hatch only to verify PiWebApp's navigator callback boundary.
import { templateValueAfterMarker } from "../templateInspection.testSupport";
import { PiWebApp } from "./PiWebApp";

type NavigateHandler = (targetId: string, summaryChoice: SessionTreeSummaryChoice) => Promise<SessionTreeNavigateResult>;
type AbortHandler = () => Promise<void>;
type CancelHandler = () => void;
type RenderSessionTreeNavigator = (this: PiWebApp, state: AppState) => TemplateResult | null;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PiWebApp session tree wiring", () => {
  it("routes navigation, cancellation, abort, and prompt focus through SessionController", async () => {
    const app = createApp();
    const state = setAppTree(app, tree());
    const controller = appSessionController(app);
    const navigateTree = vi.spyOn(controller, "navigateTree")
      .mockResolvedValueOnce({ cancelled: false, editorText: "edit" })
      .mockResolvedValueOnce({ cancelled: true, aborted: true });
    const abortTreeNavigation = vi.spyOn(controller, "abortTreeNavigation").mockResolvedValue(undefined);
    const closeTreeDialog = vi.spyOn(controller, "closeTreeDialog").mockReturnValue(undefined);
    const focusChatComposer = vi.fn(() => Promise.resolve());
    if (!Reflect.set(app, "focusChatComposer", focusChatComposer)) throw new Error("Could not replace prompt focus boundary");

    const rendered = renderSessionTreeNavigator(app, state);
    const onNavigate = navigatorNavigateHandler(rendered);
    const onAbort = navigatorAbortHandler(rendered);
    const onCancel = navigatorCancelHandler(rendered);

    await expect(onNavigate("side", { mode: "none" })).resolves.toEqual({ cancelled: false, editorText: "edit" });
    expect(navigateTree).toHaveBeenNthCalledWith(1, "side", { mode: "none" });
    expect(focusChatComposer).toHaveBeenCalledOnce();

    await expect(onNavigate("root", { mode: "default" })).resolves.toEqual({ cancelled: true, aborted: true });
    expect(focusChatComposer).toHaveBeenCalledOnce();

    await onAbort();
    expect(abortTreeNavigation).toHaveBeenCalledOnce();

    onCancel();
    expect(closeTreeDialog).toHaveBeenCalledOnce();
    expect(focusChatComposer).toHaveBeenCalledTimes(2);
  });

  it("does not steal focus after the user selects another session during navigation", async () => {
    const app = createApp();
    const state = setAppTree(app, tree());
    const controller = appSessionController(app);
    const result = deferred<SessionTreeNavigateResult>();
    vi.spyOn(controller, "navigateTree").mockReturnValue(result.promise);
    const focusChatComposer = vi.fn(() => Promise.resolve());
    if (!Reflect.set(app, "focusChatComposer", focusChatComposer)) throw new Error("Could not replace prompt focus boundary");
    const onNavigate = navigatorNavigateHandler(renderSessionTreeNavigator(app, state));

    const navigation = onNavigate("side", { mode: "none" });
    const otherSession = state.selectedSession === undefined ? undefined : { ...state.selectedSession, id: "session-2" };
    if (!Reflect.set(app, "state", { ...state, selectedSession: otherSession })) throw new Error("Could not change selected session");
    result.resolve({ cancelled: false });
    await navigation;

    expect(focusChatComposer).not.toHaveBeenCalled();
  });
});

function createApp(): PiWebApp {
  const storage = {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  };
  vi.stubGlobal("window", { location: { search: "" }, localStorage: storage });
  return new PiWebApp();
}

function setAppTree(app: PiWebApp, treeSnapshot: SessionTreeSnapshot): AppState {
  const selectedSession = {
    id: "session-1",
    path: "/tmp/session-1.jsonl",
    cwd: "/repo",
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:00.000Z",
    messageCount: 2,
    firstMessage: "Initial prompt",
  };
  const state = { ...initialAppState(), selectedSession, sessions: [selectedSession], treeDialog: treeSnapshot };
  if (!Reflect.set(app, "state", state)) throw new Error("Could not set PiWebApp tree state");
  return state;
}

function renderSessionTreeNavigator(app: PiWebApp, state: AppState): TemplateResult {
  const method: unknown = Reflect.get(app, "renderSessionTreeNavigator");
  if (!isRenderSessionTreeNavigator(method)) throw new Error("PiWebApp.renderSessionTreeNavigator was unavailable");
  const rendered = method.call(app, state);
  if (rendered === null) throw new Error("Expected a rendered session tree navigator");
  return rendered;
}

function appSessionController(app: PiWebApp): SessionController {
  const controller: unknown = Reflect.get(app, "sessions");
  if (!(controller instanceof SessionController)) throw new Error("PiWebApp SessionController was unavailable");
  return controller;
}

function navigatorNavigateHandler(template: TemplateResult): NavigateHandler {
  const value = templateValueAfterMarker(template, ".onNavigate=");
  if (!isNavigateHandler(value)) throw new Error("Session tree navigate callback was unavailable");
  return value;
}

function navigatorAbortHandler(template: TemplateResult): AbortHandler {
  const value = templateValueAfterMarker(template, ".onAbort=");
  if (!isAbortHandler(value)) throw new Error("Session tree abort callback was unavailable");
  return value;
}

function navigatorCancelHandler(template: TemplateResult): CancelHandler {
  const value = templateValueAfterMarker(template, ".onCancel=");
  if (!isCancelHandler(value)) throw new Error("Session tree cancel callback was unavailable");
  return value;
}

function isRenderSessionTreeNavigator(value: unknown): value is RenderSessionTreeNavigator {
  return typeof value === "function";
}

function isNavigateHandler(value: unknown): value is NavigateHandler {
  return typeof value === "function";
}

function isAbortHandler(value: unknown): value is AbortHandler {
  return typeof value === "function";
}

function isCancelHandler(value: unknown): value is CancelHandler {
  return typeof value === "function";
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function tree(): SessionTreeSnapshot {
  return {
    nodes: [
      { id: "root", parentId: null, kind: "user", summary: "Initial prompt" },
      { id: "side", parentId: "root", kind: "assistant", summary: "Side branch" },
    ],
    activeLeafId: "side",
    activePathIds: ["root", "side"],
  };
}
