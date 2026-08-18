// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo, SessionModel, SessionStatus } from "../api";
import { initialAppState, type AppState } from "../appState";
import { SessionController } from "../controllers/sessionController";
import { PiWebApp } from "./PiWebApp";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("PiWebApp model dialog", () => {
  it("opens with the enabled options, the full catalog, and the current selection", async () => {
    const app = new PiWebApp();
    const selectedSession = session("session-1");
    setAppState(app, {
      selectedSession,
      sessions: [selectedSession],
      status: sessionStatus(selectedSession.id, { provider: "openai", id: "gpt-5" }),
    });
    const listModels = vi.spyOn(SessionController.prototype, "listModels")
      .mockResolvedValue([{ provider: "openai", id: "gpt-5" }, { provider: "anthropic", id: "claude-sonnet-4-5" }]);
    const catalog = [
      { provider: "openai", id: "gpt-5", enabled: true },
      { provider: "anthropic", id: "claude-sonnet-4-5", enabled: true },
      { provider: "openai", id: "gpt-4o", enabled: false },
    ];
    const listModelCatalog = vi.spyOn(SessionController.prototype, "listModelCatalog").mockResolvedValue(catalog);

    await callAppMethod(app, "openModelDialog");

    expect(listModels).toHaveBeenCalledOnce();
    expect(listModelCatalog).toHaveBeenCalledOnce();
    const dialog = appModelDialog(app);
    expect(dialog?.title).toBe("Select Model");
    expect(dialog?.selectedValue).toBe("openai/gpt-5");
    expect(dialog?.options).toEqual([
      { value: "openai/gpt-5", label: "gpt-5 ✓ current", description: "openai" },
      { value: "anthropic/claude-sonnet-4-5", label: "claude-sonnet-4-5", description: "anthropic" },
    ]);
    expect(dialog?.catalog).toEqual(catalog);
  });

  it("rebuilds the dialog's enabled options and catalog from the fresh catalog after a toggle", async () => {
    const app = new PiWebApp();
    const selectedSession = session("session-1");
    setAppState(app, {
      selectedSession,
      sessions: [selectedSession],
      status: sessionStatus(selectedSession.id, { provider: "openai", id: "gpt-5" }),
      modelDialog: {
        title: "Select Model",
        selectedValue: "openai/gpt-5",
        options: [{ value: "openai/gpt-5", label: "gpt-5 ✓ current", description: "openai" }],
        catalog: [
          { provider: "openai", id: "gpt-5", enabled: true },
          { provider: "openai", id: "gpt-4o", enabled: false },
        ],
      },
    });
    const freshCatalog = [
      { provider: "openai", id: "gpt-5", enabled: true },
      { provider: "openai", id: "gpt-4o", enabled: true },
      { provider: "anthropic", id: "claude-sonnet-4-5", enabled: false },
    ];
    const setModelEnabled = vi.spyOn(SessionController.prototype, "setModelEnabled").mockResolvedValue(freshCatalog);

    await callToggleHandler(app, "openai", "gpt-4o", true);

    expect(setModelEnabled).toHaveBeenCalledWith("openai", "gpt-4o", true);
    const dialog = appModelDialog(app);
    expect(dialog?.catalog).toEqual(freshCatalog);
    // Enabled-mode options hold the fresh catalog's enabled rows only;
    // disabled rows (anthropic/claude-sonnet-4-5) stay out of the Enabled list.
    expect(dialog?.options).toEqual([
      { value: "openai/gpt-5", label: "gpt-5 ✓ current", description: "openai" },
      { value: "openai/gpt-4o", label: "gpt-4o", description: "openai" },
    ]);
  });

  it("leaves the dialog untouched when the toggle fails", async () => {
    const app = new PiWebApp();
    const selectedSession = session("session-1");
    setAppState(app, {
      selectedSession,
      sessions: [selectedSession],
      modelDialog: { title: "Select Model", options: [], catalog: [] },
    });
    const before = appModelDialog(app);
    vi.spyOn(SessionController.prototype, "setModelEnabled").mockResolvedValue(undefined);

    await callToggleHandler(app, "openai", "gpt-4o", true);

    expect(appModelDialog(app)).toBe(before);
  });

  it("still applies the toggle when the dialog was closed meanwhile", async () => {
    const app = new PiWebApp();
    const selectedSession = session("session-1");
    setAppState(app, { selectedSession, sessions: [selectedSession] });
    vi.spyOn(SessionController.prototype, "setModelEnabled").mockResolvedValue([{ provider: "openai", id: "gpt-5", enabled: true }]);

    await callToggleHandler(app, "openai", "gpt-5", true);

    expect(appModelDialog(app)).toBeUndefined();
  });
});

type AppModelDialog = AppState["modelDialog"];

async function callAppMethod(app: PiWebApp, name: "openModelDialog"): Promise<void> {
  const method: unknown = Reflect.get(app, name);
  if (typeof method !== "function") throw new Error(`PiWebApp ${name} was unavailable`);
  await Reflect.apply(method, app, []);
}

async function callToggleHandler(app: PiWebApp, provider: string, modelId: string, enabled: boolean): Promise<void> {
  const handler: unknown = Reflect.get(app, "handleToggleModelEnabled");
  if (typeof handler !== "function") throw new Error("PiWebApp model toggle handler was unavailable");
  await Reflect.apply(handler, app, [provider, modelId, enabled]);
}

function appModelDialog(app: PiWebApp): AppModelDialog {
  const state: unknown = Reflect.get(app, "state");
  if (!isAppState(state)) throw new Error("PiWebApp state was unavailable");
  return state.modelDialog;
}

function isAppState(value: unknown): value is AppState {
  return typeof value === "object" && value !== null && "modelDialog" in value;
}

function setAppState(app: PiWebApp, patch: Partial<AppState>): void {
  if (!Reflect.set(app, "state", { ...initialAppState(), ...patch })) throw new Error("Could not set PiWebApp state");
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

function sessionStatus(sessionId: string, model?: SessionModel): SessionStatus {
  return {
    sessionId,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    pendingMessageCount: 0,
    queuedMessages: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
    ...(model === undefined ? {} : { model }),
  };
}
