// @vitest-environment happy-dom

import type { TemplateResult } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "../api";
import { initialAppState, type AppState } from "../appState";
import { AuthController } from "../controllers/authController";
import { SessionController } from "../controllers/sessionController";
import type { ReviewController, ReviewSendSnapshot } from "../controllers/reviewController";
import { templateValueAfterMarker } from "../templateInspection.testSupport";
import { PiWebApp } from "./PiWebApp";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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

function setAppState(app: PiWebApp, state: AppState): void {
  if (!Reflect.set(app, "state", state)) throw new Error("Could not set PiWebApp state");
}

function isAppState(value: unknown): value is AppState {
  return typeof value === "object" && value !== null && "reviewComments" in value;
}

function appState(app: PiWebApp): AppState {
  const state: unknown = Reflect.get(app, "state");
  if (!isAppState(state)) throw new Error("PiWebApp state was unavailable");
  return state;
}

function appSessionController(app: PiWebApp): SessionController {
  const controller: unknown = Reflect.get(app, "sessions");
  if (!(controller instanceof SessionController)) throw new Error("PiWebApp SessionController was unavailable");
  return controller;
}

function appAuthController(app: PiWebApp): AuthController {
  const controller: unknown = Reflect.get(app, "auth");
  if (!(controller instanceof AuthController)) throw new Error("PiWebApp AuthController was unavailable");
  return controller;
}

function isReviewController(value: unknown): value is ReviewController {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "beginSend") === "function";
}

function appReviewController(app: PiWebApp): ReviewController {
  const controller: unknown = Reflect.get(app, "reviewController");
  if (!isReviewController(controller)) throw new Error("PiWebApp ReviewController was unavailable");
  return controller;
}

function sessionInfo(id: string): SessionInfo {
  return {
    id,
    cwd: "/repo",
    path: `/tmp/${id}.jsonl`,
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:00.000Z",
    messageCount: 0,
    firstMessage: "",
  };
}

type SendPromptFn = (
  text: string,
  streamingBehavior?: "steer" | "followUp",
  attachments?: unknown,
  delivery?: unknown,
  folderOrReview?: string | boolean,
  hasReviewContent?: boolean,
) => Promise<boolean>;

function isSendPromptFn(value: unknown): value is SendPromptFn {
  return typeof value === "function";
}

function callSendPrompt(app: PiWebApp, ...args: Parameters<SendPromptFn>): Promise<boolean> {
  const method: unknown = Reflect.get(app, "sendPrompt");
  if (!isSendPromptFn(method)) throw new Error("PiWebApp.sendPrompt was unavailable");
  return method.apply(app, args);
}

function appHandleSendPrompt(app: PiWebApp): SendPromptFn {
  const handler: unknown = Reflect.get(app, "handleSendPrompt");
  if (!isSendPromptFn(handler)) throw new Error("PiWebApp.handleSendPrompt was unavailable");
  return handler;
}

function renderApp(app: PiWebApp): TemplateResult {
  return app.render();
}

function isReviewIdRemover(value: unknown): value is (id: string) => void {
  return typeof value === "function";
}

function isReviewBeginSend(value: unknown): value is () => ReviewSendSnapshot {
  return typeof value === "function";
}

function isReviewIdsCallback(value: unknown): value is (ids: string[]) => void {
  return typeof value === "function";
}

function isReviewAbortSend(value: unknown): value is () => void {
  return typeof value === "function";
}

function seedOneReviewComment(controller: ReviewController): void {
  controller.beginSelection("src/a.ts", { side: "new", line: 1 });
  controller.commitSelection("hash-1");
  controller.setDraftBody("looks good");
  controller.submitDraft();
}

describe("PiWebApp.sendPrompt hasReviewContent threading", () => {
  it("bypasses the auth slash-command gate and forwards hasReviewContent to sessions.send", async () => {
    const app = createApp();
    setAppState(app, { ...initialAppState(), selectedSession: sessionInfo("session-1") });
    const auth = appAuthController(app);
    const handleSlashCommand = vi.spyOn(auth, "handleSlashCommand");
    const send = vi.spyOn(appSessionController(app), "send").mockResolvedValue(true);

    const result = await callSendPrompt(app, "/login", undefined, undefined, undefined, true);

    expect(handleSlashCommand).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith("/login", undefined, undefined, undefined, undefined, true);
    expect(result).toBe(true);
  });

  it("still lets the auth slash-command gate short-circuit plain (non-review) sends", async () => {
    const app = createApp();
    setAppState(app, { ...initialAppState(), selectedSession: sessionInfo("session-1") });
    const auth = appAuthController(app);
    vi.spyOn(auth, "handleSlashCommand").mockReturnValue(true);
    const send = vi.spyOn(appSessionController(app), "send").mockResolvedValue(true);

    const result = await callSendPrompt(app, "/login");

    expect(send).not.toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it("propagates sessions.send's resolved value", async () => {
    const app = createApp();
    setAppState(app, { ...initialAppState(), selectedSession: sessionInfo("session-1") });
    vi.spyOn(appSessionController(app), "send").mockResolvedValue(false);

    await expect(callSendPrompt(app, "hello")).resolves.toBe(false);
  });
});

describe("PiWebApp.handleSendPrompt", () => {
  it("awaits sendPrompt and resolves its boolean result", async () => {
    const app = createApp();
    setAppState(app, { ...initialAppState(), selectedSession: sessionInfo("session-1") });
    vi.spyOn(appSessionController(app), "send").mockResolvedValue(true);

    const handler = appHandleSendPrompt(app);
    await expect(handler("hello", undefined, undefined, undefined, true)).resolves.toBe(true);
  });
});

describe("PiWebApp <prompt-editor> review wiring", () => {
  it("passes reviewComments/reviewSendLocked from state and delegates onReviewRemove to the ReviewController", () => {
    const app = createApp();
    const controller = appReviewController(app);
    setAppState(app, { ...initialAppState(), selectedSession: sessionInfo("session-1") });
    seedOneReviewComment(controller);
    const state = appState(app);
    expect(state.reviewComments).toHaveLength(1);

    const template = renderApp(app);

    expect(templateValueAfterMarker(template, ".reviewComments=")).toBe(state.reviewComments);
    expect(templateValueAfterMarker(template, ".reviewSendLocked=")).toBe(state.reviewSendLocked);

    const onReviewRemove = templateValueAfterMarker(template, ".onReviewRemove=");
    if (!isReviewIdRemover(onReviewRemove)) throw new Error("Expected onReviewRemove callback");
    const [comment] = state.reviewComments;
    if (comment === undefined) throw new Error("Expected a review comment");
    onReviewRemove(comment.id);
    expect(appState(app).reviewComments).toHaveLength(0);
  });

  it("wires onReviewBeginSend/onReviewCompleteSend to the ReviewController send lifecycle", () => {
    const app = createApp();
    const controller = appReviewController(app);
    setAppState(app, { ...initialAppState(), selectedSession: sessionInfo("session-1") });
    seedOneReviewComment(controller);
    const template = renderApp(app);

    const onReviewBeginSend = templateValueAfterMarker(template, ".onReviewBeginSend=");
    const onReviewCompleteSend = templateValueAfterMarker(template, ".onReviewCompleteSend=");
    if (!isReviewBeginSend(onReviewBeginSend) || !isReviewIdsCallback(onReviewCompleteSend)) {
      throw new Error("Expected onReviewBeginSend/onReviewCompleteSend callbacks");
    }
    const snapshot = onReviewBeginSend();
    expect(appState(app).reviewSendLocked).toBe(true);

    onReviewCompleteSend(snapshot.ids);
    expect(appState(app).reviewSendLocked).toBe(false);
    expect(appState(app).reviewComments).toHaveLength(0);
  });

  it("wires onReviewAbortSend to unlock without clearing comments", () => {
    const app = createApp();
    const controller = appReviewController(app);
    setAppState(app, { ...initialAppState(), selectedSession: sessionInfo("session-1") });
    seedOneReviewComment(controller);
    const template = renderApp(app);

    const onReviewBeginSend = templateValueAfterMarker(template, ".onReviewBeginSend=");
    const onReviewAbortSend = templateValueAfterMarker(template, ".onReviewAbortSend=");
    if (!isReviewBeginSend(onReviewBeginSend) || !isReviewAbortSend(onReviewAbortSend)) {
      throw new Error("Expected onReviewBeginSend/onReviewAbortSend callbacks");
    }
    onReviewBeginSend();
    expect(appState(app).reviewSendLocked).toBe(true);

    onReviewAbortSend();
    expect(appState(app).reviewSendLocked).toBe(false);
    expect(appState(app).reviewComments).toHaveLength(1);
  });
});
