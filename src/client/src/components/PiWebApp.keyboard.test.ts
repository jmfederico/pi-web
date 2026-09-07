// @vitest-environment happy-dom

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "../api";
import { initialAppState, type AppState } from "../appState";
import { AuthDialog } from "./AuthDialog";
import { ChatView } from "./ChatView";
import { ModalSurface } from "./ModalSurface";
import { PiWebApp } from "./PiWebApp";

const IMAGE_DATA = "iVBORw0KGgo=";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PiWebApp global shortcut modality boundary", () => {
  it("runs a global shortcut when the application has no rendered modal", () => {
    const app = new PiWebApp();
    const target = appendKeyTarget();
    const targetKeyDown = vi.fn();
    target.addEventListener("keydown", targetKeyDown);

    const event = dispatchShortcutThroughApp(app, target);

    expect(actionPaletteIsOpen(app)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(targetKeyDown).not.toHaveBeenCalled();
  });

  it("leaves capture-phase keyboard handling with a rendered shared modal", async () => {
    const app = new PiWebApp();
    const target = await openAuthenticationDialog(app);
    const targetKeyDown = vi.fn();
    target.addEventListener("keydown", targetKeyDown);

    const event = dispatchShortcutThroughApp(app, target);

    expect(actionPaletteIsOpen(app)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(targetKeyDown).toHaveBeenCalledOnce();
  });

  it.each([
    { name: "native image zoom", open: openImageZoom },
    { name: "composed native dialog", open: openComposedNativeDialog },
  ])("leaves capture-phase keyboard handling with the $name", async ({ open }) => {
    const app = new PiWebApp();
    const target = await open(app);
    const targetKeyDown = vi.fn();
    target.addEventListener("keydown", targetKeyDown);

    const event = dispatchShortcutThroughApp(app, target);

    expect(actionPaletteIsOpen(app)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(targetKeyDown).toHaveBeenCalledOnce();
  });

  it("does not suppress shortcuts for session-scoped state that cannot render", () => {
    const app = new PiWebApp();
    setAppState(app, { modelDialog: { instanceId: 1, origin: { machineId: "local", sessionId: "session-1", cwd: "/repo" }, title: "Select model", options: [], catalog: [] } });
    const target = appendKeyTarget();

    const event = dispatchShortcutThroughApp(app, target);

    expect(actionPaletteIsOpen(app)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
  });

  it("does not automatically focus the prompt while a rendered modal remains open", async () => {
    const app = new PiWebApp();
    const appShell: unknown = Reflect.get(app, "appShell");
    if (!isAutoFocusAppShell(appShell)) throw new Error("PiWebApp shell was unavailable");
    vi.spyOn(appShell, "shouldAutoFocusPrompt").mockReturnValue(true);

    expect(appShouldAutoFocusPrompt(app)).toBe(true);
    await openAuthenticationDialog(app);

    expect(appShouldAutoFocusPrompt(app)).toBe(false);
  });

  it("rechecks rendered modality before a delayed prompt focus takes effect", async () => {
    const app = new PiWebApp();
    setAppState(app, { mainView: "chat" });
    const focusInput = vi.fn();
    Object.defineProperty(app, "promptEditor", { configurable: true, value: { focusInput } });
    Object.defineProperty(app, "updateComplete", { configurable: true, value: Promise.resolve(true) });
    let frameCallback: FrameRequestCallback | undefined;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frameCallback = callback;
      return 1;
    });

    const focusing = focusChatComposer(app);
    await vi.waitFor(() => { expect(frameCallback).toBeDefined(); });

    const surface = new ModalSurface();
    surface.initialFocus = "button";
    surface.innerHTML = "<button>Surviving modal</button>";
    document.body.append(surface);
    await surface.updateComplete;
    const modalButton = requiredElement(surface.querySelector<HTMLButtonElement>("button"), "surviving modal button");
    expect(document.activeElement).toBe(modalButton);

    frameCallback?.(performance.now());
    await focusing;

    expect(focusInput).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(modalButton);
  });
});

type AppKeyDownHandler = (event: KeyboardEvent) => void;
type FocusChatComposer = (this: PiWebApp) => Promise<void>;

interface AutoFocusAppShell {
  shouldAutoFocusPrompt: () => boolean;
}

function dispatchShortcutThroughApp(app: PiWebApp, target: HTMLElement): KeyboardEvent {
  const handler: unknown = Reflect.get(app, "onKeyDown");
  if (!isAppKeyDownHandler(handler)) throw new Error("PiWebApp shortcut handler was unavailable");
  window.addEventListener("keydown", handler, { capture: true });
  const event = new KeyboardEvent("keydown", {
    key: "k",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
    composed: true,
  });
  try {
    target.dispatchEvent(event);
  } finally {
    window.removeEventListener("keydown", handler, { capture: true });
  }
  return event;
}

async function openAuthenticationDialog(app: PiWebApp): Promise<HTMLElement> {
  setAppState(app, { authDialog: { step: "method", machineId: "local" } });
  const container = renderApp(app);
  const dialog = requiredElement(container.querySelector<AuthDialog>("auth-dialog"), "authentication dialog");
  await dialog.updateComplete;
  const surface = requiredElement(dialog.shadowRoot?.querySelector<ModalSurface>("modal-surface"), "authentication modal surface");
  await surface.updateComplete;
  return requiredElement(dialog.shadowRoot?.querySelector<HTMLElement>("button[aria-label='Close']"), "authentication close button");
}

async function openImageZoom(app: PiWebApp): Promise<HTMLElement> {
  const selectedSession = session("session-image");
  setAppState(app, {
    selectedSession,
    sessions: [selectedSession],
    mainView: "chat",
    messages: [{ role: "user", parts: [{ type: "image", mimeType: "image/png", data: IMAGE_DATA }] }],
  });
  const container = renderApp(app);
  const view = requiredElement(container.querySelector<ChatView>("chat-view"), "chat view");
  await view.updateComplete;
  const image = requiredElement(view.shadowRoot?.querySelector<HTMLElement>(".chat-image"), "chat image");
  image.focus();
  image.click();
  await view.updateComplete;
  const dialog = requiredElement(view.shadowRoot?.querySelector<HTMLDialogElement>("dialog.image-zoom"), "image zoom dialog");
  expect(dialog.open).toBe(true);
  return requiredElement(dialog.querySelector<HTMLElement>(".image-zoom-close"), "image zoom close button");
}

function openComposedNativeDialog(): Promise<HTMLElement> {
  const host = document.createElement("div");
  const root = host.attachShadow({ mode: "open" });
  const dialog = document.createElement("dialog");
  const button = document.createElement("button");
  button.textContent = "Plugin modal action";
  dialog.append(button);
  root.append(dialog);
  document.body.append(host);
  dialog.showModal();
  button.focus();
  return Promise.resolve(button);
}

function renderApp(app: PiWebApp): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  render(app.render(), container);
  return container;
}

function focusChatComposer(app: PiWebApp): Promise<void> {
  const method: unknown = Reflect.get(app, "focusChatComposer");
  if (!isFocusChatComposer(method)) throw new Error("PiWebApp prompt focus boundary was unavailable");
  return Reflect.apply(method, app, []);
}

function isFocusChatComposer(value: unknown): value is FocusChatComposer {
  return typeof value === "function";
}

function isAppKeyDownHandler(value: unknown): value is AppKeyDownHandler {
  return typeof value === "function";
}

function isAutoFocusAppShell(value: unknown): value is AutoFocusAppShell {
  return typeof value === "object" && value !== null && "shouldAutoFocusPrompt" in value
    && typeof value.shouldAutoFocusPrompt === "function";
}

function appShouldAutoFocusPrompt(app: PiWebApp): boolean {
  const decision: unknown = Reflect.get(app, "shouldAutoFocusPrompt");
  if (typeof decision !== "function") throw new Error("PiWebApp auto-focus decision was unavailable");
  const result: unknown = Reflect.apply(decision, app, []);
  if (typeof result !== "boolean") throw new Error("PiWebApp auto-focus decision was invalid");
  return result;
}

function actionPaletteIsOpen(app: PiWebApp): boolean {
  const state: unknown = Reflect.get(app, "state");
  if (typeof state !== "object" || state === null || !("actionPaletteOpen" in state) || typeof state.actionPaletteOpen !== "boolean") {
    throw new Error("PiWebApp action-palette state was unavailable");
  }
  return state.actionPaletteOpen;
}

function setAppState(app: PiWebApp, patch: Partial<AppState>): void {
  if (!Reflect.set(app, "state", { ...initialAppState(), ...patch })) throw new Error("Could not set PiWebApp state");
}

function appendKeyTarget(): HTMLButtonElement {
  const button = document.createElement("button");
  button.textContent = "Modal action";
  document.body.append(button);
  return button;
}

function requiredElement<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`Expected ${label}`);
  return value;
}

function session(id: string): SessionInfo {
  return {
    id,
    cwd: "/repo",
    path: `/repo/${id}.jsonl`,
    created: "2026-07-20T00:00:00.000Z",
    modified: "2026-07-20T00:00:00.000Z",
    messageCount: 1,
    firstMessage: id,
  };
}
