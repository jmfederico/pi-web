import { existsSync, readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { afterEach, describe, expect, it } from "vitest";

const siteScript = readFileSync(new URL("../docs/site.js", import.meta.url), "utf8");

describe("documentation navigation", () => {
  it.each(["index.html", "config.html", "plugins.html", "community-plugins.html", "faq.html"])("keeps local links and copy targets valid in %s", (page) => {
    const window = new Window({ url: `https://pi-web.dev/${page}` });
    try {
      window.document.write(readFileSync(new URL(`../docs/${page}`, import.meta.url), "utf8"));
      const ids = [...window.document.querySelectorAll("[id]")].map((element) => element.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const link of window.document.querySelectorAll("a[href]")) {
        const href = link.getAttribute("href");
        if (/^https?:/.test(href)) continue;
        const [path, fragment] = href.split("#");
        const filename = !path ? page : path === "./" ? "index.html" : path.includes(".") ? path : `${path}.html`;
        const target = new URL(`../docs/${filename}`, import.meta.url);
        expect(existsSync(target), href).toBe(true);
        if (fragment) {
          const content = readFileSync(target, "utf8");
          if (filename.endsWith(".md")) {
            const headings = [...content.matchAll(/^#{1,6} (.+)$/gm)].map((match) =>
              match[1].toLowerCase().replace(/[^\w\s-]/g, "").replace(/\s/g, "-"),
            );
            expect(headings, href).toContain(fragment);
          } else {
            const document = new window.DOMParser().parseFromString(content, "text/html");
            expect(document.getElementById(fragment), href).not.toBeNull();
          }
        }
      }
      for (const button of window.document.querySelectorAll("[data-copy]")) {
        expect(window.document.querySelector(button.getAttribute("data-copy"))).not.toBeNull();
      }
    } finally {
      window.close();
    }
  });
});

describe("compact documentation contents menu", () => {
  it.each(["config", "install", "plugins", "machines", "remote-first", "faq"])("reuses the %s table of contents and closes on selection", (page) => {
    const window = new Window({ url: `https://pi-web.dev/${page}`, width: 390, height: 844 });
    try {
      window.document.write(readFileSync(new URL(`../docs/${page}.html`, import.meta.url), "utf8"));
      window.eval(siteScript);
      const sources = [...window.document.querySelectorAll('.toc a[href^="#"], .reference-nav a[href^="#"]')];
      const dialog = window.document.querySelector(".docs-toc-dialog");
      const toggle = window.document.querySelector(".docs-toc-toggle");
      const links = [...dialog.querySelectorAll("nav a")];
      expect(links.map((link) => link.getAttribute("href"))).toEqual(sources.map((link) => link.getAttribute("href")));
      expect(links.map((link) => link.textContent)).toEqual(sources.map((link) => link.textContent));
      toggle.click();
      expect(dialog.open).toBe(true);
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      links[0].click();
      expect(dialog.open).toBe(false);
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(window.document.activeElement.id).toBe(links[0].hash.slice(1));
      toggle.click();
      dialog.querySelector("button").click();
      expect(dialog.open).toBe(false);
    } finally {
      window.close();
    }
  });

  it("does not add a contents button to pages without a table of contents", () => {
    const window = new Window();
    try {
      window.eval(siteScript);
      expect(window.document.querySelector(".docs-toc-toggle")).toBeNull();
    } finally {
      window.close();
    }
  });
});

describe("website theme toggle", () => {
  const windows = [];

  function openPage({ storedTheme = null, systemLight = false } = {}) {
    const window = new Window({ url: "https://pi-web.dev/" });
    windows.push(window);
    if (storedTheme !== null) window.localStorage.setItem("pi-web-theme", storedTheme);
    const colorScheme = new window.EventTarget();
    colorScheme.matches = systemLight;
    const matchMedia = window.matchMedia.bind(window);
    window.matchMedia = (query) => query === "(prefers-color-scheme: light)" ? colorScheme : matchMedia(query);
    window.document.write(readFileSync(new URL("../docs/index.html", import.meta.url), "utf8"));
    // Run the real early theme initializer as well as site.js, without fetching external assets.
    for (const script of window.document.querySelectorAll("script:not([src]):not([type])")) {
      window.eval(script.textContent);
    }
    window.eval(siteScript);
    return {
      window,
      root: window.document.documentElement,
      button: window.document.querySelector("[data-theme-toggle]"),
      setSystemLight(matches) {
        colorScheme.matches = matches;
        colorScheme.dispatchEvent(new window.Event("change"));
      },
    };
  }

  afterEach(() => {
    for (const window of windows.splice(0)) window.close();
  });

  it.each([null, "unknown"])("defaults to automatic mode for stored preference %s", (storedTheme) => {
    const { root, button } = openPage({ storedTheme });
    expect(root.hasAttribute("data-theme")).toBe(false);
    expect(button.dataset.theme).toBe("auto");
    expect(button.dataset.activeTheme).toBe("dark");
  });

  it("follows system changes in automatic mode without saving a fixed theme", () => {
    const { window, root, button, setSystemLight } = openPage({ storedTheme: "auto", systemLight: true });
    expect(button.dataset.activeTheme).toBe("light");
    setSystemLight(false);
    expect(button.dataset.activeTheme).toBe("dark");
    setSystemLight(true);
    expect(button.dataset.activeTheme).toBe("light");
    expect(button.dataset.theme).toBe("auto");
    expect(root.hasAttribute("data-theme")).toBe(false);
    expect(window.localStorage.getItem("pi-web-theme")).toBe("auto");
  });

  it.each(["dark", "light"])("restores explicit %s mode and ignores system changes", (mode) => {
    const { window, root, button, setSystemLight } = openPage({ storedTheme: mode, systemLight: mode === "dark" });
    expect(root.dataset.theme).toBe(mode);
    expect(button.dataset.theme).toBe(mode);
    expect(button.dataset.activeTheme).toBe(mode);
    setSystemLight(false);
    setSystemLight(true);
    expect(root.dataset.theme).toBe(mode);
    expect(button.dataset.activeTheme).toBe(mode);
    expect(window.localStorage.getItem("pi-web-theme")).toBe(mode);
  });

  it("cycles auto → dark → light → auto and retains each choice on the next page load", () => {
    let page = openPage({ systemLight: true });
    for (const mode of ["dark", "light", "auto"]) {
      page.button.click();
      const active = mode === "auto" ? "light" : mode;
      expect(page.root.dataset.theme).toBe(mode === "auto" ? undefined : mode);
      expect(page.button.dataset.theme).toBe(mode);
      expect(page.button.dataset.activeTheme).toBe(active);
      const storedTheme = page.window.localStorage.getItem("pi-web-theme");
      expect(storedTheme).toBe(mode);
      page = openPage({ storedTheme, systemLight: true });
      expect(page.root.dataset.theme).toBe(mode === "auto" ? undefined : mode);
      expect(page.button.dataset.theme).toBe(mode);
      expect(page.button.dataset.activeTheme).toBe(active);
    }
    page.setSystemLight(false);
    expect(page.button.dataset.activeTheme).toBe("dark");
  });
});
