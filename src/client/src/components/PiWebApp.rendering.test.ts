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
import { FormattedText } from "./FormattedText";
import { WorkspacePanel } from "./WorkspacePanel";
import { WorkspaceList } from "./WorkspaceList";
import { ProjectList } from "./ProjectList";
import { SessionList } from "./SessionList";

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
