import { html, svg } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntimeContext } from "@jmfederico/pi-web/plugin-api";
import plugin from "./pi-web-plugin.js";

describe("Info plugin copy-diagnostics action", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("copies a diagnostics summary to the clipboard", async () => {
    const writeText = vi.fn((text: string) => { void text; return Promise.resolve(); });
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const action = findCopyDiagnosticsAction();
    const context = runtimeContext({
      state: {
        selectedMachine: { id: "local", name: "devbox", kind: "local" },
        selectedWorkspace: {
          id: "ws-1",
          projectId: "proj-1",
          path: "/srv/dev/pi-web",
          label: "pi-web",
          isMain: true,
          provider: {
            pluginId: "git",
            capabilities: { remove: true },
            metadata: { branch: "main" },
          },
        },
      },
    });

    await action.run(context);

    expect(writeText).toHaveBeenCalledOnce();
    const summary = writeText.mock.calls[0]?.[0];
    expect(summary).toContain("PI WEB diagnostics");
    expect(summary).toContain("Status: unavailable");
    expect(summary).toContain("Machine: devbox (local machine)");
    expect(summary).toContain("Workspace: pi-web — /srv/dev/pi-web (provider: git, main workspace)");
  });

  it("includes the browser and anonymizes a home-directory workspace", async () => {
    const writeText = vi.fn((text: string) => { void text; return Promise.resolve(); });
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.7444.60 Safari/537.36",
      clipboard: { writeText },
    });
    const action = findCopyDiagnosticsAction();
    const context = runtimeContext({
      state: {
        selectedWorkspace: {
          id: "ws-1",
          projectId: "proj-1",
          path: "/home/alice/dev/pi-web",
          label: "pi-web",
          isMain: true,
        },
      },
    });

    await action.run(context);

    const summary = writeText.mock.calls[0]?.[0];
    expect(summary).toContain("Browser: Chrome 142.0.7444");
    expect(summary).toContain("Workspace: pi-web — ~/dev/pi-web");
    expect(summary).not.toContain("alice");
  });
});

function findCopyDiagnosticsAction() {
  const action = plugin.activate({
    apiVersion: 4,
    pluginId: "info",
    runtimePluginId: "info",
    html,
    svg,
    signal: new AbortController().signal,
    lifetimeSignal: new AbortController().signal,
  }).contributions.actions.find((candidate) => candidate.id === "copy-diagnostics");
  if (action === undefined) throw new Error("Expected copy-diagnostics action");
  return action;
}

function runtimeContext(patch: Partial<PluginRuntimeContext> = {}): PluginRuntimeContext {
  const noop = () => undefined;
  return {
    navigate: () => Promise.resolve(),
    state: {},
    prompt: { insertText: noop, getText: () => "", getSelection: () => null },
    openActionPalette: noop,
    focusPrompt: noop,
    addProject: noop,
    configureAuth: noop,
    logoutAuth: noop,
    openThemePicker: noop,
    selectMainView: noop,
    selectWorkspaceTool: noop,
    openTerminal: noop,
    refreshFiles: noop,
    refreshWorkspacePanels: noop,
    refreshAppData: noop,
    reloadPage: noop,
    startSession: noop,
    archiveSession: noop,
    stopActiveWork: noop,
    ...patch,
  };
}
