// @vitest-environment happy-dom
import { readFile } from "node:fs/promises";
import { parse, walk } from "css-tree";
import { afterEach, describe, expect, it } from "vitest";
import { PluginRegistry } from "../registry";
import { applyPiWebTheme, DEFAULT_THEME_PREFERENCE, resolveThemePreference } from "../../theme";
import { themePackPlugin } from "./index";

afterEach(() => {
  document.documentElement.removeAttribute("style");
  delete document.documentElement.dataset["piWebTheme"];
});

describe("built-in CSS themes", () => {
  it("preserves theme identities, metadata, and automatic pairing through registration", async () => {
    const registry = new PluginRegistry();
    await registry.register({ id: "themes", plugin: themePackPlugin });
    const themes = registry.getThemes();
    const themePairs = registry.getThemePairs();
    expect(themes.map((theme) => ({ id: theme.id, colorScheme: theme.colorScheme }))).toEqual([
      { id: "themes:pi-web-dark", colorScheme: "dark" },
      { id: "themes:pi-web-light", colorScheme: "light" },
      { id: "themes:classic", colorScheme: "dark" },
    ]);
    expect(themePairs.map((pair) => ({ id: pair.id, light: pair.light, dark: pair.dark }))).toEqual([
      { id: "themes:pi-web", light: "themes:pi-web-light", dark: "themes:pi-web-dark" },
    ]);
    for (const prefersLight of [false, true]) {
      const { activeTheme } = resolveThemePreference({ themes, themePairs, preference: DEFAULT_THEME_PREFERENCE, prefersLight });
      expect(activeTheme?.stylesheets).toHaveLength(1);
      expect(activeTheme?.stylesheets?.[0]?.id).toBe(`themes:pi-web-${prefersLight ? "light" : "dark"}:palette`);
      expect(activeTheme?.stylesheets?.[0]?.url).toMatch(/^http:\/\/.*\/pi-web-(light|dark)\.css\?no-inline$/);
    }
    const light = themes.find((theme) => theme.colorScheme === "light");
    if (light === undefined) throw new Error("Missing built-in Light theme");
    applyPiWebTheme(light);
    expect(document.documentElement.dataset["piWebTheme"]).toBe("themes:pi-web-light");
    expect(document.documentElement.style.colorScheme).toBe("light");
    expect(document.documentElement.style.getPropertyValue("--pi-bg")).toBe("");
    await registry.dispose();
  });

  it("ships complete CSS palettes with the original background and text colors", async () => {
    const expectedColors = {
      "pi-web-dark": ["#070912", "#f7f4ff"],
      "pi-web-light": ["#f7f1e6", "#15131b"],
      classic: ["#0d1117", "#e6edf3"],
    };
    let properties: string[] | undefined;
    for (const [id, colors] of Object.entries(expectedColors)) {
      const css = await readFile(`src/client/src/plugins/themes/${id}.css`, "utf8");
      const declarations = new Map<string, string>();
      walk(parse(css, { parseCustomProperty: false }), {
        visit: "Declaration",
        enter(node) {
          if (node.value.type !== "Raw") throw new Error("Expected a custom property value");
          declarations.set(node.property, node.value.value.trim());
        },
      });
      expect(css).toMatch(/^:root \{/);
      expect([...declarations.keys()]).toEqual(expect.arrayContaining([
        "--pi-font", "--pi-mono", "--pi-thinking", "--pi-tool",
        "--pi-syntax-comment", "--pi-syntax-keyword", "--pi-syntax-string",
        "--pi-syntax-number", "--pi-syntax-title", "--pi-syntax-deletion",
        "--pi-chat-conversation-bg", "--pi-chat-conversation-border",
        "--pi-chat-user-bg", "--pi-chat-user-border", "--pi-chat-system-bg",
        "--pi-chat-activity-bg", "--pi-chat-compacting-bg",
      ]));
      expect(declarations.get("--pi-syntax-deletion")).toBe("var(--pi-danger)");
      for (const value of declarations.values()) {
        for (const reference of value.matchAll(/var\((--pi-[\w-]+)/g)) {
          expect([...declarations.keys()], `${id} has an unresolved palette reference`).toContain(reference[1]);
        }
      }
      expect([declarations.get("--pi-bg"), declarations.get("--pi-text")]).toEqual(colors);
      properties ??= [...declarations.keys()].sort();
      expect([...declarations.keys()].sort()).toEqual(properties);
    }
  });
});
