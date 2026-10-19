// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialAppState, type AppState } from "../appState";
import type { SessionInfo, SessionStatus } from "../api";
import { templateText } from "../templateInspection.testSupport";
import { PiWebApp } from "./PiWebApp";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PiWebApp chat chrome auto-hide wiring", () => {
  function createApp(): PiWebApp {
    const app = new PiWebApp();
    // happy-dom has no layout, so stub the one DOM call the top-level render
    // template makes while computing resizable panel widths.
    app.getBoundingClientRect = () => ({ width: 1200, height: 800, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) });
    return app;
  }

  function selectedSessionState(): AppState {
    const session: SessionInfo = {
      id: "session-1",
      cwd: "/repo",
      path: "/repo/session-1.jsonl",
      created: "2026-07-14T00:00:00.000Z",
      modified: "2026-07-14T00:00:00.000Z",
      messageCount: 1,
      firstMessage: "hello",
    };
    const status: SessionStatus = {
      sessionId: "session-1",
      isStreaming: false,
      isCompacting: false,
      isBashRunning: false,
      pendingMessageCount: 0,
      queuedMessages: [],
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
    };
    return { ...initialAppState(), selectedSession: session, status };
  }

  function setAppState(app: PiWebApp, state: AppState): void {
    if (!Reflect.set(app, "state", state)) throw new Error("Could not set PiWebApp state");
  }

  function renderApp(app: PiWebApp): string {
    const render = Reflect.get(app, "render");
    if (typeof render !== "function") throw new Error("PiWebApp.render is not callable");
    return templateText(render.call(app));
  }

  function emitChromeVisibility(app: PiWebApp, hidden: boolean): void {
    callAppHandler(app, "handleChatChromeVisibility", { detail: { hidden } });
  }

  function callAppHandler(app: PiWebApp, handlerName: string, event: unknown): void {
    const handler: unknown = Object.getOwnPropertyDescriptor(app, handlerName)?.value;
    if (typeof handler !== "function") throw new Error(`PiWebApp.${handlerName} is not callable`);
    handler.call(app, event);
  }

  function callAppMethod(app: PiWebApp, methodName: string): void {
    let target: object | null = app;
    while (target !== null) {
      const value: unknown = Object.getOwnPropertyDescriptor(target, methodName)?.value;
      if (typeof value === "function") {
        value.call(app);
        return;
      }
      target = Reflect.getPrototypeOf(target);
    }
    throw new Error(`PiWebApp.${methodName} is not callable`);
  }

  it("slides the chrome out of the way when the chat reports a hide", () => {
    const app = createApp();
    setAppState(app, selectedSessionState());

    emitChromeVisibility(app, true);

    expect(renderApp(app)).toContain("chrome-hidden");
  });

  it("brings the chrome back into view when the chat reports a reveal", () => {
    const app = createApp();
    setAppState(app, selectedSessionState());
    emitChromeVisibility(app, true);

    emitChromeVisibility(app, false);

    expect(renderApp(app)).not.toContain("chrome-hidden");
  });

  it("keeps the input area visible while the composer is focused", () => {
    const app = createApp();
    setAppState(app, selectedSessionState());
    const focusedEditor = { contains: () => true };
    Object.defineProperty(app, "promptEditor", { value: focusedEditor, configurable: true, writable: true });

    emitChromeVisibility(app, true);

    expect(renderApp(app)).not.toContain("chrome-hidden");
  });

  it("floats the composer inside the bottom chrome group", () => {
    const app = createApp();
    setAppState(app, selectedSessionState());

    const markup = renderApp(app);

    expect(markup).toContain('class="bottom-chrome"');
    expect(markup).toContain("composer-area");
  });

  it("floats the context bar and mobile tabs inside the top chrome group", () => {
    const app = createApp();
    setAppState(app, selectedSessionState());

    expect(renderApp(app)).toContain('class="top-chrome"');
  });

  it("publishes the floating top chrome height as the transcript's top inset", () => {
    const app = createApp();
    setAppState(app, selectedSessionState());
    Object.defineProperty(app, "chromeTop", { value: { getBoundingClientRect: () => ({ height: 72 }) }, configurable: true, writable: true });

    callAppMethod(app, "measureChatChromeTop");

    expect(app.style.getPropertyValue("--pi-chat-top-inset")).toBe("72px");
    expect(Reflect.get(app, "chatChromeTopInset")).toBe(72);
  });
});
