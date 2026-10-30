// @vitest-environment happy-dom
import { afterEach, expect, it } from "vitest";
import { applyPiWebTheme, clearPiWebTheme } from "./theme";

afterEach(() => {
  document.head.replaceChildren();
  document.documentElement.removeAttribute("style");
  document.documentElement.removeAttribute("data-pi-web-theme");
});

it("creates the toolbar colour only when a theme commits and reuses it on switches", () => {
  expect(document.querySelector('meta[name="theme-color"]')).toBeNull();
  const theme = { id: "custom:light" as const, pluginId: "custom", localId: "light", name: "Light", colorScheme: "light" as const, tokens: { "--pi-bg": "#fff" } };
  applyPiWebTheme(theme);
  expect(document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content).toBe("#fff");
  applyPiWebTheme({ ...theme, tokens: { "--pi-bg": "#eee" } });
  expect(document.querySelectorAll('meta[name="theme-color"]')).toHaveLength(1);
  expect(document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content).toBe("#eee");
});

it("updates existing toolbar colours from the committed palette and restores browser defaults on unload", () => {
  document.head.innerHTML = '<style>:root { --pi-bg: #070912; }</style><meta name="theme-color" media="(prefers-color-scheme: dark)"><meta name="theme-color" media="(prefers-color-scheme: light)">';
  const root = document.documentElement;
  applyPiWebTheme({ id: "custom:light", pluginId: "custom", localId: "light", name: "Light", colorScheme: "light", tokens: { "--pi-bg": "#fff", "--pi-text": "#000" } });
  expect(root.dataset["piWebTheme"]).toBe("custom:light");
  expect(root.style.colorScheme).toBe("light");
  const metas = [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')];
  expect(metas.map((meta) => meta.content)).toEqual(["#fff", "#fff"]);
  clearPiWebTheme();
  expect(root.dataset["piWebTheme"]).toBeUndefined();
  expect(root.style.getPropertyValue("--pi-bg")).toBe("");
  expect(root.style.getPropertyValue("--pi-text")).toBe("");
  expect(root.style.colorScheme).toBe("");
  expect(document.querySelectorAll('meta[name="theme-color"]')).toHaveLength(0);
});
