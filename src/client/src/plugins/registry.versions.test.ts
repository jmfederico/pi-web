// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { html } from "lit";
import type { ContentRendererContribution, ThemeTokens } from "../../../plugin-api";
import { applyPiWebTheme } from "../theme";
import { PluginRegistry } from "./registry";
import { availableMessageActions } from "./messageActions";
import { stylesheetIntegrationCapabilityToken } from "./styles";
import type { PluginContributions } from "./types";

afterEach(() => {
  document.documentElement.removeAttribute("style");
  delete document.documentElement.dataset["piWebTheme"];
});

describe("browser entrypoint version boundaries", () => {
  it("preserves v4 palette themes and clears their overrides when switching to v5", async () => {
    const tokens: ThemeTokens = { "--pi-bg": "#123456", "--pi-text": "#ffffff", "--pi-accent": "#abcdef" };
    const legacy = {
      apiVersion: 4 as const, name: "Legacy palette", requires: [stylesheetIntegrationCapabilityToken],
      activate: () => ({ contributions: { themes: [{ id: "old", name: "Old", colorScheme: "dark" as const, tokens }] },
        start: ({ capabilities }: import("./types").PluginStartContext) => { expect(capabilities.resolve(stylesheetIntegrationCapabilityToken).registerRoot).toBeTypeOf("function"); },
      }),
    };
    const registry = new PluginRegistry();
    try {
      await registry.register({ id: "legacy", plugin: legacy });
      await registry.register({ id: "modern", plugin: { apiVersion: 5, name: "Modern", activate: () => ({ contributions: {
        themes: [{ id: "new", name: "New", colorScheme: "light", stylesheets: [{ id: "palette", url: "https://plugins.test/light.css" }] }],
      } }) } });
      tokens["--pi-bg"] = "#000000";
      const old = registry.getThemes().find((theme) => theme.id === "legacy:old");
      const modern = registry.getThemes().find((theme) => theme.id === "modern:new");
      if (old === undefined || modern === undefined) throw new Error("Expected both registered themes");
      applyPiWebTheme(old);
      expect(document.documentElement.style.getPropertyValue("--pi-bg")).toBe("#123456");
      expect(document.documentElement.style.getPropertyValue("--pi-accent")).toBe("#abcdef");
      applyPiWebTheme(modern);
      expect(document.documentElement.style.getPropertyValue("--pi-bg")).toBe("");
      expect(document.documentElement.style.getPropertyValue("--pi-accent")).toBe("");
      expect(modern.stylesheets?.[0]?.url).toBe("https://plugins.test/light.css");
      applyPiWebTheme(old);
      expect(document.documentElement.style.getPropertyValue("--pi-text")).toBe("#ffffff");
    } finally { await registry.dispose(); }
  });

  it.each<PluginContributions>([
    { stylesheets: [] },
    { syntaxHighlighters: [] },
    { contentRenderers: [{ id: "preview", languages: ["test"], title: "Preview", render: () => html`` }] },
    { contentRenderers: [{ id: "preview", supports: () => true, render: () => html`` }] },
    { themes: [{ id: "theme", name: "Theme", colorScheme: "dark", stylesheets: [] }] },
  ])("rejects new contribution shapes on v4: %j", async (contributions) => {
    const registry = new PluginRegistry();
    try {
      await expect(registry.register({ id: "legacy", plugin: { apiVersion: 4, name: "Legacy", activate: () => ({ contributions }) } }))
        .rejects.toThrow("require browser API v5");
      expect(registry.hasPlugin("legacy")).toBe(false);
    } finally { await registry.dispose(); }
  });

  it("rejects compatibility-only token palettes on v5", async () => {
    const registry = new PluginRegistry();
    try {
      await expect(registry.register({ id: "modern", plugin: { apiVersion: 5, name: "Modern", activate: () => ({ contributions: {
        themes: [{ id: "theme", name: "Theme", colorScheme: "dark", tokens: {} }],
      } }) } })).rejects.toThrow("v5 themes use stylesheets, not tokens");
    } finally { await registry.dispose(); }
  });

  it("exposes question metadata only to v5 entry-action callbacks", async () => {
    const registry = new PluginRegistry();
    const legacyVisible = vi.fn(() => true);
    const modernVisible = vi.fn(() => true);
    try {
      for (const apiVersion of [4, 5] as const) {
        await registry.register({ id: `v${String(apiVersion)}`, plugin: { apiVersion, name: "Messages", activate: () => ({ contributions: {
          messageActions: [{ id: "action", title: "Action", visible: apiVersion === 4 ? legacyVisible : modernVisible, run: () => undefined }],
        } }) } });
      }
      const context = {
        machine: { id: "local", name: "Local", kind: "local" as const },
        session: { id: "session", cwd: "/repo", archived: false, pending: false, busy: false },
        message: { entryId: "question", role: "tool" as const, text: "", isQuestion: true },
      };
      availableMessageActions(registry.getMessageActions("local"), context);
      expect(legacyVisible).toHaveBeenCalledWith({ ...context, message: { entryId: "question", role: "tool", text: "" } });
      expect(modernVisible).toHaveBeenCalledWith(context);
    } finally { await registry.dispose(); }
  });

  it("keeps v4 renderer inputs at their released shape", async () => {
    const render = vi.fn<ContentRendererContribution["render"]>(() => html``);
    const registry = new PluginRegistry();
    try {
      await registry.register({ id: "legacy", plugin: { apiVersion: 4, name: "Legacy", activate: () => ({ contributions: {
        contentRenderers: [{ id: "preview", languages: ["test"], render }],
      } }) } });
      const input = { text: "source", signal: new AbortController().signal, fail: vi.fn(), machineId: "local", language: "test", filePath: "source.test" };
      registry.matchContentRenderers({ machineId: "local", language: "test", text: "source" })[0]?.renderer.render(input);
      expect(Object.keys(render.mock.calls[0]?.[0] ?? {}).sort()).toEqual(["fail", "signal", "text"]);
    } finally { await registry.dispose(); }
  });
});
