// @vitest-environment happy-dom

import { LitElement, html } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialAppState, type AppState } from "../appState";
import type { SessionInfo, Workspace } from "../api";
import { PluginRegistry } from "../plugins/registry";
import { corePlugin } from "../plugins/core";
import type { WorkspacePanelContext } from "../plugins/types";
import { PiWebApp } from "./PiWebApp";
import { ChatView } from "./ChatView";
import type { ActionPalette } from "./ActionPalette";
import { FormattedText } from "./FormattedText";
import { WorkspacePanel } from "./WorkspacePanel";
import { WorkspaceList } from "./WorkspaceList";
import { ProjectList } from "./ProjectList";
import { SessionList } from "./SessionList";
import { loadNavigationPreferences, saveNavigationPreferences } from "../navigationPreferences";
import { NavigationDialog } from "./appShell/NavigationDialog";
import { deepActiveElement } from "./modalLayerRegistry";
import { AppShellController } from "../appShell/appShellController";

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
  vi.stubGlobal("fetch", unexpectedRequest);
  // Scroll scheduling is not under test; happy-dom supplies no layout metrics.
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
});

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  expect(unexpectedRequest).not.toHaveBeenCalled();
});

describe("application rendering boundaries", () => {
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
    app.shadowRoot?.querySelector("workspace-panel")?.shadowRoot?.querySelector<HTMLButtonElement>('button[aria-label="Navigation"]')?.click();
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
  it("updates both tab surfaces from pin controls without changing selected content, and reloads preferences", async () => {
    const app = await mountApp({ selectedWorkspace: workspace, workspaces: [workspace], workspaceTool: "render-test:panel", mainView: "workspace" }, () => html`<p>Selected tool content</p>`);
    await settle(app);
    const workspacePanel = app.shadowRoot?.querySelector("workspace-panel");
    const open = workspacePanel?.shadowRoot?.querySelector<HTMLButtonElement>('button[aria-label="Navigation"]');
    expect(open).not.toBeNull();
    expect(workspacePanel?.shadowRoot?.querySelector("header > button:last-child")).toBe(open);
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
    expect(workspacePanel?.shadowRoot?.querySelector('button[title="Test"]')?.classList.contains("selected")).toBe(true);
    expect(workspacePanel?.shadowRoot?.querySelector(".panel-content")?.textContent).toContain("Selected tool content");
    document.body.replaceChildren();
    const reloaded = await mountApp({});
    await settle(reloaded);
    expect(Reflect.get(reloaded, "navigationPreferences")).toEqual(loadNavigationPreferences());
  });

  it("collapses only the mobile tab bar, keeping breadcrumbs and separate Navigation and Actions controls", async () => {
    saveNavigationPreferences({ pinnedIds: [], mobileCollapsed: true });
    const app = await mountApp({});
    const shell: unknown = Reflect.get(app, "appShell");
    if (!(shell instanceof AppShellController)) throw new Error("Expected shell controller");
    shell.isMobileNavigationLayout = true;
    app.requestUpdate();
    await settle(app);
    expect(app.shadowRoot?.querySelector("app-mobile-main-tabs")).toBeNull();
    const context = app.shadowRoot?.querySelector("app-context-bar");
    expect(context?.shadowRoot?.querySelectorAll(".context-item")).toHaveLength(3);
    const controls = [...context?.shadowRoot?.querySelectorAll<HTMLButtonElement>(".context-actions button") ?? []];
    expect(controls.map((button) => button.getAttribute("aria-label") ?? button.textContent.trim())).toEqual(["Navigation", "Show Actions"]);
    expect(controls[0]?.classList.contains("selected")).toBe(true);
    controls[0]?.focus();
    controls[0]?.click();
    await settle(app);
    const dialog = app.shadowRoot?.querySelector("navigation-dialog");
    expect(dialog?.shadowRoot?.textContent).toContain("Chat");
    dialog?.shadowRoot?.querySelector<HTMLButtonElement>(".mobile-navigation button:first-child")?.click();
    await settle(app);
    expect(app.shadowRoot?.querySelector("app-mobile-main-tabs")).not.toBeNull();
    expect(context?.shadowRoot?.querySelector('button[aria-label="Navigation"]')).toBeNull();
    const tabStrip = app.shadowRoot?.querySelector("app-mobile-main-tabs");
    const hamburger = tabStrip?.shadowRoot?.querySelector<HTMLButtonElement>('button[aria-label="Navigation"]');
    expect(hamburger?.querySelector("svg")).not.toBeNull();
    expect(hamburger?.classList.contains("selected")).toBe(false);
    expect(tabStrip?.shadowRoot?.querySelector(".mobile-tabs > button:last-child")).toBe(hamburger);
    dialog?.shadowRoot?.querySelector<HTMLButtonElement>("header button")?.click();
    await settle(app);
    expect(deepActiveElement(document)).toBe(hamburger);
    hamburger?.click();
    await settle(app);
    const reopenedDialog = app.shadowRoot?.querySelector("navigation-dialog");
    expect(reopenedDialog).not.toBeNull();
    expect(loadNavigationPreferences()).toEqual({ pinnedIds: [], mobileCollapsed: false });

    // A resize must invalidate the guarded tab surface even with collapse enabled.
    reopenedDialog?.shadowRoot?.querySelector<HTMLButtonElement>(".mobile-navigation button:last-child")?.click();
    await settle(app);
    shell.isMobileNavigationLayout = false;
    app.requestUpdate();
    await settle(app);
    expect(app.shadowRoot?.querySelector("app-mobile-main-tabs")).not.toBeNull();
    expect(loadNavigationPreferences().mobileCollapsed).toBe(true);
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

  it("updates the workspace empty state as project loading completes", async () => {
    const app = await mountApp({ isLoadingProjects: true });
    await settle(app);
    expect(app.shadowRoot?.querySelector("workspace-panel")?.shadowRoot?.textContent).toContain("Loading projects");
    patchState(app, { isLoadingProjects: false });
    await settle(app);
    expect(app.shadowRoot?.querySelector("workspace-panel")?.shadowRoot?.textContent).toContain("No projects yet");
  });
});

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
