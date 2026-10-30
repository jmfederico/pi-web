import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it("ships stable built-in theme identities and pairs without executable entrypoints", async () => {
  // The checked-in manifest is test input, not an untrusted catalog parser boundary.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const manifest: {
    piWeb: { plugins: [{ id: string; browserRoot: string; module?: string; serverModule?: string;
      themes: { id: string; colorScheme: string; stylesheets: { id: string; path: string }[] }[];
      themePairs: { id: string; light: string; dark: string }[] }] };
  } = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8"));
  const plugin = manifest.piWeb.plugins[0];
  expect(plugin.id).toBe("themes");
  expect(plugin.module).toBeUndefined();
  expect(plugin.serverModule).toBeUndefined();
  expect(plugin.themes.map(({ id, colorScheme }) => [id, colorScheme])).toEqual([
    ["pi-web-dark", "dark"], ["pi-web-light", "light"], ["classic", "dark"], ["paper", "light"], ["graphite", "dark"],
  ]);
  expect(plugin.themePairs.map(({ id, light, dark }) => [id, light, dark])).toEqual([
    ["pi-web", "pi-web-light", "pi-web-dark"], ["paper-graphite", "paper", "graphite"],
  ]);
  for (const theme of plugin.themes) {
    expect(theme.stylesheets).toEqual([
      { id: "palette", path: `${theme.id}.css` },
    ]);
    const css = await readFile(new URL(`./${plugin.browserRoot}/${theme.stylesheets[0]?.path ?? ""}`, import.meta.url), "utf8");
    expect(css).toContain("--pi-bg:");
  }
});
