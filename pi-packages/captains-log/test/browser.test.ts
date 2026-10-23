// @vitest-environment happy-dom

import { html, render, svg } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import type { PluginCapability, WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import plugin from "../src/browser/index.js";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

it("requires stylesheet integration and rejects malformed capabilities", () => {
  const capability = plugin.requires?.[0];
  expect(capability).toMatchObject({ pluginId: "pi-web", id: "stylesheet-integration", version: 1 });
  for (const value of [null, {}, { registerRoot: vi.fn(), subscribe: vi.fn(), createController: null }]) {
    expect(() => capability?.parse(value)).toThrow("Invalid PI WEB stylesheet integration");
  }
});

it("retains shared UI on the host root across rerenders and releases on disconnect", async () => {
  const release = vi.fn();
  const integration = { registerRoot: vi.fn(() => release), subscribe: vi.fn(), createController: vi.fn() };
  const lifetime = new AbortController();
  const activation = await plugin.activate({
    apiVersion: 4, pluginId: "captains-log", runtimePluginId: "captains-log", html, svg,
    signal: new AbortController().signal, lifetimeSignal: lifetime.signal,
  });
  await activation.start?.({
    capabilities: { resolve: <Value,>(capability: PluginCapability<Value>): Value => capability.parse(integration) },
    signal: new AbortController().signal,
  });
  const panel = activation.contributions.workspacePanels?.[0];
  if (!panel) throw new Error("Expected Captain panel");
  const noop = () => undefined;
  const unavailable = () => Promise.reject(new Error("unavailable"));
  const context: WorkspacePanelContext = {
    navigate: () => Promise.resolve(), machine: { id: "local", name: "Local", kind: "local" },
    workspace: { id: "main", projectId: "project", path: "/repo", label: "main", isMain: true },
    state: { mainView: "workspace" }, host: { requestRender: noop },
    files: { readFile: unavailable, listFiles: unavailable, writeFile: unavailable, deleteFile: unavailable, moveFile: unavailable },
    prompt: { insertText: noop, getText: () => "", getSelection: () => null },
    terminal: { open: noop, runCommand: unavailable },
  };
  const host = document.createElement("div");
  const root = host.attachShadow({ mode: "open" });
  document.body.append(host);
  render(panel.render(context), root);
  await Promise.resolve();
  render(panel.render(context), root);
  expect(integration.registerRoot).toHaveBeenCalledExactlyOnceWith(root, { sharedUi: true });
  expect(root.querySelector("style[data-ui-styles]")).toBeNull();
  expect(root.querySelector(".ui-button--primary")).not.toBeNull();
  host.remove();
  expect(release).toHaveBeenCalledTimes(1);
  document.body.append(host);
  expect(integration.registerRoot).toHaveBeenCalledTimes(2);
  render(null, root);
  expect(release).toHaveBeenCalledTimes(2);
  lifetime.abort();
  await activation.dispose?.(new AbortController().signal);
});
