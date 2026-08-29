// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo, SessionModel, SessionModelCatalogEntry, SessionStatus } from "../api";
import { initialAppState, type AppState } from "../appState";
import { SessionController } from "../controllers/sessionController";
import { PiWebApp } from "./PiWebApp";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

const modelDialogOrigin = { machineId: "local", sessionId: "session-1", cwd: "/repo" } as const;

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

  it("refreshes an open dialog after a global model-scope change", async () => {
    const app = new PiWebApp();
    const selectedSession = session("session-1");
    setAppState(app, {
      selectedSession,
      sessions: [selectedSession],
      status: sessionStatus(selectedSession.id, { provider: "openai", id: "gpt-5" }),
      modelDialog: {
        instanceId: 1,
        origin: modelDialogOrigin,
        title: "Select Model",
        selectedValue: "openai/gpt-5",
        options: [{ value: "openai/gpt-5", label: "gpt-5 ✓ current", description: "openai" }],
        catalog: [{ provider: "openai", id: "gpt-5", enabled: true }],
      },
    });
    const listModels = vi.spyOn(SessionController.prototype, "listModels")
      .mockResolvedValue([{ provider: "openai", id: "gpt-5" }, { provider: "openai", id: "gpt-4o" }]);
    const listModelCatalog = vi.spyOn(SessionController.prototype, "listModelCatalog")
      .mockResolvedValue([
        { provider: "openai", id: "gpt-5", enabled: true },
        { provider: "openai", id: "gpt-4o", enabled: true },
      ]);
    const sessions: unknown = Reflect.get(app, "sessions");
    if (typeof sessions !== "object" || sessions === null) throw new Error("PiWebApp session controller was unavailable");
    const applyGlobalEvent: unknown = Reflect.get(sessions, "applyGlobalEvent");
    if (typeof applyGlobalEvent !== "function") throw new Error("SessionController global event handler was unavailable");

    Reflect.apply(applyGlobalEvent, sessions, [{ type: "models.changed", revision: 2 }]);
    await vi.waitFor(() => { expect(appModelDialog(app)?.options).toHaveLength(2); });

    expect(listModels).toHaveBeenCalledOnce();
    expect(listModelCatalog).toHaveBeenCalledOnce();
    expect(appModelDialog(app)?.options).toEqual([
      { value: "openai/gpt-5", label: "gpt-5 ✓ current", description: "openai" },
      { value: "openai/gpt-4o", label: "gpt-4o", description: "openai" },
    ]);
    expect(appModelDialog(app)?.catalog).toEqual([
      { provider: "openai", id: "gpt-5", enabled: true },
      { provider: "openai", id: "gpt-4o", enabled: true },
    ]);
  });

  it("retries dialog loading when a global scope change arrives while it is opening", async () => {
    const app = new PiWebApp();
    const selectedSession = session("session-1");
    setAppState(app, {
      selectedSession,
      sessions: [selectedSession],
      status: sessionStatus(selectedSession.id, { provider: "openai", id: "gpt-5" }),
    });
    let resolveInitialModels: ((models: SessionModel[]) => void) | undefined;
    let resolveInitialCatalog: ((catalog: SessionModelCatalogEntry[]) => void) | undefined;
    const listModels = vi.spyOn(SessionController.prototype, "listModels").mockImplementation(() => {
      if (listModels.mock.calls.length > 1) return Promise.resolve([{ provider: "openai", id: "gpt-5" }, { provider: "openai", id: "gpt-4o" }]);
      return new Promise((resolve) => { resolveInitialModels = resolve; });
    });
    const listModelCatalog = vi.spyOn(SessionController.prototype, "listModelCatalog").mockImplementation(() => {
      if (listModelCatalog.mock.calls.length > 1) {
        return Promise.resolve([
          { provider: "openai", id: "gpt-5", enabled: true },
          { provider: "openai", id: "gpt-4o", enabled: true },
        ]);
      }
      return new Promise((resolve) => { resolveInitialCatalog = resolve; });
    });

    const pending = callAppMethod(app, "openModelDialog");
    await vi.waitFor(() => { expect(listModels).toHaveBeenCalledOnce(); });
    const sessions: unknown = Reflect.get(app, "sessions");
    if (typeof sessions !== "object" || sessions === null) throw new Error("PiWebApp session controller was unavailable");
    const applyGlobalEvent: unknown = Reflect.get(sessions, "applyGlobalEvent");
    if (typeof applyGlobalEvent !== "function") throw new Error("SessionController global event handler was unavailable");
    Reflect.apply(applyGlobalEvent, sessions, [{ type: "models.changed", revision: 2 }]);
    resolveInitialModels?.([{ provider: "openai", id: "gpt-5" }]);
    resolveInitialCatalog?.([{ provider: "openai", id: "gpt-5", enabled: true }]);
    await pending;

    expect(listModels).toHaveBeenCalledTimes(2);
    expect(listModelCatalog).toHaveBeenCalledTimes(2);
    expect(appModelDialog(app)?.options).toEqual([
      { value: "openai/gpt-5", label: "gpt-5 ✓ current", description: "openai" },
      { value: "openai/gpt-4o", label: "gpt-4o", description: "openai" },
    ]);
  });

  it("discards catalog results when selection changes while the dialog is opening", async () => {
    const app = new PiWebApp();
    const selectedSession = session("session-1");
    setAppState(app, { selectedSession, sessions: [selectedSession] });
    let resolveModels: ((models: SessionModel[]) => void) | undefined;
    let resolveCatalog: ((catalog: { provider: string; id: string; enabled: boolean }[]) => void) | undefined;
    vi.spyOn(SessionController.prototype, "listModels").mockImplementation(() => new Promise((resolve) => { resolveModels = resolve; }));
    vi.spyOn(SessionController.prototype, "listModelCatalog").mockImplementation(() => new Promise((resolve) => { resolveCatalog = resolve; }));

    const pending = callAppMethod(app, "openModelDialog");
    const replacement = session("session-2");
    setAppState(app, { selectedSession: replacement, sessions: [replacement] });
    resolveModels?.([{ provider: "openai", id: "gpt-5" }]);
    resolveCatalog?.([{ provider: "openai", id: "gpt-5", enabled: true }]);
    await pending;

    expect(appModelDialog(app)).toBeUndefined();
  });

  it("rebuilds the dialog's enabled options and catalog from the fresh catalog after a toggle", async () => {
    const app = new PiWebApp();
    const selectedSession = session("session-1");
    setAppState(app, {
      selectedSession,
      sessions: [selectedSession],
      status: sessionStatus(selectedSession.id, { provider: "openai", id: "gpt-5" }),
      modelDialog: {
        instanceId: 1,
        origin: modelDialogOrigin,
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

  it("applies an atomic scope preset and rebuilds the enabled options", async () => {
    const app = new PiWebApp();
    const selectedSession = session("session-1");
    const dialog = {
      instanceId: 1,
      origin: modelDialogOrigin,
      title: "Select Model",
      selectedValue: "openai/gpt-5",
      options: [{ value: "openai/gpt-5", label: "gpt-5 ✓ current", description: "openai" }],
      catalog: [{ provider: "openai", id: "gpt-5", enabled: true }],
    };
    setAppState(app, {
      selectedSession,
      sessions: [selectedSession],
      status: sessionStatus(selectedSession.id, { provider: "openai", id: "gpt-5" }),
      modelDialog: dialog,
    });
    const freshCatalog = [
      { provider: "openai", id: "gpt-5", enabled: true },
      { provider: "openai", id: "gpt-4o", enabled: false },
    ];
    const setModelScope = vi.spyOn(SessionController.prototype, "setModelScope").mockResolvedValue(freshCatalog);

    await callScopeHandler(app, "current");

    expect(setModelScope).toHaveBeenCalledWith("current");
    expect(appModelDialog(app)?.catalog).toEqual(freshCatalog);
    expect(appModelDialog(app)?.options).toEqual([
      { value: "openai/gpt-5", label: "gpt-5 ✓ current", description: "openai" },
    ]);
  });

  it("leaves the dialog untouched when the toggle fails", async () => {
    const app = new PiWebApp();
    const selectedSession = session("session-1");
    setAppState(app, {
      selectedSession,
      sessions: [selectedSession],
      modelDialog: { instanceId: 1, origin: modelDialogOrigin, title: "Select Model", options: [], catalog: [] },
    });
    const before = appModelDialog(app);
    vi.spyOn(SessionController.prototype, "setModelEnabled").mockResolvedValue(undefined);

    await callToggleHandler(app, "openai", "gpt-4o", true);

    expect(appModelDialog(app)).toBe(before);
  });

  it("does not restore the dialog when a toggle settles after it was closed", async () => {
    const app = new PiWebApp();
    const selectedSession = session("session-1");
    setAppState(app, { selectedSession, sessions: [selectedSession], modelDialog: { instanceId: 1, origin: modelDialogOrigin, title: "Select Model", options: [], catalog: [] } });
    let resolveToggle: ((catalog: { provider: string; id: string; enabled: boolean }[]) => void) | undefined;
    vi.spyOn(SessionController.prototype, "setModelEnabled").mockImplementation(() => new Promise((resolve) => { resolveToggle = resolve; }));

    const pending = callToggleHandler(app, "openai", "gpt-5", true);
    setAppState(app, { selectedSession, sessions: [selectedSession], modelDialog: undefined });
    resolveToggle?.([{ provider: "openai", id: "gpt-5", enabled: true }]);
    await pending;

    expect(appModelDialog(app)).toBeUndefined();
  });

  it("closes the dialog when the live current model changes", () => {
    const app = new PiWebApp();
    const selectedSession = session("session-1");
    setAppState(app, {
      selectedSession,
      sessions: [selectedSession],
      status: sessionStatus(selectedSession.id, { provider: "openai", id: "gpt-5" }),
      modelDialog: { instanceId: 1, origin: modelDialogOrigin, title: "Select Model", options: [], catalog: [] },
    });

    applyAppStatePatch(app, { status: sessionStatus(selectedSession.id, { provider: "openai", id: "gpt-4o" }) });

    expect(appModelDialog(app)).toBeUndefined();
  });

  it("refuses a scope mutation when the dialog no longer belongs to the selected session", async () => {
    const app = new PiWebApp();
    const replacement = session("session-2");
    setAppState(app, {
      selectedSession: replacement,
      sessions: [replacement],
      modelDialog: { instanceId: 1, origin: modelDialogOrigin, title: "Select Model", options: [], catalog: [] },
    });
    const setModelScope = vi.spyOn(SessionController.prototype, "setModelScope");

    await callScopeHandler(app, "all");

    expect(setModelScope).not.toHaveBeenCalled();
    expect(appModelDialog(app)).toBeUndefined();
  });

  it("does not apply a stale response to a replacement dialog", async () => {
    const app = new PiWebApp();
    const selectedSession = session("session-1");
    const original = { instanceId: 1, origin: modelDialogOrigin, title: "Select Model", options: [], catalog: [] };
    const replacement = { instanceId: 2, origin: modelDialogOrigin, title: "Replacement", options: [], catalog: [] };
    setAppState(app, { selectedSession, sessions: [selectedSession], modelDialog: original });
    let resolveScope: ((catalog: { provider: string; id: string; enabled: boolean }[]) => void) | undefined;
    vi.spyOn(SessionController.prototype, "setModelScope").mockImplementation(() => new Promise((resolve) => { resolveScope = resolve; }));

    const pending = callScopeHandler(app, "all");
    setAppState(app, { selectedSession, sessions: [selectedSession], modelDialog: replacement });
    resolveScope?.([{ provider: "openai", id: "gpt-5", enabled: true }]);
    await pending;

    expect(appModelDialog(app)).toBe(replacement);
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

async function callScopeHandler(app: PiWebApp, mode: "all" | "current"): Promise<void> {
  const handler: unknown = Reflect.get(app, "handleSetModelScope");
  if (typeof handler !== "function") throw new Error("PiWebApp model scope handler was unavailable");
  await Reflect.apply(handler, app, [mode]);
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

function applyAppStatePatch(app: PiWebApp, patch: Partial<AppState>): void {
  const setState: unknown = Reflect.get(app, "setState");
  if (typeof setState !== "function") throw new Error("PiWebApp state updater was unavailable");
  Reflect.apply(setState, app, [patch]);
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
