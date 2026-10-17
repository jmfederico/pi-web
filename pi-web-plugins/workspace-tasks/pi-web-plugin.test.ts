// @vitest-environment happy-dom

import type { PluginCapability, WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import { html, render, svg } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./pi-web-plugin.js";
import { defineTasksPanelElement, PiWebTasksPanel, tasksPanelTagName } from "./tasksPanelElement.js";

let workspaceSequence = 0;

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected panel element or contribution");
  return value;
}

function activate() {
  return plugin.activate({
    apiVersion: 4, pluginId: "workspace-tasks", runtimePluginId: "remote.workspace-tasks",
    html, svg, signal: new AbortController().signal, lifetimeSignal: new AbortController().signal,
  });
}

function workspaceContext() {
  return {
    navigate: vi.fn(),
    machine: { id: "local", name: "Local", kind: "local" },
    workspace: { id: `workspace-${String(++workspaceSequence)}`, projectId: "project", path: "/repo", label: "main", isMain: true },
    files: {
      capabilityVersion: 1, defaultUploadFolder: ".pi-web/uploads", maxInlinePreviewBytes: 1024,
      readFile: vi.fn().mockResolvedValue({
        content: JSON.stringify({ version: 1, tasks: [{ id: "build", title: "Build <app>", command: "npm run build", confirm: true }] }),
        truncated: false, binary: false,
      }),
      listFiles: vi.fn(), writeFile: vi.fn(), deleteFile: vi.fn(), moveFile: vi.fn(),
      previewUrl: vi.fn(), downloadUrl: vi.fn(), uploadFile: vi.fn(),
    },
    host: { requestRender: vi.fn() },
    prompt: { insertText: vi.fn(), getText: vi.fn(() => ""), getSelection: vi.fn(() => null) },
    terminal: { open: vi.fn(), runCommand: vi.fn<WorkspacePanelContext["terminal"]["runCommand"]>() },
    navigation: { version: 1, contributionId: "remote.workspace-tasks:workspace.tasks", query: {}, set: vi.fn() },
  } satisfies WorkspacePanelContext;
}

function createPanel(): PiWebTasksPanel {
  defineTasksPanelElement();
  const panel = document.createElement(tasksPanelTagName);
  if (!(panel instanceof PiWebTasksPanel)) throw new Error("Expected Tasks panel");
  return panel;
}

function root(panel: Element): ShadowRoot {
  return required(panel.shadowRoot);
}

function button(panel: Element, selector: string): HTMLButtonElement {
  return required(root(panel).querySelector<HTMLButtonElement>(selector));
}

describe("Workspace Tasks host UI styles", () => {
  it("requires v1, validates its payload, and adopts start-resolved CSS through the rendered panel", () => {
    const requirement = required(plugin.requires.find(({ id }) => id === "ui-styles"));
    expect(requirement).toMatchObject({ pluginId: "pi-web", id: "ui-styles", version: 1 });
    for (const value of [null, undefined, {}, { cssText: 42 }]) {
      expect(() => requirement.parse(value)).toThrow("requires UI styles capability v1");
    }
    const instance = activate();
    const requests = vi.fn();
    instance.start({ signal: new AbortController().signal, capabilities: {
      resolve<Value>(token: PluginCapability<Value>): Value {
        requests(token);
        return token.parse({ cssText: ".ui-button { color: red; }", registerRoot: vi.fn(() => vi.fn()), createController: vi.fn(), subscribe: vi.fn(() => vi.fn()) });
      },
    } });
    expect(requests).toHaveBeenCalledWith(requirement);
    expect(requests).toHaveBeenCalledTimes(2);
    const container = document.createElement("div");
    document.body.append(container);
    render(required(instance.contributions.workspacePanels[0]).render(workspaceContext()), container);
    const panel = required(container.querySelector(tasksPanelTagName));
    expect(root(panel).querySelector("style[data-ui-styles]")?.textContent).toBe(".ui-button { color: red; }");
    // Another activation must not inherit the first instance's resolved styles.
    render(required(activate().contributions.workspacePanels[0]).render(workspaceContext()), container);
    expect(root(panel).querySelector("style[data-ui-styles]")?.textContent).toBe("");
  });

  it("updates one persistent style as text without replacing content or its listeners", async () => {
    const panel = createPanel();
    const cssText = '</style><button id="injected">Injected</button><style>';
    panel.uiCssText = cssText;
    const context = workspaceContext();
    panel.context = context;
    document.body.append(panel);
    const style = root(panel).querySelector("style[data-ui-styles]");
    await vi.waitFor(() => { expect(button(panel, "[data-task-id]").textContent).toBe("Run"); });
    expect(style?.textContent).toBe(cssText);
    expect(root(panel).querySelector("#injected")).toBeNull();
    const open = button(panel, "[data-open-terminal]");
    const viewer = required(root(panel).querySelector(".viewer"));
    viewer.scrollTop = 25;
    panel.uiCssText = ".ui-button { color: blue; }";
    expect(root(panel).querySelector("style[data-ui-styles]")).toBe(style);
    expect(button(panel, "[data-open-terminal]")).toBe(open);
    expect(root(panel).querySelector(".viewer")).toBe(viewer);
    expect(viewer.scrollTop).toBe(25);
    expect(style?.textContent).toBe(".ui-button { color: blue; }");
    expect(root(panel).querySelectorAll("style[data-ui-styles]")).toHaveLength(1);
    open.click();
    expect(context.terminal.open).toHaveBeenCalledOnce();
  });

  it("preserves refresh, confirmation, dispatch disabling, and terminal events on native UI controls", async () => {
    const context = workspaceContext();
    let rejectRun: (reason: Error) => void = () => { throw new Error("No task dispatched"); };
    context.terminal.runCommand.mockImplementation(() => new Promise((_resolve, reject) => { rejectRun = reject; }));
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    const panel = createPanel();
    panel.context = context;
    document.body.append(panel);
    expect(button(panel, "[data-refresh-config]").disabled).toBe(true);
    await vi.waitFor(() => { expect(button(panel, "[data-refresh-config]").disabled).toBe(false); });
    expect(root(panel).querySelector(".ui-toolbar .ui-toolbar-group")).not.toBeNull();
    expect(button(panel, "[data-task-id]").classList.contains("ui-button--primary")).toBe(true);
    expect(root(panel).textContent).toContain("Build <app>");
    expect(root(panel).querySelector("app")).toBeNull();
    button(panel, "[data-task-id]").click();
    expect(confirm).toHaveBeenCalledWith("Run Build <app>?\n\nnpm run build");
    expect(context.terminal.runCommand).not.toHaveBeenCalled();
    expect(root(panel).textContent).toContain("Cancelled Build <app>.");
    confirm.mockReturnValue(true);
    button(panel, "[data-task-id]").click();
    expect(button(panel, "[data-task-id]").disabled).toBe(true);
    expect(button(panel, "[data-task-id]").textContent).toBe("Dispatching…");
    expect(context.terminal.runCommand).toHaveBeenCalledExactlyOnceWith({
      title: "Build <app>", command: "npm run build", open: true,
      metadata: { "pi.plugin": "workspace-tasks", "task.id": "build" },
    });
    rejectRun(new Error("Terminal unavailable"));
    await vi.waitFor(() => { expect(button(panel, "[data-task-id]").disabled).toBe(false); });
    expect(root(panel).textContent).toContain("Terminal unavailable");
    button(panel, "[data-refresh-config]").click();
    expect(button(panel, "[data-refresh-config]").disabled).toBe(true);
    await vi.waitFor(() => { expect(root(panel).textContent).toContain("Loaded 1 task."); });
    expect(context.files.readFile).toHaveBeenCalledTimes(2);
    button(panel, "[data-open-terminal]").click();
    expect(context.terminal.open).toHaveBeenCalledOnce();
  });
});
