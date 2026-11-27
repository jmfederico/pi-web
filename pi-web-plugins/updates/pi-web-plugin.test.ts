/// <reference types="vite/client" />
import { html, svg } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { PluginRuntimeContextV5 } from "@jmfederico/pi-web/plugin-api";
import plugin from "./pi-web-plugin.js";
import { LocalizationService } from "../../src/client/src/localization/service.js";
import { createPluginLocalization } from "../../src/client/src/plugins/localization.js";

describe("Updates plugin actions", () => {
  it("keeps contribution labels live across language changes", async () => {
    const service = new LocalizationService({ development: true, preferences: { language: "en", formatLocale: "en-US" } });
    const contributions = plugin.activate({ ...activationContext(), localization: createPluginLocalization(service, "updates", "updates", new AbortController().signal) }).contributions;
    const action = contributions.actions[0];
    const panel = contributions.applicationPanels[0];
    if (action === undefined || panel === undefined) throw new Error("Missing Updates contributions");
    expect(panel.title).toBe("Updates");
    await service.setPreferences({ language: "en-XA", formatLocale: "en-US" });
    expect(panel.title).not.toBe("Updates");
    expect(action.title).not.toBe("Check for PI WEB Updates");
    expect(action.group).toBe(panel.title);
  });
  it("forces an update check through the host runtime context", async () => {
    const action = plugin.activate(activationContext()).contributions.actions.find((candidate) => candidate.id === "check");
    if (action === undefined) throw new Error("Expected update check action");
    const checkForPiWebUpdates = vi.fn(() => Promise.resolve());
    const context = runtimeContext({ checkForPiWebUpdates });

    expect(action.enabled(context)).toBe(true);
    await action.run(context);

    expect(checkForPiWebUpdates).toHaveBeenCalledOnce();
  });

  it("disables the action on older hosts without the update-check helper", () => {
    const action = plugin.activate(activationContext()).contributions.actions.find((candidate) => candidate.id === "check");
    if (action === undefined) throw new Error("Expected update check action");
    const context = runtimeContext();

    expect(action.enabled(context)).toBe(false);
    expect(action.disabledReason()).toContain("newer PI WEB gateway");
  });
});

function activationContext() {
  return {
    localization: createPluginLocalization(new LocalizationService({ preferences: { language: "en", formatLocale: "en-US", timeZone: "UTC" } }), "updates", "updates", new AbortController().signal),
    apiVersion: 5 as const,
    pluginId: "updates",
    runtimePluginId: "updates",
    html,
    svg,
    signal: new AbortController().signal,
    lifetimeSignal: new AbortController().signal,
  };
}

function runtimeContext(patch: Partial<PluginRuntimeContextV5> = {}): PluginRuntimeContextV5 {
  const noop = () => undefined;
  return {
    navigate: () => Promise.resolve(),
    catalog: {
      version: 1, machineId: "local",
      projects: { list: vi.fn(), get: vi.fn() },
      workspaces: { list: vi.fn(), get: vi.fn() },
      sessions: { list: vi.fn(), get: vi.fn() },
    },
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
    // oxlint-disable-next-line typescript/no-deprecated -- Fakes implement the full host action contract, including the deprecated alias.
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
