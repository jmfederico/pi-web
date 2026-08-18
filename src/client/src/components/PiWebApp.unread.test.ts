import type { TemplateResult } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Machine, SessionInfo, SessionUnreadEvent, SessionUnreadSummary } from "../api";
import { initialAppState, type AppState } from "../appState";
import type { BrowserRealtimeEvent } from "../sessionSocket";
import type { AppMobileMainTab } from "./appShell/AppMobileMainTabs";
// Template inspection is proportionate here because this node-environment test
// verifies only PiWebApp's unread-state property wiring into navigation.
import { templateValueAfterMarker } from "../templateInspection.testSupport";
import { PiWebApp } from "./PiWebApp";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PiWebApp session unread wiring", () => {
  it("shows a server completion for a background chat and acknowledges the exact observed order when viewed", async () => {
    const fetchMock = stubJsonFetch({ catalogId: "catalog-a", catalogRevision: 2, sessions: [] });
    const app = createApp();
    enableUnread(app);
    const foreground = session("foreground");
    const background = session("background");
    setAppState(app, { ...initialAppState(), sessions: [foreground, background], selectedSession: foreground, mainView: "chat" });
    exposeSelectedChat(app);

    handleRealtimeEvent(app, unreadEvent(1, unreadSummary(background, 1)));
    expect([...navigationUnreadSessionIds(app)]).toEqual([background.id]);
    expect(mobileNavigationTab(app)).toMatchObject({ badge: 1, badgeLabel: "1 unread", badgeTone: "unread" });

    setState(app, { selectedSession: background });
    // Selection alone cannot clear unread before the new transcript is ready
    // and Lit has committed the corresponding chat.
    expect([...navigationUnreadSessionIds(app)]).toEqual([background.id]);
    expect(fetchMock).not.toHaveBeenCalled();
    exposeSelectedChat(app);
    await vi.waitFor(() => { expect(navigationUnreadSessionIds(app).size).toBe(0); });
    expect(mobileNavigationTab(app)).not.toHaveProperty("badge");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://pi.example.test/api/machines/local/sessions/background/unread/acknowledge");
    const init = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(typeof init?.body === "string" ? init.body : "{}")).toEqual({
      cwd: "/repo",
      catalogId: "catalog-a",
      throughCompletionOrder: 1,
    });
  });

  it("keeps the selected chat unread while hidden or unfocused, then acknowledges on a visible focus check", async () => {
    const fetchMock = stubJsonFetch({ catalogId: "catalog-a", catalogRevision: 2, sessions: [] });
    const documentState = { visible: false, focused: false };
    vi.stubGlobal("document", {
      baseURI: "https://pi.example.test/",
      get visibilityState() { return documentState.visible ? "visible" : "hidden"; },
      hasFocus: () => documentState.focused,
    });
    const app = createApp();
    enableUnread(app);
    const selected = session("selected");
    setAppState(app, { ...initialAppState(), sessions: [selected], selectedSession: selected, mainView: "chat" });
    exposeSelectedChat(app);

    handleRealtimeEvent(app, unreadEvent(1, unreadSummary(selected, 1)));
    expect([...navigationUnreadSessionIds(app)]).toEqual([selected.id]);
    expect(fetchMock).not.toHaveBeenCalled();

    documentState.visible = true;
    documentState.focused = true;
    setState(app, { error: "refresh" });
    invokeUpdated(app);
    await vi.waitFor(() => { expect(navigationUnreadSessionIds(app).size).toBe(0); });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("keeps a focused mobile chat unread while navigation is stacked over it, then acknowledges on a layout-only reveal", async () => {
    const fetchMock = stubJsonFetch({ catalogId: "catalog-a", catalogRevision: 2, sessions: [] });
    const app = createApp({}, true);
    enableUnread(app);
    const selected = session("selected");
    setAppState(app, { ...initialAppState(), sessions: [selected], selectedSession: selected, mainView: "navigation" });
    exposeSelectedChat(app);

    handleRealtimeEvent(app, unreadEvent(1, unreadSummary(selected, 1)));
    expect([...navigationUnreadSessionIds(app)]).toEqual([selected.id]);
    expect(fetchMock).not.toHaveBeenCalled();

    setMobileNavigationLayout(app, false);
    invokeUpdated(app);
    await vi.waitFor(() => { expect(navigationUnreadSessionIds(app).size).toBe(0); });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not acknowledge a selected chat hidden behind the rendered-modal boundary", async () => {
    const fetchMock = stubJsonFetch({ catalogId: "catalog-a", catalogRevision: 2, sessions: [] });
    const app = createApp();
    let modalOpen = true;
    if (!Reflect.set(app, "isRenderedModalOpen", () => modalOpen)) throw new Error("Could not control the rendered-modal boundary");
    enableUnread(app);
    const selected = session("selected");
    setAppState(app, { ...initialAppState(), sessions: [selected], selectedSession: selected, mainView: "chat" });
    exposeSelectedChat(app);

    handleRealtimeEvent(app, unreadEvent(1, unreadSummary(selected, 1)));
    expect([...navigationUnreadSessionIds(app)]).toEqual([selected.id]);
    expect(fetchMock).not.toHaveBeenCalled();

    modalOpen = false;
    invokeUpdated(app);
    await vi.waitFor(() => { expect(navigationUnreadSessionIds(app).size).toBe(0); });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("applies another client's authoritative clear without issuing a redundant acknowledgement", () => {
    const fetchMock = stubJsonFetch({ catalogId: "catalog-a", catalogRevision: 2, sessions: [] });
    const app = createApp();
    enableUnread(app);
    const foreground = session("foreground");
    const background = session("background");
    setAppState(app, { ...initialAppState(), sessions: [foreground, background], selectedSession: foreground, mainView: "chat" });
    exposeSelectedChat(app);

    handleRealtimeEvent(app, unreadEvent(1, unreadSummary(background, 1)));
    handleRealtimeEvent(app, unreadEvent(2, null, background));

    expect(navigationUnreadSessionIds(app).size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches the durable server snapshot when the machine list loads", async () => {
    const background = session("background");
    const durable = { catalogId: "catalog-a", catalogRevision: 1, sessions: [unreadSummary(background, 1)] };
    const fetchMock = stubJsonFetch(durable);
    const app = createApp();
    enableUnread(app);
    const foreground = session("foreground");
    const localMachine = machine("local");
    setAppState(app, {
      ...initialAppState(),
      selectedMachine: localMachine,
      sessions: [foreground, background],
      selectedSession: foreground,
      mainView: "chat",
    });
    expect(fetchMock).not.toHaveBeenCalled();

    setState(app, { machines: [localMachine] });
    await vi.waitFor(() => { expect([...navigationUnreadSessionIds(app)]).toEqual([background.id]); });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://pi.example.test/api/machines/local/sessions/unread");
  });

  it("drops a deferred unread snapshot on disconnect without acknowledging it", async () => {
    const response = deferred<Response>();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      void input;
      return response.promise;
    });
    vi.stubGlobal("fetch", fetchMock);
    const app = createApp();
    enableUnread(app);
    const selected = session("selected");
    setAppState(app, { ...initialAppState(), sessions: [selected], selectedSession: selected, mainView: "chat" });
    exposeSelectedChat(app);

    const refreshing = refreshUnread(app, "local");
    invokeDisconnected(app);
    response.resolve(new Response(JSON.stringify({
      catalogId: "catalog-a",
      catalogRevision: 1,
      sessions: [unreadSummary(selected, 1)],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    await refreshing;

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://pi.example.test/api/machines/local/sessions/unread");
  });

  it("does not treat the legacy browser-local key as unread authority", () => {
    const app = createApp({ "pi-web-session-unread-v1": JSON.stringify([["local", "background"]]) });
    const foreground = session("foreground");
    const background = session("background");
    setAppState(app, { ...initialAppState(), sessions: [foreground, background], selectedSession: foreground, mainView: "chat" });

    expect(navigationUnreadSessionIds(app).size).toBe(0);
  });

  it("acknowledges a session explicitly marked as read from navigation", async () => {
    const fetchMock = stubJsonFetch({ catalogId: "catalog-a", catalogRevision: 2, sessions: [] });
    const app = createApp();
    enableUnread(app);
    const selected = session("selected");
    const alpha = session("alpha");
    setAppState(app, { ...initialAppState(), sessions: [selected, alpha], selectedSession: selected, mainView: "chat" });

    handleRealtimeEvent(app, unreadEvent(1, unreadSummary(alpha, 1)));
    expect([...navigationUnreadSessionIds(app)]).toEqual([alpha.id]);
    expect(fetchMock).not.toHaveBeenCalled();

    navigationMarkSessionRead(app)(alpha);
    await vi.waitFor(() => { expect(fetchMock).toHaveBeenCalledOnce(); });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://pi.example.test/api/machines/local/sessions/alpha/unread/acknowledge");
    const init = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(typeof init?.body === "string" ? init.body : "{}")).toEqual({
      cwd: "/repo",
      catalogId: "catalog-a",
      throughCompletionOrder: 1,
    });
    await vi.waitFor(() => { expect(navigationUnreadSessionIds(app).size).toBe(0); });
  });

  it("acknowledges every session in a bulk mark-read request from navigation", async () => {
    const fetchMock = stubJsonFetch({ catalogId: "catalog-a", catalogRevision: 2, sessions: [] });
    const app = createApp();
    enableUnread(app);
    const selected = session("selected");
    const alpha = session("alpha");
    const beta = session("beta");
    setAppState(app, { ...initialAppState(), sessions: [selected, alpha, beta], selectedSession: selected, mainView: "chat" });

    handleRealtimeEvent(app, unreadEvent(1, unreadSummary(alpha, 1)));
    handleRealtimeEvent(app, unreadEvent(2, unreadSummary(beta, 2)));
    expect([...navigationUnreadSessionIds(app)]).toEqual([alpha.id, beta.id]);
    expect(fetchMock).not.toHaveBeenCalled();

    navigationMarkSessionsRead(app)([alpha, beta]);
    await vi.waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(2); });
    const requests = fetchMock.mock.calls.map((call) => call[0]);
    expect(requests).toContain("https://pi.example.test/api/machines/local/sessions/alpha/unread/acknowledge");
    expect(requests).toContain("https://pi.example.test/api/machines/local/sessions/beta/unread/acknowledge");
    await vi.waitFor(() => { expect(navigationUnreadSessionIds(app).size).toBe(0); });
  });
});

type RenderNavigationPanel = (this: PiWebApp) => TemplateResult;
type SetAppState = (this: PiWebApp, patch: Partial<AppState>) => void;
type HandleRealtimeEvent = (this: PiWebApp, machineId: string, event: BrowserRealtimeEvent) => void;
type MobileMainTabs = (this: PiWebApp) => AppMobileMainTab[];
type UpdatedHook = (this: PiWebApp) => void;
type DisconnectedHook = (this: PiWebApp) => void;
type RefreshUnread = (machineId: string) => Promise<void>;
type MarkSessionRead = (session: SessionInfo) => void;
type MarkSessionsRead = (sessions: SessionInfo[]) => void;

function createApp(storedValues: Record<string, string> = {}, mobileNavigation = false): PiWebApp {
  const values = new Map(Object.entries(storedValues));
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  const matchMedia = (query: string) => ({
    matches: mobileNavigation && query.includes("max-width: 760px"),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  vi.stubGlobal("window", {
    location: { search: "" },
    localStorage: storage,
    matchMedia,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    clearInterval: () => undefined,
    clearTimeout: () => undefined,
  });
  if (typeof document === "undefined") {
    vi.stubGlobal("document", { baseURI: "https://pi.example.test/", visibilityState: "visible", hasFocus: () => true });
  }
  vi.stubGlobal("requestAnimationFrame", () => 1);
  return new PiWebApp();
}

function setAppState(app: PiWebApp, state: AppState): void {
  if (!Reflect.set(app, "state", state)) throw new Error("Could not set PiWebApp state");
}

function setState(app: PiWebApp, patch: Partial<AppState>): void {
  const method: unknown = Reflect.get(app, "setState");
  if (!isSetAppState(method)) throw new Error("PiWebApp.setState is not callable");
  method.call(app, patch);
}

function handleRealtimeEvent(app: PiWebApp, event: BrowserRealtimeEvent): void {
  const method: unknown = Reflect.get(app, "handleRealtimeEvent");
  if (!isHandleRealtimeEvent(method)) throw new Error("PiWebApp.handleRealtimeEvent is not callable");
  method.call(app, "local", event);
}

function enableUnread(app: PiWebApp): void {
  if (!Reflect.set(app, "unreadConnected", true)) throw new Error("Could not connect PiWebApp unread state");
}

function exposeSelectedChat(app: PiWebApp): void {
  const state: unknown = Reflect.get(app, "state");
  if (typeof state !== "object" || state === null) throw new Error("PiWebApp state is unavailable");
  const selectedSession: unknown = Reflect.get(state, "selectedSession");
  if (typeof selectedSession !== "object" || selectedSession === null) throw new Error("Expected a selected chat");
  const sessionId: unknown = Reflect.get(selectedSession, "id");
  const cwd: unknown = Reflect.get(selectedSession, "cwd");
  if (typeof sessionId !== "string" || typeof cwd !== "string") throw new Error("Selected chat identity is invalid");
  const selectedMachine: unknown = Reflect.get(state, "selectedMachine");
  const machineId = typeof selectedMachine === "object" && selectedMachine !== null && typeof Reflect.get(selectedMachine, "id") === "string"
    ? String(Reflect.get(selectedMachine, "id"))
    : "local";
  if (!Reflect.set(app, "readyChatIdentity", JSON.stringify([machineId, sessionId, cwd]))) {
    throw new Error("Could not mark selected chat ready");
  }
  invokeUpdated(app);
}

function setMobileNavigationLayout(app: PiWebApp, mobile: boolean): void {
  const appShell: unknown = Reflect.get(app, "appShell");
  if (typeof appShell !== "object" || appShell === null || !Reflect.set(appShell, "isMobileNavigationLayout", mobile)) {
    throw new Error("Could not update the app-shell layout");
  }
}

function invokeUpdated(app: PiWebApp): void {
  const method: unknown = Reflect.get(app, "updated");
  if (!isUpdatedHook(method)) throw new Error("PiWebApp.updated is not callable");
  method.call(app);
}

function invokeDisconnected(app: PiWebApp): void {
  const method: unknown = Reflect.get(app, "disconnectedCallback");
  if (!isDisconnectedHook(method)) throw new Error("PiWebApp.disconnectedCallback is not callable");
  method.call(app);
}

function refreshUnread(app: PiWebApp, machineId: string): Promise<void> {
  const controller: unknown = Reflect.get(app, "sessionUnread");
  if (typeof controller !== "object" || controller === null) throw new Error("PiWebApp unread controller is unavailable");
  const refresh: unknown = Reflect.get(controller, "refresh");
  if (!isRefreshUnread(refresh)) throw new Error("PiWebApp unread refresh is not callable");
  return refresh.call(controller, machineId);
}

function mobileNavigationTab(app: PiWebApp): AppMobileMainTab {
  const method: unknown = Reflect.get(app, "mobileMainTabs");
  if (!isMobileMainTabs(method)) throw new Error("PiWebApp.mobileMainTabs is not callable");
  const tab = method.call(app).find((candidate) => candidate.id === "navigation");
  if (tab === undefined) throw new Error("Expected the mobile Sessions tab");
  return tab;
}

function navigationUnreadSessionIds(app: PiWebApp): ReadonlySet<string> {
  const value = navigationPanelValue(app, ".unreadSessionIds=");
  if (!(value instanceof Set) || ![...value].every((entry: unknown) => typeof entry === "string")) {
    throw new Error("Expected unread session ids in navigation");
  }
  return value;
}

function navigationMarkSessionRead(app: PiWebApp): MarkSessionRead {
  const value = navigationPanelValue(app, ".onMarkSessionRead=");
  if (!isMarkSessionRead(value)) throw new Error("Expected mark-session-read callback in navigation");
  return value;
}

function navigationMarkSessionsRead(app: PiWebApp): MarkSessionsRead {
  const value = navigationPanelValue(app, ".onMarkSessionsRead=");
  if (!isMarkSessionsRead(value)) throw new Error("Expected mark-sessions-read callback in navigation");
  return value;
}

function navigationPanelValue(app: PiWebApp, marker: string): unknown {
  const method: unknown = Reflect.get(app, "renderNavigationPanel");
  if (!isRenderNavigationPanel(method)) throw new Error("PiWebApp.renderNavigationPanel is not callable");
  return templateValueAfterMarker(method.call(app), marker);
}

function machine(id: string): Machine {
  return {
    id,
    name: id,
    kind: id === "local" ? "local" : "remote",
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
  };
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

function unreadSummary(target: SessionInfo, completionOrder: number): SessionUnreadSummary {
  return {
    sessionId: target.id,
    cwd: target.cwd,
    completionOrder,
    completedAt: `2026-07-20T00:00:0${String(completionOrder)}.000Z`,
  };
}

function unreadEvent(
  catalogRevision: number,
  unread: SessionUnreadSummary | null,
  target: SessionInfo = unread === null ? session("selected") : session(unread.sessionId),
): SessionUnreadEvent {
  return {
    type: "sessions.unread",
    catalogId: "catalog-a",
    catalogRevision,
    sessionId: unread?.sessionId ?? target.id,
    cwd: unread?.cwd ?? target.cwd,
    unread,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return {
    promise,
    resolve(value) {
      if (resolvePromise === undefined) throw new Error("Deferred promise is unavailable");
      resolvePromise(value);
    },
  };
}

function stubJsonFetch(body: unknown) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    void input;
    void init;
    return Promise.resolve(new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function isRenderNavigationPanel(value: unknown): value is RenderNavigationPanel {
  return typeof value === "function";
}

function isSetAppState(value: unknown): value is SetAppState {
  return typeof value === "function";
}

function isHandleRealtimeEvent(value: unknown): value is HandleRealtimeEvent {
  return typeof value === "function";
}

function isMobileMainTabs(value: unknown): value is MobileMainTabs {
  return typeof value === "function";
}

function isUpdatedHook(value: unknown): value is UpdatedHook {
  return typeof value === "function";
}

function isDisconnectedHook(value: unknown): value is DisconnectedHook {
  return typeof value === "function";
}

function isRefreshUnread(value: unknown): value is RefreshUnread {
  return typeof value === "function";
}

function isMarkSessionRead(value: unknown): value is MarkSessionRead {
  return typeof value === "function";
}

function isMarkSessionsRead(value: unknown): value is MarkSessionsRead {
  return typeof value === "function";
}
