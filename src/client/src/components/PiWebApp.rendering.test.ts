// @vitest-environment happy-dom
import { installNativeDialogFake } from "./nativeDialog.testSupport";
installNativeDialogFake();

import { LitElement, html } from "lit";
import { useDeferredContent, settleDeferredContent } from "../formatting/deferredContent.testSupport";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialAppState, type AppState } from "../appState";
import type { SessionInfo, SessionStatus, SessionWarning, Workspace } from "../api";
import { configApi } from "../api";
import { SessionController } from "../controllers/sessionController";
import { reportBrowserError, sessionBrowserErrorScope, workspaceBrowserErrorScope, type BrowserErrorRecovery } from "../browserErrors";
import { machineSessionKey } from "../machineKeys";
import { saveDraft } from "../promptDraftStorage";
import { clearStagedAttachments, saveStagedAttachments } from "../promptAttachmentStaging";
import { PromptEditor } from "./PromptEditor";
import { StatusBar } from "./StatusBar";
import { PluginRegistry } from "../plugins/registry";
import type { ExternalPluginLoadResult } from "../plugins/external";
import type { ContentRendererInput } from "../../../plugin-api";
import { corePlugin } from "../plugins/core";
import type { WorkspacePanelContext } from "../plugins/types";
import { PiWebApp } from "./PiWebApp";
import { themeStylesheetFetch } from "./themeStylesheetFetch.testSupport";
import * as themeCatalogApi from "../themeCatalog";
import { ChatView } from "./ChatView";
import { ConversationLayout } from "./ConversationLayout";
import type { ActionPalette } from "./ActionPalette";
import { FormattedText } from "./FormattedText";
import { ContentRendererHost } from "./ContentRendererHost";
import { WorkspacePanel } from "./WorkspacePanel";
import { WorkspaceList } from "./WorkspaceList";
import { ProjectList } from "./ProjectList";
import { SessionList } from "./SessionList";
import { loadNavigationPreferences, saveNavigationPreferences } from "../navigationPreferences";
import { NavigationDialog } from "./appShell/NavigationDialog";
import type { AppMobileMainTabs } from "./appShell/AppMobileMainTabs";
import { deepActiveElement } from "./modalLayerRegistry";
import { AppShellController } from "../appShell/appShellController";
import { configResponse } from "./SettingsDialog.testSupport";
import { localization } from "../localization/browser";
import { appFeedbackMessages } from "../appFeedbackMessages";

// Exercise the real shell and child rendering without starting API/socket
// orchestration. The inherited Lit controllers and update lifecycle still run.
class RenderOnlyApp extends PiWebApp {
  override connectedCallback(): void {
    LitElement.prototype.connectedCallback.call(this);
  }
}
customElements.define("render-only-pi-web-app", RenderOnlyApp);

const workspace: Workspace = { id: "workspace", projectId: "project", path: "/repo", label: "main", isMain: true, effectiveConfig: {} };
const session: SessionInfo = { id: "session", path: "/repo/session.jsonl", cwd: "/repo", name: "Current chat", created: "now", modified: "now", messageCount: 1, firstMessage: "hello" };

const unexpectedRequest = vi.fn(() => Promise.reject(new Error("Rendering tests must not make network requests")));

beforeEach(() => {
  unexpectedRequest.mockClear();
  window.history.replaceState(null, "", "/");
  vi.stubGlobal("fetch", themeStylesheetFetch(unexpectedRequest));
  // Theme discovery is outside this render-only fixture's orchestration boundary.
  vi.spyOn(themeCatalogApi, "loadThemeBootstrap").mockResolvedValue({ catalog: { themes: [], themePairs: [] }, stylesheets: [] });
  vi.spyOn(themeCatalogApi, "loadThemeCatalog").mockResolvedValue({ themes: [], themePairs: [] });
  // Scroll scheduling is not under test; happy-dom supplies no layout metrics.
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
});

useDeferredContent();

function panelToggle(app: PiWebApp, label: string): HTMLButtonElement {
  for (const host of app.renderRoot.querySelectorAll("app-navigation-panel, workspace-panel, app-mobile-main-tabs")) {
    const button = host.shadowRoot?.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    if (button !== undefined && button !== null) return button;
  }
  throw new Error(`Expected ${label}`);
}

afterEach(async () => {
  document.body.replaceChildren();
  vi.useRealTimers();
  await localization.setPreferences({ language: "en", formatLocale: "en" });
  clearStagedAttachments(machineSessionKey("local", session.id));
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  expect(unexpectedRequest).not.toHaveBeenCalled();
});

describe("application rendering boundaries", () => {
  it("places sustained stale-chat feedback above the conversation, outside the composer, and hides it after recovery", async () => {
    vi.useFakeTimers();
    const app = await mountApp({ selectedWorkspace: workspace, selectedSession: session, sessions: [session], mainView: "chat", conversationSync: "stale" });
    await settle(app);
    const notice = app.shadowRoot?.querySelector("conversation-sync-notice");
    const layout = app.shadowRoot?.querySelector("conversation-layout");
    const composer = app.shadowRoot?.querySelector("prompt-editor");
    if (!(notice instanceof LitElement) || layout === null || layout === undefined) throw new Error("Expected conversation and notice");
    expect(notice.nextElementSibling).toBe(layout);
    expect(notice.parentElement).toBe(layout.parentElement);
    expect(app.shadowRoot?.querySelector(".composer-area conversation-sync-notice")).toBeNull();
    expect(notice.shadowRoot?.querySelector("[role], button")).toBeNull();
    await vi.advanceTimersByTimeAsync(2_000);
    await notice.updateComplete;
    expect(notice.shadowRoot?.textContent).toContain("Chat may be out of date.");
    patchState(app, { conversationSync: "checked" });
    await settle(app);
    expect(notice.shadowRoot?.querySelector("[role], button")).toBeNull();
    expect(app.shadowRoot?.querySelector("prompt-editor")).toBe(composer);
  });

  it("does not mount a restored mobile transcript until Chat is opened, and retains an already displayed chat across tabs", async () => {
    const app = new RenderOnlyApp();
    const shell: unknown = Reflect.get(app, "appShell");
    const controller: unknown = Reflect.get(app, "sessions");
    if (!(shell instanceof AppShellController) || !(controller instanceof SessionController)) throw new Error("Expected app controllers");
    shell.isMobileNavigationLayout = true;
    shell.isDesktopSideBySideLayout = false;
    const load = vi.spyOn(controller, "loadSelectedSession").mockResolvedValue(undefined);
    patchState(app, {
      selectedWorkspace: workspace, workspaces: [workspace], selectedSession: session, sessions: [session],
      mainView: "navigation", messages: [{ role: "assistant", parts: [{ type: "text", text: "Deferred transcript" }] }],
    });
    document.body.append(app);
    await settle(app);
    expect(app.shadowRoot?.querySelector("chat-view")).toBeNull();
    expect(app.shadowRoot?.querySelector("prompt-editor")).toBeNull();
    expect(load).not.toHaveBeenCalled();
    expect(app.shadowRoot?.querySelector("app-navigation-panel")?.shadowRoot?.querySelector("session-list")?.shadowRoot?.textContent).toContain("Current chat");

    const selectTab = async (title: string) => {
      const tab = app.shadowRoot?.querySelector("app-mobile-main-tabs")?.shadowRoot?.querySelector<HTMLButtonElement>(`.mobile-tabs button[title="${title}"]`);
      if (tab == null) throw new Error(`Expected ${title} tab`);
      tab.click();
      await settle(app);
    };
    await selectTab("Chat");
    const chat = app.shadowRoot?.querySelector("chat-view");
    expect(chat).toBeInstanceOf(ChatView);
    const editor = app.shadowRoot?.querySelector("prompt-editor");
    expect(editor).toBeInstanceOf(PromptEditor);
    await selectTab("Sessions");
    expect(app.shadowRoot?.querySelector("chat-view")).toBe(chat);
    expect(app.shadowRoot?.querySelector("prompt-editor")).toBe(editor);
    load.mockClear();

    // Another workspace's remembered selection must not reuse the old chat's
    // display permission while the user is still browsing the session list.
    patchState(app, { selectedSession: { ...session, id: "another-session" } });
    await settle(app);
    expect(app.shadowRoot?.querySelector("chat-view")).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });

  it.each([true, false])("lets the list paint before loading visible restored Chat (initially mobile: %s)", async (mobile) => {
    const runFrame = manualAnimationFrames();
    const app = new RenderOnlyApp();
    const shell: unknown = Reflect.get(app, "appShell");
    const controller: unknown = Reflect.get(app, "sessions");
    if (!(shell instanceof AppShellController) || !(controller instanceof SessionController)) throw new Error("Expected app controllers");
    shell.isMobileNavigationLayout = mobile;
    shell.isDesktopSideBySideLayout = !mobile;
    let deferred = true;
    vi.spyOn(controller, "isChatLoadDeferred", "get").mockImplementation(() => deferred);
    const load = vi.spyOn(controller, "loadSelectedSession").mockImplementation(() => {
      deferred = false;
      app.requestUpdate();
      return Promise.resolve();
    });
    patchState(app, { selectedWorkspace: workspace, selectedSession: session, sessions: [session], mainView: "navigation" });
    document.body.append(app);
    await settle(app);
    expect(app.shadowRoot?.querySelector("chat-view")).toBeNull();
    expect(app.shadowRoot?.querySelector("prompt-editor")).toBeNull();
    expect(app.shadowRoot?.querySelector("app-navigation-panel")?.shadowRoot?.querySelector("session-list")?.shadowRoot?.textContent).toContain("Current chat");
    expect(load).not.toHaveBeenCalled();

    if (mobile) {
      runFrame();
      runFrame();
      expect(load).not.toHaveBeenCalled();
      shell.isMobileNavigationLayout = false;
      shell.isDesktopSideBySideLayout = true;
      app.requestUpdate();
      await settle(app);
    }
    expect(app.shadowRoot?.querySelector('[role="status"]')?.textContent).toBe("Loading conversation…");
    runFrame();
    await settle(app);
    // rAF callbacks run before paint: the first frame must not begin Chat work.
    expect(load).not.toHaveBeenCalled();
    expect(app.shadowRoot?.querySelector("chat-view")).toBeNull();
    runFrame();
    await settle(app);
    expect(load).toHaveBeenCalledOnce();
    expect(app.shadowRoot?.querySelector("chat-view")).toBeInstanceOf(ChatView);
  });

  it("focuses the composer after its deferred mount without waiting for the transcript response", async () => {
    const runFrame = manualAnimationFrames();
    const app = new RenderOnlyApp();
    const shell: unknown = Reflect.get(app, "appShell");
    const controller: unknown = Reflect.get(app, "sessions");
    if (!(shell instanceof AppShellController) || !(controller instanceof SessionController)) throw new Error("Expected app controllers");
    shell.isMobileNavigationLayout = true;
    shell.isDesktopSideBySideLayout = false;
    let deferred = true;
    vi.spyOn(controller, "isChatLoadDeferred", "get").mockImplementation(() => deferred);
    vi.spyOn(controller, "loadSelectedSession").mockImplementation(() => {
      deferred = false;
      app.requestUpdate();
      return Promise.resolve();
    });
    patchState(app, { selectedWorkspace: workspace, selectedSession: session, mainView: "navigation" });
    document.body.append(app);
    await settle(app);
    const focus: unknown = Reflect.get(app, "openChatAndFocusComposer");
    if (typeof focus !== "function") throw new Error("Expected Chat navigation action");
    const focusing: unknown = Reflect.apply(focus, app, []);
    await settle(app);
    runFrame();
    await settle(app);
    expect(app.shadowRoot?.querySelector("prompt-editor")).toBeNull();
    runFrame();
    await focusing;
    await settle(app);
    const editor = app.shadowRoot?.querySelector("prompt-editor");
    expect(editor).toBeInstanceOf(PromptEditor);
    expect(deepActiveElement(document)).toBe(editor?.shadowRoot?.querySelector(".cm-content"));
  });

  it.each(["hide", "disconnect"] as const)("cancels scheduled Chat loading when the shell changes before paint: %s", async (action) => {
    const runFrame = manualAnimationFrames();
    const app = new RenderOnlyApp();
    const shell: unknown = Reflect.get(app, "appShell");
    const controller: unknown = Reflect.get(app, "sessions");
    if (!(shell instanceof AppShellController) || !(controller instanceof SessionController)) throw new Error("Expected app controllers");
    shell.isMobileNavigationLayout = true;
    shell.isDesktopSideBySideLayout = false;
    vi.spyOn(controller, "isChatLoadDeferred", "get").mockReturnValue(true);
    const load = vi.spyOn(controller, "loadSelectedSession").mockResolvedValue(undefined);
    patchState(app, { selectedWorkspace: workspace, selectedSession: session, mainView: "chat" });
    document.body.append(app);
    await settle(app);
    runFrame();
    if (action === "disconnect") app.remove();
    else {
      patchState(app, { mainView: "navigation" });
      await settle(app);
    }
    runFrame();
    expect(load).not.toHaveBeenCalled();
  });

  it.each(["chat", "workspace"] as const)("collapses a wide workspace panel to Chat and restores three columns from %s", async (mainView) => {
    const app = await mountApp({ selectedWorkspace: workspace, workspaces: [workspace], mainView }, () => html`<p>Tool content</p>`);
    const shell: unknown = Reflect.get(app, "appShell");
    if (!(shell instanceof AppShellController)) throw new Error("Expected shell controller");
    shell.isDesktopSideBySideLayout = true;
    shell.isMobileNavigationLayout = false;
    app.requestUpdate();
    await settle(app);
    const layout = () => app.shadowRoot?.querySelector(".shell");
    const panelButton = (label: string) => panelToggle(app, label);
    const tabs = () => [...app.shadowRoot?.querySelector("app-mobile-main-tabs")?.shadowRoot?.querySelectorAll<HTMLButtonElement>(".mobile-tabs button") ?? []];
    expect(layout()?.classList.contains("two-column-layout")).toBe(false);
    expect(tabs().map((button) => button.title)).not.toContain("Chat");
    const collapse = panelButton("Collapse workspace panel");
    expect(collapse.closest("header")).not.toBeNull();
    collapse.focus();
    collapse.click();
    await settle(app);
    expect(layout()?.classList.contains("two-column-layout")).toBe(true);
    expect(deepActiveElement(document)).toBe(panelButton("Expand workspace panel"));
    expect(tabs().find((button) => button.title === "Chat")?.classList.contains("selected")).toBe(true);
    tabs().find((button) => button.title === "Test")?.click();
    await settle(app);
    expect(layout()?.classList.contains("workspace-view")).toBe(true);
    expect(tabs().find((button) => button.title === "Test")?.classList.contains("selected")).toBe(true);
    expect(app.shadowRoot?.querySelector("workspace-panel")?.shadowRoot?.querySelector("header")).toBeNull();
    expect(app.shadowRoot?.querySelector("workspace-panel")?.shadowRoot?.textContent).toContain("Tool content");
    tabs().find((button) => button.title === "Chat")?.click();
    await settle(app);
    expect(layout()?.classList.contains("chat-view")).toBe(true);
    const expand = panelButton("Expand workspace panel");
    expand.focus();
    expand.click();
    await settle(app);
    expect(layout()?.classList.contains("two-column-layout")).toBe(false);
    expect(tabs().map((button) => button.title)).not.toContain("Chat");
    expect(app.shadowRoot?.querySelector("workspace-panel")?.shadowRoot?.textContent).toContain("Tool content");
    expect(app.shadowRoot?.querySelector("workspace-panel")?.shadowRoot?.querySelector("header")).not.toBeNull();
  });

  it.each([false, true])("uses only the shared tool tabs in a narrow layout (mobile: %s)", async (mobile) => {
    const app = await mountApp({ selectedWorkspace: workspace, workspaces: [workspace], mainView: "workspace" }, () => html`<p>Tool content</p>`);
    const shell: unknown = Reflect.get(app, "appShell");
    if (!(shell instanceof AppShellController)) throw new Error("Expected shell controller");
    shell.isDesktopSideBySideLayout = false;
    shell.isMobileNavigationLayout = mobile;
    app.requestUpdate();
    await settle(app);

    expect(app.shadowRoot?.querySelector("app-mobile-main-tabs")?.shadowRoot?.querySelector('button[title="Test"]')).not.toBeNull();
    expect(app.shadowRoot?.querySelector("workspace-panel")?.shadowRoot?.querySelector("header")).toBeNull();
    expect(app.shadowRoot?.querySelector("workspace-panel")?.shadowRoot?.textContent).toContain("Tool content");
  });

  it("moves navigation collapse and expand actions between top bars without leaving buttons in resize rails", async () => {
    const app = await mountApp({ selectedWorkspace: workspace, workspaces: [workspace], mainView: "chat" });
    const shell: unknown = Reflect.get(app, "appShell");
    if (!(shell instanceof AppShellController)) throw new Error("Expected shell controller");
    shell.isDesktopSideBySideLayout = true;
    shell.isMobileNavigationLayout = false;
    app.requestUpdate();
    await settle(app);

    const collapse = panelToggle(app, "Collapse navigation panel");
    expect(collapse.closest("header")).not.toBeNull();
    collapse.focus();
    collapse.click();
    await settle(app);
    const expand = panelToggle(app, "Expand navigation panel");
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    expect(deepActiveElement(document)).toBe(expand);
    expect(app.shadowRoot?.querySelector("app-mobile-main-tabs")?.hasAttribute("panel-controls")).toBe(true);
    expand.click();
    await settle(app);
    expect(deepActiveElement(document)).toBe(panelToggle(app, "Collapse navigation panel"));
    expect(panelToggle(app, "Collapse navigation panel").getAttribute("aria-expanded")).toBe("true");
    for (const edge of app.shadowRoot?.querySelectorAll("app-panel-edge-control") ?? []) {
      expect(edge.shadowRoot?.querySelector("button")).toBeNull();
      expect(edge.shadowRoot?.querySelector('[role="separator"]')).not.toBeNull();
    }
  });

  it("reactively filters navigation at both layout boundaries without losing hidden pins", async () => {
    let width = 1181;
    const originalMatchMedia = window.matchMedia.bind(window);
    const media = new Map<string, MediaQueryList>();
    const matches = (query: string) => query === "(min-width: 1181px)" ? width > 1180
      : query === "(max-width: 760px)" ? width <= 760 : false;
    vi.spyOn(window, "matchMedia").mockImplementation((query) => {
      let result = media.get(query);
      if (result === undefined) {
        result = originalMatchMedia(query);
        vi.spyOn(result, "matches", "get").mockImplementation(() => matches(query));
        media.set(query, result);
      }
      return result;
    });
    const app = await mountApp({ selectedWorkspace: workspace, workspaces: [workspace], mainView: "chat" }, () => html`<p>Tool</p>`);
    await settle(app);
    app.shadowRoot?.querySelector("workspace-panel")?.shadowRoot?.querySelector<HTMLButtonElement>('button[aria-label="Navigation"]')?.click();
    await settle(app);
    const dialog = app.shadowRoot?.querySelector<NavigationDialog>("navigation-dialog");
    if (dialog == null) throw new Error("Expected open navigation");
    const destinations = () => dialog.tabs.map((tab) => tab.id);
    const tabIds = () => [...app.shadowRoot?.querySelector("app-mobile-main-tabs")?.shadowRoot?.querySelectorAll<HTMLButtonElement>('.mobile-tabs button') ?? []].map((button) => button.title);
    const resize = async (next: number) => {
      const previous = new Map([...media].map(([query]) => [query, matches(query)]));
      width = next;
      for (const [query, list] of media) {
        if (previous.get(query) !== matches(query)) list.dispatchEvent(Object.assign(new Event("change"), { matches: matches(query) }));
      }
      await settle(app);
      expect(app.shadowRoot?.querySelector("navigation-dialog")).toBe(dialog);
    };
    expect(destinations()).toEqual(["render-test:panel"]);
    expect(dialog.selectedTab).toBe("render-test:panel");
    expect(dialog.shadowRoot?.querySelector('.destination-button[aria-pressed="true"]')?.textContent).toBe("Test");
    expect(tabIds()).not.toContain("Chat");
    expect(dialog.pinUniverse).toEqual(["navigation", "chat", "render-test:panel"]);
    for (const [next, expected] of [
      [1180, ["chat", "render-test:panel"]],
      [761, ["chat", "render-test:panel"]],
      [760, ["navigation", "chat", "render-test:panel"]],
      [761, ["chat", "render-test:panel"]],
      [1181, ["render-test:panel"]],
    ] as const) {
      await resize(next);
      expect(destinations()).toEqual(expected);
      expect(dialog.selectedTab).toBe(next > 1180 ? "render-test:panel" : "chat");
      const labels: Record<string, string> = { navigation: "Sessions", chat: "Chat", "render-test:panel": "Test" };
      expect(tabIds()).toEqual([...expected.map((id) => labels[id]), "Navigation"]);
      expect(loadNavigationPreferences().pinnedIds).toEqual([]);
    }
    const search = dialog.shadowRoot?.querySelector("input");
    if (search == null) throw new Error("Expected search");
    search.value = "Test";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await settle(app);
    dialog.shadowRoot?.querySelector<HTMLButtonElement>('button[aria-label="Pin Test"]')?.click();
    await settle(app);
    expect(loadNavigationPreferences().pinnedIds).toEqual(["navigation", "chat"]);
    await resize(760);
    expect(loadNavigationPreferences().pinnedIds).toEqual(["navigation", "chat"]);
    expect(tabIds()).toEqual(["Sessions", "Chat", "Navigation"]);
    search.value = "";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await settle(app);
    dialog.shadowRoot?.querySelector<HTMLButtonElement>('button[aria-label="Pin Chat"]')?.click();
    await settle(app);
    await resize(1181);
    dialog.shadowRoot?.querySelector<HTMLButtonElement>('button[aria-label="Pin Test"]')?.click();
    await settle(app);
    expect(loadNavigationPreferences().pinnedIds).toEqual(["navigation", "render-test:panel"]);
    await resize(760);
    expect(tabIds()).toEqual(["Sessions", "Test", "Navigation"]);
  });
  it.each([
    { mobile: true, desktop: false, view: "chat", pins: ["navigation"], selected: true },
    { mobile: true, desktop: false, view: "chat", pins: ["chat"], selected: false },
    { mobile: true, desktop: false, view: "chat", pins: [], selected: false },
    { mobile: false, desktop: false, view: "navigation", pins: ["chat"], selected: false },
    { mobile: false, desktop: true, view: "chat", pins: ["navigation"], selected: false },
  ] as const)("highlights only available hidden mobile destinations: %j", async ({ mobile, desktop, view, pins, selected }) => {
    saveNavigationPreferences({ pinnedIds: [...pins], mobileCollapsed: false });
    const app = await mountApp({ mainView: view });
    const shell: unknown = Reflect.get(app, "appShell");
    if (!(shell instanceof AppShellController)) throw new Error("Expected shell controller");
    shell.isMobileNavigationLayout = mobile;
    shell.isDesktopSideBySideLayout = desktop;
    app.requestUpdate();
    await settle(app);
    const menu = app.shadowRoot?.querySelector("app-mobile-main-tabs")?.shadowRoot?.querySelector('button[aria-label="Navigation"]');
    expect(menu).not.toBeNull();
    expect(menu?.classList.contains("selected")).toBe(selected);
  });

  it.each([
    { desktop: true, collapsed: false },
    { desktop: false, collapsed: false },
    { desktop: false, collapsed: true },
  ])("does not select or highlight a fallback for unavailable destinations: %j", async ({ desktop, collapsed }) => {
    saveNavigationPreferences({ pinnedIds: ["chat"], mobileCollapsed: collapsed });
    const app = await mountApp({ selectedWorkspace: workspace, workspaces: [workspace], mainView: "workspace", workspaceTool: "render-test:panel" }, () => html`<p>Remembered content</p>`);
    const shell: unknown = Reflect.get(app, "appShell");
    if (!(shell instanceof AppShellController)) throw new Error("Expected shell controller");
    shell.isDesktopSideBySideLayout = desktop;
    shell.isMobileNavigationLayout = !desktop;
    for (const tool of ["missing:panel", "unknown-alias"]) {
      window.history.replaceState(null, "", `/?view=workspace&tool=${encodeURIComponent(tool)}`);
      app.requestUpdate();
      await settle(app);
      const panel = app.shadowRoot?.querySelector("workspace-panel");
      expect(panel?.shadowRoot?.textContent).toContain(`Workspace panel unavailable: ${tool}`);
      expect(panel?.shadowRoot?.querySelector(".panel-content")).toBeNull();
      const surface = app.shadowRoot?.querySelector(desktop ? "workspace-panel" : collapsed ? "app-context-bar" : "app-mobile-main-tabs");
      const menu = surface?.shadowRoot?.querySelector<HTMLButtonElement>('button[aria-label="Navigation"]');
      expect(menu).not.toBeNull();
      expect(menu?.classList.contains("selected")).toBe(false);
      expect(surface?.shadowRoot?.querySelector('button[aria-pressed="true"]')).toBeNull();
      menu?.click();
      await settle(app);
      const dialog = app.shadowRoot?.querySelector<NavigationDialog>("navigation-dialog");
      expect(dialog?.selectedTab).toBeUndefined();
      expect(dialog?.shadowRoot?.querySelector('.destination-button[aria-pressed="true"]')).toBeNull();
      dialog?.shadowRoot?.querySelector<HTMLButtonElement>('button[aria-label="Close"]')?.click();
      await settle(app);
      expect(new URLSearchParams(window.location.search).get("tool")).toBe(tool);
    }
  });

  it.each(["chat", "workspace"] as const)("collapsed mobile navigation selects the visible destination, not the remembered tool: %s", async (mainView) => {
    saveNavigationPreferences({ pinnedIds: ["chat"], mobileCollapsed: true });
    const app = await mountApp({ selectedWorkspace: workspace, workspaces: [workspace], mainView, workspaceTool: "render-test:panel" }, () => html`<p>Tool content</p>`);
    const shell: unknown = Reflect.get(app, "appShell");
    if (!(shell instanceof AppShellController)) throw new Error("Expected shell controller");
    shell.isDesktopSideBySideLayout = false;
    shell.isMobileNavigationLayout = true;
    app.requestUpdate();
    await settle(app);
    const menu = app.shadowRoot?.querySelector("app-context-bar")?.shadowRoot?.querySelector<HTMLButtonElement>('button[aria-label="Navigation"]');
    expect(menu?.classList.contains("selected")).toBe(true);
    menu?.click();
    await settle(app);
    const dialog = app.shadowRoot?.querySelector<NavigationDialog>("navigation-dialog");
    expect(dialog?.selectedTab).toBe(mainView === "workspace" ? "render-test:panel" : "chat");
    expect(dialog?.shadowRoot?.querySelector('.destination-button[aria-pressed="true"]')?.textContent).toBe(mainView === "workspace" ? "Test" : "Chat");
  });

  it("selects workspace tools from Navigation without confusing tool IDs with views", async () => {
    const app = await mountApp({ selectedWorkspace: workspace, workspaces: [workspace], mainView: "chat" }, () => html`<p>Tool content</p>`);
    await settle(app);
    app.shadowRoot?.querySelector("app-mobile-main-tabs")?.shadowRoot?.querySelector<HTMLButtonElement>('button[aria-label="Navigation"]')?.click();
    await settle(app);
    const dialog = app.shadowRoot?.querySelector<NavigationDialog>("navigation-dialog");
    const tool = [...dialog?.shadowRoot?.querySelectorAll<HTMLButtonElement>(".destination-button") ?? []].find((button) => button.textContent === "Test");
    expect(tool).toBeDefined();
    tool?.click();
    await settle(app);
    expect(Reflect.get(app, "state")).toMatchObject({ mainView: "workspace", workspaceTool: "render-test:panel" });
    expect(new URLSearchParams(window.location.search).get("tool")).toBe("render-test:panel");
    expect(app.shadowRoot?.querySelector("navigation-dialog")).toBeNull();
  });

  it("opens Navigation through Actions and restores the pre-palette focus on Escape", async () => {
    const originalFocus = document.createElement("button");
    document.body.append(originalFocus);
    originalFocus.focus();
    const app = await mountApp({ actionPaletteOpen: true }, () => html``);
    Reflect.set(app, "shortcutConfig", { "app.navigation.open": "mod+shift+n" });
    await settle(app);
    const palette = app.shadowRoot?.querySelector<ActionPalette>("action-palette");
    const action = palette?.actions.find((candidate) => candidate.id === "app.navigation.open");
    expect(action?.title).toBe("Open Navigation");
    expect(action?.shortcut).toBe("mod+shift+n");
    const button = [...palette?.shadowRoot?.querySelectorAll<HTMLButtonElement>(".options button") ?? []].find((candidate) => candidate.textContent.includes("Open Navigation"));
    expect(button).toBeDefined();
    button?.click();
    await settle(app);
    expect(app.shadowRoot?.querySelector("action-palette")).toBeNull();
    const dialog = app.shadowRoot?.querySelector<NavigationDialog>("navigation-dialog");
    expect(dialog).toBeInstanceOf(NavigationDialog);
    expect(deepActiveElement(document)).toBe(dialog?.shadowRoot?.querySelector("input"));
    deepActiveElement(document)?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }));
    await settle(app);
    expect(app.shadowRoot?.querySelector("navigation-dialog")).toBeNull();
    expect(deepActiveElement(document)).toBe(originalFocus);
  });
  it("updates shared tabs from pin controls without changing selected content, and reloads preferences", async () => {
    const app = await mountApp({ selectedWorkspace: workspace, workspaces: [workspace], workspaceTool: "render-test:panel", mainView: "workspace" }, () => html`<p>Selected tool content</p>`);
    await settle(app);
    const workspacePanel = app.shadowRoot?.querySelector("workspace-panel");
    const open = app.shadowRoot?.querySelector("app-mobile-main-tabs")?.shadowRoot?.querySelector<HTMLButtonElement>('button[aria-label="Navigation"]');
    expect(open).not.toBeNull();
    expect(workspacePanel?.shadowRoot?.querySelector("header")).toBeNull();
    expect(open?.querySelector("svg")).not.toBeNull();
    expect(open?.classList.contains("selected")).toBe(false);
    const tabStrip = app.shadowRoot?.querySelector("app-mobile-main-tabs");
    expect(tabStrip?.shadowRoot?.querySelector(".mobile-tabs > button:last-child")?.getAttribute("aria-label")).toBe("Navigation");
    expect(tabStrip?.shadowRoot?.querySelector('button[aria-label="Navigation"]')?.classList.contains("selected")).toBe(false);
    open?.click();
    await settle(app);
    const dialog = app.shadowRoot?.querySelector("navigation-dialog");
    if (!(dialog instanceof NavigationDialog)) throw new Error("Expected Navigation dialog");
    dialog.shadowRoot?.querySelector<HTMLButtonElement>('button[aria-label="Pin Test"]')?.click();
    await settle(app);
    expect(open?.classList.contains("selected")).toBe(true);
    expect(tabStrip?.shadowRoot?.querySelector('button[aria-label="Navigation"]')?.classList.contains("selected")).toBe(true);
    expect(open?.hasAttribute("aria-expanded")).toBe(false);
    expect(open?.getAttribute("aria-label")).toBe("Navigation");
    expect(workspacePanel?.shadowRoot?.querySelector('button[title="Test"]')).toBeNull();
    expect(app.shadowRoot?.querySelector("app-mobile-main-tabs")?.shadowRoot?.querySelector('button[title="Test"]')).toBeNull();
    expect(workspacePanel?.shadowRoot?.querySelector(".panel-content")?.textContent).toContain("Selected tool content");
    expect(loadNavigationPreferences().pinnedIds).toEqual(["navigation", "chat"]);
    expect(dialog.shadowRoot?.querySelector('button[aria-label="Pin Test"]')).not.toBeNull();
    dialog.shadowRoot?.querySelector<HTMLButtonElement>('button[aria-label="Pin Test"]')?.click();
    await settle(app);
    expect(open?.classList.contains("selected")).toBe(false);
    expect(tabStrip?.shadowRoot?.querySelector('button[aria-label="Navigation"]')?.classList.contains("selected")).toBe(false);
    expect(tabStrip?.shadowRoot?.querySelector('button[title="Test"]')?.classList.contains("selected")).toBe(true);
    expect(workspacePanel?.shadowRoot?.querySelector(".panel-content")?.textContent).toContain("Selected tool content");
    document.body.replaceChildren();
    const reloaded = await mountApp({});
    await settle(reloaded);
    expect(Reflect.get(reloaded, "navigationPreferences")).toEqual(loadNavigationPreferences());
  });

  it("collapses only the mobile tab bar, keeping breadcrumbs and separate Navigation and Actions controls", async () => {
    saveNavigationPreferences({ pinnedIds: [], mobileCollapsed: true });
    const { app } = await mountMobileNavigationApp({
      selectedProject: { id: "project", name: "Project", path: "/repo", createdAt: "now" },
      selectedWorkspace: workspace, selectedSession: session, mainView: "navigation",
    });
    expect(app.shadowRoot?.querySelector("app-mobile-main-tabs")).toBeNull();
    const context = app.shadowRoot?.querySelector("app-context-bar");
    expect(context?.shadowRoot?.querySelector('nav[aria-label="Current location"]')).not.toBeNull();
    for (const [kind, label] of [["Project", "Project"], ["Workspace", "main"], ["Session", "Current chat"]] as const) {
      expect(context?.shadowRoot?.querySelector(`button[aria-label^="${kind}:"]`)?.textContent).toContain(label);
    }
    const navigation = namedButton(context?.shadowRoot, "Navigation");
    const actions = namedButton(context?.shadowRoot, "Show Actions");
    expect(navigation).not.toBe(actions);
    expect(navigation.classList.contains("selected")).toBe(true);
    navigation.click();
    await settle(app);
    const dialog = app.shadowRoot?.querySelector("navigation-dialog");
    expect(dialog).toBeInstanceOf(NavigationDialog);
    namedButton(dialog?.shadowRoot, "Expanded").click();
    await settle(app);
    const tabStrip = app.shadowRoot?.querySelector("app-mobile-main-tabs");
    expect(tabStrip).not.toBeNull();
    expect(context?.shadowRoot?.querySelector('button[aria-label="Navigation"]')).toBeNull();
    expect(namedButton(tabStrip?.shadowRoot, "Navigation").classList.contains("selected")).toBe(false);
    expect(loadNavigationPreferences()).toEqual({ pinnedIds: [], mobileCollapsed: false });
  });

  it("restores focus to the replacement Navigation control after expanding mobile tabs", async () => {
    saveNavigationPreferences({ pinnedIds: [], mobileCollapsed: true });
    const { app } = await mountMobileNavigationApp();
    const navigation = namedButton(app.shadowRoot?.querySelector("app-context-bar")?.shadowRoot, "Navigation");
    navigation.focus();
    navigation.click();
    await settle(app);
    const dialog = app.shadowRoot?.querySelector("navigation-dialog");
    namedButton(dialog?.shadowRoot, "Expanded").click();
    await settle(app);
    const replacement = namedButton(app.shadowRoot?.querySelector("app-mobile-main-tabs")?.shadowRoot, "Navigation");
    expect(navigation.isConnected).toBe(false);
    namedButton(dialog?.shadowRoot, "Close").click();
    await settle(app);
    expect(app.shadowRoot?.querySelector("navigation-dialog")).toBeNull();
    expect(deepActiveElement(document)).toBe(replacement);
    replacement.click();
    await settle(app);
    expect(app.shadowRoot?.querySelector("navigation-dialog")).toBeInstanceOf(NavigationDialog);
  });

  it("restores tabs outside the mobile layout without losing the mobile collapse preference", async () => {
    saveNavigationPreferences({ pinnedIds: [], mobileCollapsed: false });
    const { app, shell } = await mountMobileNavigationApp();
    namedButton(app.shadowRoot?.querySelector("app-mobile-main-tabs")?.shadowRoot, "Navigation").click();
    await settle(app);
    namedButton(app.shadowRoot?.querySelector("navigation-dialog")?.shadowRoot, "Collapsed").click();
    await settle(app);
    expect(app.shadowRoot?.querySelector("app-mobile-main-tabs")).toBeNull();
    expect(loadNavigationPreferences().mobileCollapsed).toBe(true);

    shell.isMobileNavigationLayout = false;
    app.requestUpdate();
    await settle(app);
    expect(app.shadowRoot?.querySelector("app-mobile-main-tabs")).not.toBeNull();
    expect(loadNavigationPreferences().mobileCollapsed).toBe(true);

    shell.isMobileNavigationLayout = true;
    app.requestUpdate();
    await settle(app);
    expect(app.shadowRoot?.querySelector("app-mobile-main-tabs")).toBeNull();
  });

  it("composes transcript, composer, and status under one conversation boundary", async () => {
    const status = { ...sessionStatus(session.id), isStreaming: true };
    const app = await mountApp({ selectedSession: session, status });
    await settle(app);
    const layout = app.shadowRoot?.querySelector<ConversationLayout>("conversation-layout");
    expect(layout).toBeInstanceOf(ConversationLayout);
    expect(layout?.status).toEqual(status);
    expect(layout?.querySelector("chat-view")).toBeInstanceOf(ChatView);
    expect(layout?.querySelector('[slot="composer"] prompt-editor')).toBe(promptEditor(app));
    expect(layout?.querySelector('[slot="status"]')).toBeInstanceOf(StatusBar);
    await layout?.updateComplete;
    expect(layout?.shadowRoot?.querySelector(".activity-text")?.textContent).toBe("running");
  });

  it("updates the cross-instance alert, accessible name and dismissal control live in both pseudo modes", async () => {
    const app = await mountApp({ selectedSession: session, status: { ...sessionStatus(session.id), recentlyActiveElsewhere: true } });
    await settle(app);
    const editor = promptEditor(app);
    const notice = app.shadowRoot?.querySelector(".composer-activity-notice");
    if (notice == null) throw new Error("Missing activity alert");
    const button = notice.querySelector("button");
    if (button == null) throw new Error("Missing acknowledgement button");
    for (const language of ["en-XA", "ar-XB"]) {
      await localization.setPreferences({ language, formatLocale: "en" });
      await settle(app);
      expect(notice.getAttribute("aria-label")).toBe(appFeedbackMessages.t("activityLabel"));
      expect(notice.querySelector("p")?.textContent).toBe(appFeedbackMessages.t("activityNotice"));
      expect(button.textContent).toBe(appFeedbackMessages.t("dismissActivity"));
      expect(button.textContent).not.toBe("Dismiss and continue");
      expect(editor.disabled).toBe(true);
    }
    button.click();
    await settle(app);
    expect(app.shadowRoot?.querySelector(".composer-activity-notice")).toBeNull();
    expect(editor.disabled).toBe(false);
  });

  it("updates deferred conversation-loading guidance live without mounting the transcript", async () => {
    manualAnimationFrames();
    const app = new RenderOnlyApp();
    const controller: unknown = Reflect.get(app, "sessions");
    if (!(controller instanceof SessionController)) throw new Error("Missing sessions");
    vi.spyOn(controller, "isChatLoadDeferred", "get").mockReturnValue(true);
    patchState(app, { selectedWorkspace: workspace, selectedSession: session, mainView: "chat" });
    document.body.append(app);
    await settle(app);
    for (const language of ["en-XA", "ar-XB"]) {
      await localization.setPreferences({ language, formatLocale: "en" });
      await settle(app);
      expect(app.shadowRoot?.querySelector('[role="status"]')?.textContent).toBe(appFeedbackMessages.t("loadingConversation"));
      expect(app.shadowRoot?.querySelector('[role="status"]')?.textContent).not.toBe("Loading conversation…");
      expect(app.shadowRoot?.querySelector("chat-view")).toBeNull();
    }
  });

  it("updates Notices availability without changing routes or pins and scopes dismiss requests to the current session", async () => {
    saveNavigationPreferences({ pinnedIds: ["chat", "core:notices"], mobileCollapsed: false });
    const dismiss = vi.spyOn(SessionController.prototype, "dismissWarning").mockResolvedValue(undefined);
    const snapshot = sessionStatus(session.id, [{ severity: "warning", message: "Persistent condition", dismiss: { id: "billing" } }]);
    const { app } = await mountMobileNavigationApp({ selectedSession: session, selectedWorkspace: workspace, status: snapshot, mainView: "chat" });
    const tabs = app.shadowRoot?.querySelector<AppMobileMainTabs>("app-mobile-main-tabs");
    expect(tabs?.tabs.find((tab) => tab.id === "core:notices")?.badge).toBe(1);
    tabs?.onSelect?.("core:notices"); await settle(app);
    const panel = app.shadowRoot?.querySelector<WorkspacePanel>("workspace-panel");
    panel?.shadowRoot?.querySelector("session-notices-panel")?.shadowRoot?.querySelector<HTMLButtonElement>(".session-warning-dismiss")?.click();
    expect(dismiss).toHaveBeenCalledWith("billing");
    panel?.dispatchEvent(new CustomEvent("session-notice-dismiss", { detail: { machineId: "other", sessionId: session.id, dismissId: "billing" } }));
    expect(dismiss).toHaveBeenCalledOnce();
    const url = window.location.href;
    patchState(app, { status: sessionStatus(session.id) }); await settle(app);
    expect(tabs?.tabs.some((tab) => tab.id === "core:notices")).toBe(false);
    expect(panel?.shadowRoot?.querySelector("session-notices-panel")).toBeNull();
    expect(panel?.error).not.toBe("");
    expect(window.location.href).toBe(url);
    expect(loadNavigationPreferences().pinnedIds).toEqual(["chat", "core:notices"]);
    patchState(app, { status: snapshot }); await settle(app);
    expect(tabs?.tabs.some((tab) => tab.id === "core:notices")).toBe(true);
    expect(panel?.shadowRoot?.querySelector("session-notices-panel")?.status?.warnings).toEqual(snapshot.warnings);
  });

  it.each([false, true])("places Notices after Chat, or first when Chat has no tab (desktop=%s)", async (desktop) => {
    const app = new RenderOnlyApp();
    patchState(app, { selectedSession: session, selectedWorkspace: workspace, status: sessionStatus(session.id, [{ severity: "warning", message: "Persistent condition" }]), mainView: "chat" });
    const registry: unknown = Reflect.get(app, "plugins");
    if (!(registry instanceof PluginRegistry)) throw new Error("Expected plugin registry");
    Reflect.set(app, "verifiedPluginModeByMachine", new Map([["local", "recovery-disabled"]]));
    await registry.register({ id: "ordered-panel", plugin: { apiVersion: 5, name: "Ordered panel", activate: () => ({ contributions: {
      applicationPanels: [{ id: "files", title: "Files", order: 10, render: () => html`Files` }],
    } }) } });
    const shell: unknown = Reflect.get(app, "appShell");
    if (!(shell instanceof AppShellController)) throw new Error("Expected shell controller");
    shell.isDesktopSideBySideLayout = desktop;
    shell.isMobileNavigationLayout = !desktop;
    document.body.append(app); await settle(app);
    if (desktop) {
      const panel = app.shadowRoot?.querySelector<WorkspacePanel>("workspace-panel");
      expect(panel?.panels.map(({ id }) => id)).toEqual(["core:notices", "ordered-panel:files"]);
    } else {
      const tabs = app.shadowRoot?.querySelector<AppMobileMainTabs>("app-mobile-main-tabs");
      const ids = tabs?.tabs.map(({ id }) => id) ?? [];
      expect(ids.slice(ids.indexOf("chat"))).toEqual(["chat", "core:notices", "ordered-panel:files"]);
    }
  });

  it("keeps the activity notice in the blocked composer until dismissal without losing drafts or attachments", async () => {
    const send = vi.spyOn(SessionController.prototype, "send").mockResolvedValue(true);
    const key = machineSessionKey("local", session.id);
    saveDraft(key, "Unsent draft");
    saveStagedAttachments(key, [{ id: "file", kind: "file", name: "notes.txt", mimeType: "text/plain", data: "aGk=", size: 2 }]);
    const app = await mountApp({ selectedSession: session, status: sessionStatus(session.id) });
    await settle(app);
    const editor = promptEditor(app);
    expect(editor.disabled).toBe(false);

    patchState(app, { status: { ...sessionStatus(session.id, [{ severity: "warning", message: "Ordinary runtime warning" }]), recentlyActiveElsewhere: true } });
    await settle(app);
    const notice = app.shadowRoot?.querySelector(".composer-activity-notice");
    expect(notice?.getAttribute("role")).toBe("alert");
    expect(notice?.textContent).toContain("Recently active in another PI-WEB instance");
    expect(notice?.parentElement).toBe(editor.parentElement);
    expect(editor.parentElement?.classList.contains("composer-area")).toBe(true);
    expect(notice?.previousElementSibling).toBe(editor);
    expect(editor.hasAttribute("inert")).toBe(true);
    expect(editor.disabled).toBe(true);
    expect(editor.view?.contentDOM.getAttribute("contenteditable")).toBe("false");
    const sendButton = editor.shadowRoot?.querySelector<HTMLButtonElement>(".send-button");
    expect(sendButton?.disabled).toBe(true);
    sendButton?.click();
    editor.view?.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, composed: true }));
    expect(send).not.toHaveBeenCalled();

    const chat = app.shadowRoot?.querySelector("chat-view");
    expect(chat?.hasAttribute("inert")).toBe(false);
    expect(chat?.shadowRoot?.textContent).not.toContain("Recently active in another PI-WEB instance");
    expect(chat?.shadowRoot?.textContent).not.toContain("Ordinary runtime warning");
    expect(app.shadowRoot?.querySelector(".composer-activity-notice")).toBe(notice);
    expect(editor.disabled).toBe(true);

    dismissActivityNotice(app);
    await settle(app);
    expect(app.shadowRoot?.querySelector(".composer-activity-notice")).toBeNull();
    expect(promptEditor(app)).toBe(editor);
    expect(editor.hasAttribute("inert")).toBe(false);
    expect(editor.disabled).toBe(false);
    expect(editor.view?.contentDOM.getAttribute("contenteditable")).toBe("true");
    expect(editor.view?.state.doc.toString()).toBe("Unsent draft");
    expect(editor.shadowRoot?.querySelector(".attachments")?.textContent).toContain("notes.txt");
    expect(deepActiveElement(document)).toBe(editor.view?.contentDOM);
    sendButton?.click();
    expect(send).toHaveBeenCalledOnce();
  });

  it("scopes activity acknowledgement by machine/session and asks again after activity elsewhere clears", async () => {
    const status = { ...sessionStatus(session.id), recentlyActiveElsewhere: true };
    const app = await mountApp({ selectedSession: session, status });
    await settle(app);
    dismissActivityNotice(app);
    await settle(app);
    expect(promptEditor(app).disabled).toBe(false);
    // Missing activity information, a stale session status, or unrelated warnings must not erase acknowledgement.
    patchState(app, { status: undefined });
    await settle(app);
    const missingActivityStatus: SessionStatus = { ...status };
    delete missingActivityStatus.recentlyActiveElsewhere;
    patchState(app, { status: missingActivityStatus });
    await settle(app);
    patchState(app, { status: sessionStatus("unrelated-session") });
    await settle(app);
    patchState(app, { status: { ...status, warnings: [{ severity: "warning", message: "New runtime warning" }] } });
    await settle(app);
    expect(promptEditor(app).disabled).toBe(false);

    const otherSession = { ...session, id: "other-session" };
    patchState(app, { selectedSession: otherSession, status: { ...status, sessionId: otherSession.id } });
    await settle(app);
    expect(promptEditor(app).disabled).toBe(true);
    patchState(app, { selectedSession: session, status });
    await settle(app);
    expect(promptEditor(app).disabled).toBe(false);

    patchState(app, { selectedMachine: { id: "remote", name: "Remote", kind: "remote", baseUrl: "https://remote.test", createdAt: "now", updatedAt: "now" } });
    await settle(app);
    expect(promptEditor(app).disabled).toBe(true);
    dismissActivityNotice(app);
    await settle(app);
    expect(promptEditor(app).disabled).toBe(false);
    patchState(app, { selectedMachine: undefined });
    await settle(app);
    expect(promptEditor(app).disabled).toBe(false);

    patchState(app, { status: sessionStatus(session.id) });
    await settle(app);
    patchState(app, { status });
    await settle(app);
    expect(promptEditor(app).disabled).toBe(true);
    expect(app.shadowRoot?.querySelector(".composer-activity-notice")).not.toBeNull();
  });

  it("re-arms the notice when activity clears and resumes while another session is selected", async () => {
    const status = { ...sessionStatus(session.id), recentlyActiveElsewhere: true };
    const app = await mountApp({ selectedSession: session, status, sessionStatuses: { [session.id]: status } });
    await settle(app);
    dismissActivityNotice(app);
    await settle(app);

    const otherSession = { ...session, id: "other-session" };
    patchState(app, { selectedSession: otherSession, status: sessionStatus(otherSession.id) });
    await settle(app);
    patchState(app, { sessionStatuses: { [session.id]: sessionStatus(session.id) } });
    await settle(app);
    patchState(app, { sessionStatuses: { [session.id]: status } });
    await settle(app);
    expect(promptEditor(app).disabled).toBe(false);
    expect(app.shadowRoot?.querySelector(".composer-activity-notice")).toBeNull();

    patchState(app, { selectedSession: session, status });
    await settle(app);
    expect(promptEditor(app).disabled).toBe(true);
    expect(app.shadowRoot?.querySelector(".composer-activity-notice")).not.toBeNull();
  });

  it("does not re-enable archived sessions when the activity notice is dismissed", async () => {
    const app = await mountApp({ selectedSession: { ...session, archived: true }, status: { ...sessionStatus(session.id), recentlyActiveElsewhere: true } });
    await settle(app);
    dismissActivityNotice(app);
    await settle(app);
    expect(app.shadowRoot?.querySelector(".composer-activity-notice")).toBeNull();
    expect(promptEditor(app).disabled).toBe(true);
  });

  it("does not update the selected chat for unrelated shell state, but does update its transcript", async () => {
    const app = await mountApp({ selectedSession: session, sessions: [session], messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }] });
    await settle(app);
    const chat = app.shadowRoot?.querySelector("chat-view");
    if (!(chat instanceof ChatView)) throw new Error("Expected selected chat");
    const render = vi.spyOn(chat, "render");

    patchState(app, { error: "Unrelated shell notice" });
    await settle(app);
    expect(render).not.toHaveBeenCalled();

    patchState(app, { messages: [{ role: "user", parts: [{ type: "text", text: "new transcript" }] }] });
    await settle(app);
    expect(render).toHaveBeenCalledOnce();
    expect(chat.messages[0]?.parts[0]).toEqual({ type: "text", text: "new transcript" });
  });

  it.each(["before", "after"] as const)("updates diagram controls when plugins load %s the transcript without remounting or auto-preview", async (order) => {
    const diagramSession = { ...session, id: `diagram-${order}` };
    const app = await mountApp({ selectedWorkspace: workspace, workspaces: [workspace], mainView: "chat" });
    const messages: AppState["messages"] = [{ role: "assistant", parts: [{ type: "text", text: "```mermaid\ngraph TD; A-->B\n```" }] }];
    if (order === "after") patchState(app, { selectedSession: diagramSession, sessions: [diagramSession], messages });
    await settle(app);
    const initialFormatted = app.shadowRoot?.querySelector("chat-view")?.shadowRoot?.querySelector("formatted-text");
    if (order === "after") {
      expect(initialFormatted).toBeInstanceOf(FormattedText);
      expect(initialFormatted?.shadowRoot?.querySelector(".formatted")?.textContent).toContain("graph TD");
      expect(initialFormatted?.shadowRoot?.querySelector("pi-web-content-renderer")).toBeNull();
    }

    const draw = vi.fn((input: ContentRendererInput) => { void input; return html`<b>Rendered diagram</b>`; });
    const result: ExternalPluginLoadResult = {
      terminalMode: "recovery-disabled", declarations: [{ id: "mermaid" }], failures: [],
      registrations: [{ id: "mermaid", plugin: {
        apiVersion: 5, name: "Mermaid", activate: () => ({ contributions: { contentRenderers: [{
          id: "diagram", title: "Diagram", languages: ["mermaid"], render: draw,
        }] } }),
      } }],
    };
    const register: unknown = Reflect.get(app, "registerExternalPlugins");
    if (typeof register !== "function") throw new Error("Expected plugin registration boundary");
    expect(await register.call(app, "Test plugins", () => Promise.resolve(result))).toBe(true);
    if (order === "before") patchState(app, { selectedSession: diagramSession, sessions: [diagramSession], messages });
    await settle(app);

    const formatted = app.shadowRoot?.querySelector("chat-view")?.shadowRoot?.querySelector("formatted-text");
    if (!(formatted instanceof FormattedText)) throw new Error("Expected formatted chat text");
    await settleDeferredContent(formatted);
    if (order === "after") expect(formatted).toBe(initialFormatted);
    const host = formatted.shadowRoot?.querySelector("pi-web-content-renderer");
    if (!(host instanceof ContentRendererHost)) throw new Error("Expected diagram controls");
    const renderButton = [...host.shadowRoot?.querySelectorAll("button") ?? []].find((button) => button.textContent.trim() === "Diagram");
    expect(renderButton).toBeDefined();
    expect(draw).not.toHaveBeenCalled();
    renderButton?.click();
    await settle(app);
    await settleDeferredContent(host);
    expect(host.shadowRoot?.querySelector("b")?.textContent).toBe("Rendered diagram");
    expect(draw).toHaveBeenCalledOnce();
    const input = draw.mock.calls[0]?.[0];
    expect(input?.signal.aborted).toBe(false);
    const markdownRender = vi.spyOn(formatted, "render");

    const registry: unknown = Reflect.get(app, "plugins");
    if (!(registry instanceof PluginRegistry)) throw new Error("Expected plugin registry");
    await registry.register({ id: "unrelated", plugin: { apiVersion: 4, name: "Unrelated", activate: () => ({ contributions: {} }) } });
    patchState(app, { error: "Unrelated shell update" });
    await settle(app);
    expect(markdownRender).not.toHaveBeenCalled();
    expect(formatted.shadowRoot?.querySelector("pi-web-content-renderer")).toBe(host);
    expect(draw).toHaveBeenCalledOnce();
    expect(input?.signal.aborted).toBe(false);
  });

  it("refreshes guarded surfaces when built-in registration finishes asynchronously", async () => {
    let finishActivation: () => void = () => { throw new Error("Activation gate was not initialized"); };
    const ready = new Promise<void>((resolve) => { finishActivation = resolve; });
    vi.spyOn(corePlugin, "activate").mockImplementationOnce(async () => {
      await ready;
      return { contributions: { workspacePanels: [{
        id: "late-panel", title: "Late panel", render: () => html`<p>Loaded asynchronously</p>`,
      }] } };
    });
    const app = await mountApp({ selectedWorkspace: workspace, workspaces: [workspace] });
    Reflect.set(app, "verifiedPluginModeByMachine", new Map([["local", "recovery-disabled"]]));
    await settle(app);
    expect(app.shadowRoot?.querySelector("workspace-panel")?.shadowRoot?.textContent).not.toContain("Loaded asynchronously");

    finishActivation();
    const registration: unknown = Reflect.get(app, "builtInPluginsReady");
    if (!(registration instanceof Promise)) throw new Error("Expected built-in registration");
    await registration;
    await settle(app);
    expect(app.shadowRoot?.querySelector("workspace-panel")?.shadowRoot?.textContent).toContain("Loaded asynchronously");
  });

  it("keeps navigation lists and workspace tools outside transcript-only updates", async () => {
    const panelRender = vi.fn(() => html`<p>Workspace tool</p>`);
    const app = await mountApp({ selectedWorkspace: workspace, workspaces: [workspace] }, panelRender);
    await settle(app);
    const workspacePanel = app.shadowRoot?.querySelector("workspace-panel");
    if (!(workspacePanel instanceof WorkspacePanel)) throw new Error("Expected workspace panel");
    const workspaceRender = vi.spyOn(workspacePanel, "render");
    const lists = [ProjectList, WorkspaceList, SessionList].map((component) => vi.spyOn(component.prototype, "render"));
    panelRender.mockClear();

    patchState(app, { messages: [{ role: "assistant", parts: [{ type: "text", text: "streaming" }] }] });
    await settle(app);
    expect(workspaceRender).not.toHaveBeenCalled();
    expect(panelRender).not.toHaveBeenCalled();
    for (const render of lists) expect(render).not.toHaveBeenCalled();
  });

  it("refreshes plugin surfaces on explicit invalidation and public context changes", async () => {
    let context: WorkspacePanelContext | undefined;
    let label = "Original";
    const panelRender = vi.fn((next: WorkspacePanelContext) => {
      context = next;
      return html`<p>${label}: ${next.state.selectedSession?.name ?? "no session"}</p>`;
    });
    const app = await mountApp({ selectedWorkspace: workspace, workspaces: [workspace] }, panelRender, () => label);
    await settle(app);
    panelRender.mockClear();

    label = "Refreshed";
    if (context === undefined) throw new Error("Expected plugin context");
    context.host.requestRender();
    await settle(app);
    expect(panelRender).toHaveBeenCalledOnce();
    expect(app.shadowRoot?.querySelector("workspace-panel")?.shadowRoot?.textContent).toContain("Refreshed: no session");
    expect(app.shadowRoot?.querySelector("app-mobile-main-tabs")?.shadowRoot?.querySelector(".tab-badge")?.textContent).toBe("Refreshed");
    const navigation = app.shadowRoot?.querySelector("app-navigation-panel");
    expect(navigation?.shadowRoot?.querySelector("workspace-list")?.shadowRoot?.textContent).toContain("Refreshed");

    panelRender.mockClear();
    patchState(app, { selectedSession: session, sessions: [session] });
    await settle(app);
    expect(panelRender).toHaveBeenCalledOnce();
    expect(app.shadowRoot?.querySelector("workspace-panel")?.shadowRoot?.textContent).toContain("Refreshed: Current chat");
  });

  it("refreshes query and upload capabilities without a workspace change", async () => {
    let context: WorkspacePanelContext | undefined;
    const app = await mountApp({ selectedWorkspace: workspace, workspaces: [workspace] }, (next) => {
      context = next;
      return html`<p>Tool</p>`;
    });
    await settle(app);
    if (context === undefined) throw new Error("Expected plugin context");
    const previousFiles = context.files;

    window.history.replaceState(null, "", "?project=project&workspace=workspace&render-test.panel--item=next");
    app.requestUpdate();
    await settle(app);
    expect(context.navigation?.query["item"]).toBe("next");

    Reflect.set(app, "workspaceUploadDefaultFolder", "new-uploads");
    await settle(app);
    expect(context.files).not.toBe(previousFiles);
    expect(context.files.capabilityVersion).toBe(1);
    if (context.files.capabilityVersion !== 1) throw new Error("Expected files capability");
    expect(context.files.defaultUploadFolder).toBe("new-uploads");
  });

  it("renews workspace navigation after reselecting the active Chat tab", async () => {
    window.history.replaceState(null, "", "?project=project&workspace=workspace&tool=render-test%3Apanel&view=chat");
    let context: WorkspacePanelContext | undefined;
    const app = await mountApp({
      selectedProject: { id: "project", name: "Project", path: "/repo", createdAt: "now" },
      selectedWorkspace: workspace, workspaces: [workspace],
      workspaceTool: "render-test:panel", mainView: "chat",
    }, (next) => {
      context = next;
      return html`<button aria-label="Open folder" @click=${() => next.navigation?.set("folder", "src")}>Open folder</button>`;
    });
    await settle(app);
    const previousContext = context;
    const url = window.location.href;
    const chat = app.shadowRoot?.querySelector("app-mobile-main-tabs")?.shadowRoot?.querySelector<HTMLButtonElement>('button[title="Chat"]');
    if (chat === undefined || chat === null) throw new Error("Expected Chat tab");
    chat.click();
    await settle(app);
    expect(window.location.href).toBe(url);
    expect(previousContext?.navigation?.set("folder", "stale")).toBe(false);

    const folder = app.shadowRoot?.querySelector("workspace-panel")?.shadowRoot?.querySelector('button[aria-label="Open folder"]');
    if (!(folder instanceof HTMLButtonElement)) throw new Error("Expected folder action");
    folder.click();
    await settle(app);
    expect(new URL(window.location.href).searchParams.get("render-test.panel--folder")).toBe("src");
  });

  it("opens chat file links through generic panel navigation and rejects stale workspace requests", async () => {
    const app = await mountApp({
      selectedProject: { id: "project", name: "Project", path: "/repo", createdAt: "now" },
      selectedWorkspace: workspace, workspaces: [workspace], selectedSession: session, sessions: [session],
      mainView: "chat", messages: [{ role: "assistant", parts: [{ type: "text", text: "[file](./reports/a%20%231.txt)" }] }],
    });
    const registry: unknown = Reflect.get(app, "plugins");
    if (!(registry instanceof PluginRegistry)) throw new Error("Expected plugin registry");
    Reflect.set(app, "verifiedPluginModeByMachine", new Map([["local", "recovery-disabled"]]));
    const fileOpenQuery = vi.fn((_context: WorkspacePanelContext, path: string) => ({ file: path }));
    await registry.register({ id: "viewer", plugin: {
      apiVersion: 4, name: "Viewer", activate: () => ({ contributions: { workspacePanels: [{
        id: "files", title: "Viewer", fileOpenQuery,
        render: (context) => html`<p>Selected: ${context.navigation?.query["file"]}</p>`,
      }] } }),
    } });
    await settle(app);
    const chat = app.shadowRoot?.querySelector("chat-view");
    const formatted = chat?.shadowRoot?.querySelector("formatted-text");
    if (!(formatted instanceof FormattedText)) throw new Error("Expected formatted chat text");
    await settleDeferredContent(formatted);
    const anchor = formatted.shadowRoot?.querySelector("a");
    if (!(anchor instanceof HTMLAnchorElement)) throw new Error("Expected file link");
    const detail = { machineId: "local", projectId: "project", workspaceId: "workspace", root: "/repo", path: "reports/a #1.txt" };
    for (const field of ["machineId", "projectId", "workspaceId", "root"] as const) {
      const stale = new CustomEvent("workspace-file-open", {
        detail: { ...detail, [field]: "stale" }, bubbles: true, composed: true, cancelable: true,
      });
      formatted.dispatchEvent(stale);
      expect(stale.defaultPrevented).toBe(false);
    }
    expect(fileOpenQuery).not.toHaveBeenCalled();

    const click = new MouseEvent("click", { bubbles: true, composed: true, cancelable: true });
    anchor.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(fileOpenQuery).toHaveBeenCalledOnce();
    expect(anchor.href).toContain("download=1");
    await settle(app);
    const query = new URL(window.location.href).searchParams;
    expect(query.get("tool")).toBe("viewer:files");
    expect(query.get("viewer.files--file")).toBe("reports/a #1.txt");
    expect(app.shadowRoot?.querySelector("workspace-panel")?.shadowRoot?.textContent).toContain("Selected: reports/a #1.txt");

    await registry.dispose();
    const unhandled = new CustomEvent("workspace-file-open", { detail, bubbles: true, composed: true, cancelable: true });
    formatted.dispatchEvent(unhandled);
    expect(unhandled.defaultPrevented).toBe(false);
  });

  it.each(["session-refresh", "workspace-sessions-refresh"] as const)("offers Retry for a persistent %s failure without a reconnect banner", async (recovery: BrowserErrorRecovery) => {
    window.history.replaceState(null, "", `?${new URLSearchParams({ project: workspace.projectId, workspace: workspace.id, session: session.id })}`);
    const scope = recovery === "session-refresh"
      ? sessionBrowserErrorScope("local", session.id, { cwd: session.cwd, projectId: workspace.projectId, workspaceId: workspace.id })
      : workspaceBrowserErrorScope("local", workspace.projectId, workspace.id);
    const app = await mountApp({
      selectedProject: { id: workspace.projectId, name: "Project", path: workspace.path, createdAt: "now" },
      selectedWorkspace: workspace, selectedSession: session, mainView: "chat",
      browserErrors: reportBrowserError({}, scope, "Updates could not be refreshed. Check your connection and retry.", recovery),
    });
    const sessions: unknown = Reflect.get(app, "sessions");
    if (!(sessions instanceof SessionController)) throw new Error("Expected SessionController");
    const refreshSelected = vi.spyOn(sessions, "refreshSelectedSession").mockResolvedValue();
    const refreshWorkspace = vi.spyOn(sessions, "refreshCurrentWorkspaceSessions").mockResolvedValue();
    await settle(app);
    const retry = [...app.shadowRoot?.querySelectorAll<HTMLButtonElement>("main .error button") ?? []].find((button) => button.textContent.trim() === "Retry");
    if (retry === undefined) throw new Error("Expected a recovery Retry button");
    retry.click();

    if (recovery === "session-refresh") {
      expect(refreshSelected).toHaveBeenCalledExactlyOnceWith(session.id, { recoverNetwork: true });
      expect(refreshWorkspace).not.toHaveBeenCalled();
    } else {
      expect(refreshWorkspace).toHaveBeenCalledExactlyOnceWith("local", { recoverNetwork: true });
      expect(refreshSelected).not.toHaveBeenCalled();
    }
    expect(app.shadowRoot?.textContent).not.toContain("Reconnecting");
  });

  it("does not offer automatic recovery for a failed user action", async () => {
    window.history.replaceState(null, "", `?${new URLSearchParams({ session: session.id })}`);
    const app = await mountApp({
      selectedWorkspace: workspace, selectedSession: session, mainView: "chat",
      browserErrors: reportBrowserError({}, sessionBrowserErrorScope("local", session.id), "Prompt delivery could not be confirmed"),
    });
    await settle(app);
    expect(app.shadowRoot?.textContent).toContain("Prompt delivery could not be confirmed");
    const retry = [...app.shadowRoot?.querySelectorAll<HTMLButtonElement>("main .error button") ?? []].find((button) => button.textContent.trim() === "Retry");
    expect(retry).toBeUndefined();
  });

  it("updates the workspace empty state as project loading completes", async () => {
    const app = await mountApp({ isLoadingProjects: true });
    await settle(app);
    expect(app.shadowRoot?.querySelector("workspace-panel")?.shadowRoot?.textContent).toContain("Loading projects");
    patchState(app, { isLoadingProjects: false });
    await settle(app);
    expect(app.shadowRoot?.querySelector("workspace-panel")?.shadowRoot?.textContent).toContain("No projects yet");
  });
});

function sessionStatus(sessionId: string, warnings: SessionWarning[] = []): SessionStatus {
  return {
    sessionId, isStreaming: false, isCompacting: false, isBashRunning: false,
    recentlyActiveElsewhere: false,
    pendingMessageCount: 0, queuedMessages: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0,
    warnings,
  };
}

function promptEditor(app: PiWebApp): PromptEditor {
  const editor = app.shadowRoot?.querySelector("prompt-editor");
  if (!(editor instanceof PromptEditor)) throw new Error("Expected prompt editor");
  return editor;
}

function dismissActivityNotice(app: PiWebApp): void {
  const button = app.shadowRoot?.querySelector<HTMLButtonElement>(".composer-activity-notice button");
  if (button == null) throw new Error("Expected activity notice dismissal");
  expect(button.textContent).toBe("Dismiss and continue");
  button.click();
}

it.each([false, true])("hides only folder workspace UI and retains its workspace context (mobile=%s)", async (mobile) => {
  const app = await mountApp({
    selectedProject: { id: "project", name: "Project", path: "/repo/subdir", createdAt: "now" },
    selectedWorkspace: { ...workspace, path: "/repo/subdir" }, workspaces: [workspace],
    workspaceResolution: { projectId: "project", status: "folder", diagnostics: [], workspaces: [workspace] },
    mainView: "navigation",
  }, (context) => html`<p>${context.state.selectedWorkspace?.path}</p>`);
  const shell: unknown = Reflect.get(app, "appShell");
  if (!(shell instanceof AppShellController)) throw new Error("Expected shell controller");
  shell.isMobileNavigationLayout = mobile;
  app.requestUpdate();
  await settle(app);
  const navigation = () => app.shadowRoot?.querySelector("app-navigation-panel");
  expect(navigation()?.shadowRoot?.querySelector("workspace-list")).toBeNull();
  if (mobile) expect(app.shadowRoot?.querySelector("app-context-bar")?.shadowRoot?.querySelector('button[aria-label^="Workspace:"]')).toBeNull();
  expect(app.shadowRoot?.querySelector("workspace-panel")?.shadowRoot?.textContent).toContain("/repo/subdir");

  for (const status of ["provider", "degraded"] as const) {
    patchState(app, { workspaceResolution: { projectId: "project", status, diagnostics: [], workspaces: [workspace] } });
    await settle(app);
    expect(navigation()?.shadowRoot?.querySelector("workspace-list")).toBeInstanceOf(WorkspaceList);
    if (mobile) expect(app.shadowRoot?.querySelector("app-context-bar")?.shadowRoot?.querySelector('button[aria-label^="Workspace:"]')).not.toBeNull();
  }
});

it("applies the quiet-mode gateway setting to the rendered transcript", async () => {
  const app = await mountApp({ selectedWorkspace: workspace, workspaces: [workspace], selectedSession: session, sessions: [session], mainView: "chat" });
  await settle(app);
  const chat = (): ChatView | null | undefined => app.shadowRoot?.querySelector("chat-view");
  expect(chat()).toBeInstanceOf(ChatView);
  expect(chat()?.quietMode).toBe(false);

  vi.spyOn(configApi, "config").mockResolvedValue(configResponse({ quietMode: true }));
  const loadConfig: unknown = Reflect.get(app, "loadClientConfig");
  if (typeof loadConfig !== "function") throw new Error("Expected loadClientConfig");
  await Reflect.apply(loadConfig, app, []);
  await settle(app);
  expect(chat()?.quietMode).toBe(true);

  patchState(app, { selectedSession: { ...session, id: "another-session" } });
  await settle(app);
  expect(chat()?.quietMode).toBe(true);
});

function namedButton(root: ParentNode | null | undefined, name: string): HTMLButtonElement {
  const button = [...root?.querySelectorAll<HTMLButtonElement>("button") ?? []]
    .find((candidate) => (candidate.getAttribute("aria-label") ?? candidate.textContent.trim()) === name);
  if (button === undefined) throw new Error(`Expected button: ${name}`);
  return button;
}

async function mountMobileNavigationApp(patch: Partial<AppState> = {}) {
  const app = new RenderOnlyApp();
  patchState(app, patch);
  const shell: unknown = Reflect.get(app, "appShell");
  if (!(shell instanceof AppShellController)) throw new Error("Expected shell controller");
  shell.isDesktopSideBySideLayout = false;
  shell.isMobileNavigationLayout = true;
  document.body.append(app);
  await settle(app);
  return { app, shell };
}

async function mountApp(patch: Partial<AppState>, panelRender?: (context: WorkspacePanelContext) => ReturnType<typeof html>, label?: () => string): Promise<RenderOnlyApp> {
  const app = new RenderOnlyApp();
  if (panelRender !== undefined) {
    const registry: unknown = Reflect.get(app, "plugins");
    if (!(registry instanceof PluginRegistry)) throw new Error("Expected plugin registry");
    // Recovery mode permits an ordinary plugin without booting the terminal
    // backend; this test only needs the workspace rendering contract.
    Reflect.set(app, "verifiedPluginModeByMachine", new Map([["local", "recovery-disabled"]]));
    await registry.register({
      id: "render-test",
      plugin: {
        apiVersion: 4, name: "Render test",
        activate: () => ({ contributions: {
          workspacePanels: [{ id: "panel", title: "Test", render: panelRender, ...(label === undefined ? {} : { badge: label }) }],
          ...(label === undefined ? {} : { workspaceLabels: [{ id: "label", items: () => [{ type: "text" as const, text: label() }] }] }),
        } }),
      },
    });
  }
  Reflect.set(app, "state", { ...initialAppState(), ...patch });
  document.body.append(app);
  return app;
}

function manualAnimationFrames(): () => void {
  const frames = new Map<number, FrameRequestCallback>();
  let nextId = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextId, callback);
    return nextId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id); });
  return () => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(0);
  };
}

function patchState(app: PiWebApp, patch: Partial<AppState>): void {
  const state: unknown = Reflect.get(app, "state");
  if (typeof state !== "object" || state === null) throw new Error("Expected app state");
  Reflect.set(app, "state", { ...state, ...patch });
}

async function settle(element: LitElement): Promise<void> {
  await element.updateComplete;
  for (const child of element.shadowRoot?.querySelectorAll("*") ?? []) {
    if (child instanceof LitElement) await settle(child);
  }
  await element.updateComplete;
}
