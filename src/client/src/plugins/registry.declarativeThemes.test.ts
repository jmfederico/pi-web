// @vitest-environment happy-dom
import { expect, it } from "vitest";
import { PluginRegistry } from "./registry";
import type { QualifiedThemeContribution, QualifiedThemePairContribution } from "./types";

const light: QualifiedThemeContribution = { id: "pack:light", pluginId: "pack", localId: "light", name: "Light", colorScheme: "light", stylesheets: [] };
const pair: QualifiedThemePairContribution = { id: "pack:pair", pluginId: "pack", localId: "pair", name: "Pair", light: "pack:light", dark: "pack:dark" };

it("exposes backend-enabled themes before browser activation without granting other plugin contributions", () => {
  const registry = new PluginRegistry({ isContributionEnabled: () => false });
  registry.setDeclarativeThemes([light], [pair]);
  expect(registry.getThemes()).toEqual([light]);
  expect(registry.getThemePairs()).toEqual([pair]);
  expect(registry.hasPlugin("pack")).toBe(false);
});

it("rejects duplicate pair ownership when declarative inventory arrives after runtime activation", async () => {
  const registry = new PluginRegistry();
  await registry.register({ id: "pack", plugin: { apiVersion: 5, name: "Runtime", activate: () => ({ contributions: {
    themes: [{ id: "light", name: "Light", colorScheme: "light" }, { id: "dark", name: "Dark", colorScheme: "dark" }],
    themePairs: [{ id: "pair", name: "Pair", light: "light", dark: "dark" }],
  } }) } });
  expect(() => { registry.setDeclarativeThemes([], [pair]); }).toThrow("declared both statically and at runtime");
  expect(registry.getThemePairs()).toHaveLength(1);
  await registry.dispose();
});

it("rejects runtime redeclaration of a static theme instead of silently choosing an owner", async () => {
  const registry = new PluginRegistry();
  registry.setDeclarativeThemes([light], []);
  await expect(registry.register({ id: "pack", plugin: {
    apiVersion: 5, name: "Duplicate", activate: () => ({ contributions: { themes: [{ id: "light", name: "Light", colorScheme: "light", stylesheets: [] }] } }),
  } })).rejects.toThrow("declared both statically and at runtime");
  expect(registry.getThemes()).toEqual([light]);
  expect(registry.hasPlugin("pack")).toBe(false);
  await registry.dispose();
});
