import { expect, it, vi } from "vitest";
import { PluginRegistry } from "./registry";
import type { PiWebPlugin } from "./types";

it("warns once for each published v5 runtime theme and pair while retaining compatibility", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const registry = new PluginRegistry();
  const plugin: PiWebPlugin = {
    apiVersion: 5, name: "Legacy themes", activate: () => ({ contributions: {
      themes: [
        { id: "light", name: "Light", colorScheme: "light", stylesheets: [{ id: "palette", url: "https://example.com/light.css" }] },
        { id: "dark", name: "Dark", colorScheme: "dark" },
      ],
      themePairs: [{ id: "auto", name: "Automatic", light: "light", dark: "dark" }],
    } }),
  };
  try {
    await registry.register({ id: "legacy", plugin });
    expect(registry.getThemes().map(({ id }) => id)).toEqual(["legacy:dark", "legacy:light"]);
    expect(registry.getThemePairs()[0]).toMatchObject({ id: "legacy:auto", light: "legacy:light", dark: "legacy:dark" });
    expect(warn).toHaveBeenCalledTimes(3);
    for (const id of ["legacy:light", "legacy:dark", "legacy:auto"]) {
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`deprecated runtime .*${id}.*package\\.json`)));
    }
    registry.getThemes();
    registry.getThemePairs();
    expect(warn).toHaveBeenCalledTimes(3);
  } finally {
    await registry.dispose();
    warn.mockRestore();
  }
});

it("does not warn for plugins without runtime palettes or pairs", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const registry = new PluginRegistry();
  try {
    await registry.register({ id: "no-themes", plugin: { apiVersion: 5, name: "No themes", activate: () => ({ contributions: { themes: [], themePairs: [] } }) } });
    expect(warn).not.toHaveBeenCalled();
  } finally {
    await registry.dispose();
    warn.mockRestore();
  }
});
