import { describe, expect, it } from "vitest";
import { PluginRegistry } from "./registry";
import { stylesheetIntegrationCapabilityToken } from "./styles";
import type { PiWebPlugin, StylesheetContribution } from "./types";

function plugin(stylesheets: StylesheetContribution[]): PiWebPlugin {
  return { apiVersion: 5, name: "Styles", activate: () => ({ contributions: { stylesheets } }) };
}

const file = { id: "custom", url: "https://plugins.test/custom.css" };

describe("plugin stylesheet contributions", () => {
  it("publishes only started, enabled contributions and removes them on shutdown", async () => {
    let enabled = true;
    const registry = new PluginRegistry({ isContributionEnabled: () => enabled });
    await registry.register({ id: "styles", plugin: plugin([file]) });
    expect(registry.getStylesheets("local")).toEqual([{ ...file, id: "styles:custom", pluginId: "styles" }]);
    enabled = false;
    expect(registry.getStylesheets("local")).toEqual([]);
    enabled = true;
    registry.beginShutdown();
    expect(registry.getStylesheets("local")).toEqual([]);
    await registry.dispose();
  });

  it("snapshots files and respects machine eligibility", async () => {
    const registry = new PluginRegistry();
    const style = { ...file };
    await registry.register({ id: "remote-styles", sourcePluginId: "styles", machineId: "remote", plugin: plugin([style]) });
    style.url = "https://plugins.test/changed.css";
    expect(registry.getStylesheets("local")).toEqual([]);
    expect(registry.getStylesheets("remote")[0]?.url).toBe(file.url);
    await registry.dispose();
  });

  it.each([
    { ...file, url: "data:text/css,body{}" },
    { ...file, url: "./custom.css" },
    { ...file, order: NaN },
    { ...file, id: "invalid:id" },
  ])("rejects invalid file declarations before publication: %j", async (style) => {
    const registry = new PluginRegistry();
    await expect(registry.register({ id: "styles", plugin: plugin([style]) })).rejects.toThrow();
    expect(registry.getStylesheets("local")).toEqual([]);
    await registry.dispose();
  });

  it("does not publish styles from a failed start", async () => {
    const registry = new PluginRegistry();
    await expect(registry.register({ id: "styles", plugin: {
      apiVersion: 5, name: "Failed", activate: () => ({ contributions: { stylesheets: [file] }, start: () => { throw new Error("start failed"); } }),
    } })).rejects.toThrow("start failed");
    expect(registry.getStylesheets("local")).toEqual([]);
    await registry.dispose();
  });

  it("qualifies theme-owned files separately and ignores machine-bound themes", async () => {
    const registry = new PluginRegistry();
    const themes: PiWebPlugin = { apiVersion: 5, name: "Themes", activate: () => ({ contributions: {
      themes: ["light", "dark"].map((id) => ({ id, name: id, colorScheme: "dark", stylesheets: [file] })),
    } }) };
    await registry.register({ id: "themes", plugin: themes });
    expect(registry.getThemes().map((theme) => theme.stylesheets?.[0]?.id)).toEqual(["themes:dark:custom", "themes:light:custom"]);
    expect(registry.getStylesheets("local")).toEqual([]);
    await registry.register({ id: "remote-themes", machineId: "remote", plugin: themes });
    expect(registry.getThemes()).toHaveLength(2);
    await registry.dispose();
  });

  it("provides the framework-independent and Lit integration capability during start", async () => {
    const registry = new PluginRegistry();
    await registry.register({ id: "consumer", plugin: {
      apiVersion: 5, name: "Consumer", requires: [stylesheetIntegrationCapabilityToken],
      activate: () => ({ contributions: {}, start: ({ capabilities }) => {
        const integration = capabilities.resolve(stylesheetIntegrationCapabilityToken);
        expect(integration.registerRoot).toBeTypeOf("function");
        expect(integration.createController).toBeTypeOf("function");
        expect(integration.subscribe).toBeTypeOf("function");
      } }),
    } });
    await registry.dispose();
  });
});
