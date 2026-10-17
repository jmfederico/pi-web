// @vitest-environment happy-dom

import type { PiWebPlugin, PluginActivationContext, PluginCapability, StylesheetIntegrationCapabilityV1 } from "@jmfederico/pi-web/plugin-api";
import { html, svg } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import files, { defineFilesCustomElements, FILES_PANEL_ELEMENT, FILES_VIEWER_ELEMENT, FILES_CODE_VIEWER_ELEMENT } from "./files/pi-web-plugin";
import terminal, { defineTerminalCustomElements, TERMINAL_PANEL_ELEMENT, TERMINAL_SOFT_KEYS_ELEMENT } from "./terminal/pi-web-plugin";
import mermaid from "./mermaid/pi-web-plugin";
import codeHighlight from "./code-highlight/pi-web-plugin";
import tasks from "./workspace-tasks/pi-web-plugin";
import relays from "../pi-packages/relays/pi-web-plugin";

interface ParticipatingElement extends HTMLElement {
  stylesheetIntegration: StylesheetIntegrationCapabilityV1 | undefined;
  updateComplete?: Promise<boolean>;
}

const plugins: [string, PiWebPlugin][] = [
  ["files", files], ["pi-web.terminal", terminal], ["mermaid", mermaid],
  ["code-highlight", codeHighlight], ["tasks", tasks], ["relays", relays],
];

function activationContext(pluginId: string): PluginActivationContext {
  return {
    apiVersion: 4, pluginId, runtimePluginId: pluginId, html, svg,
    signal: new AbortController().signal, lifetimeSignal: new AbortController().signal,
  };
}

function isParticipatingElement(element: HTMLElement): element is ParticipatingElement {
  return "stylesheetIntegration" in element;
}

function integration() {
  const roots = new Set<ShadowRoot>();
  const registerRoot = vi.fn((root: ShadowRoot) => {
    roots.add(root);
    return vi.fn(() => { roots.delete(root); });
  });
  return { roots, registerRoot, createController: vi.fn(), subscribe: vi.fn(() => vi.fn()) };
}

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("bundled stylesheet capability participation", () => {
  it.each(plugins)("%s requires and resolves the public capability in start", async (id, plugin) => {
    const token = plugin.requires?.find((requirement) => requirement.id === "stylesheet-integration");
    expect(token).toMatchObject({ pluginId: "pi-web", version: 1 });
    const styles = integration();
    expect(token?.parse(styles)).toBe(styles);
    for (const invalid of [undefined, {}, { registerRoot: () => undefined }]) {
      expect(() => token?.parse(invalid)).toThrow("Stylesheet integration capability v1");
    }
    if (plugin.apiVersion !== 4) throw new Error("Expected a bundled v4 plugin");
    const result = await plugin.activate(activationContext(id));
    const requests: string[] = [];
    await result.start?.({ signal: new AbortController().signal, capabilities: {
      resolve<Value>(requirement: PluginCapability<Value>): Value {
        requests.push(requirement.id);
        return requirement.parse(requirement.id === "stylesheet-integration" ? styles : {
          cssText: "", listRenderers: () => [], renderText: () => undefined, renderMarkdown: () => html``,
        });
      },
    } });
    expect(requests).toContain("stylesheet-integration");
    await result.dispose?.(new AbortController().signal);
  });

  it.each([
    FILES_PANEL_ELEMENT, FILES_VIEWER_ELEMENT, FILES_CODE_VIEWER_ELEMENT,
    TERMINAL_PANEL_ELEMENT, TERMINAL_SOFT_KEYS_ELEMENT,
    "pi-web-mermaid-preview", "pi-web-highlighted-code",
    "pi-web-workspace-tasks-panel", "pi-web-relays-panel",
  ])("%s registers only while connected, including replacement and reconnect", async (tag) => {
    defineFilesCustomElements();
    defineTerminalCustomElements();
    for (const [id, plugin] of plugins) {
      if (plugin.apiVersion !== 4) throw new Error("Expected a bundled v4 plugin");
      await plugin.activate(activationContext(id));
    }
    const panel = document.createElement(tag);
    if (!isParticipatingElement(panel)) throw new Error(`Missing integration property on ${tag}`);
    const styles = integration();
    panel.stylesheetIntegration = styles;
    expect(styles.roots.size).toBe(0);
    document.body.append(panel);
    await panel.updateComplete;
    expect(styles.registerRoot).toHaveBeenCalledExactlyOnceWith(panel.shadowRoot);
    panel.stylesheetIntegration = styles;
    expect(styles.registerRoot).toHaveBeenCalledTimes(1);

    const replacement = integration();
    panel.stylesheetIntegration = replacement;
    expect(styles.roots.size).toBe(0);
    expect(replacement.roots).toEqual(new Set([panel.shadowRoot]));
    panel.remove();
    expect(replacement.roots.size).toBe(0);
    document.body.append(panel);
    await panel.updateComplete;
    expect(replacement.registerRoot).toHaveBeenCalledTimes(2);
    expect(replacement.roots).toEqual(new Set([panel.shadowRoot]));
    panel.stylesheetIntegration = undefined;
    expect(replacement.roots.size).toBe(0);
  });
});
