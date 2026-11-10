import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname } from "node:path";
import { setImmediate } from "node:timers/promises";
import { Window } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const docsRoot = new URL("../docs/", import.meta.url);
const siteOrigin = "https://pi-web.dev";
const siteScript = readFileSync(new URL("site.js", docsRoot), "utf8");
// Discover pages rather than maintaining a list that can miss new documentation.
const pages = readdirSync(docsRoot, { recursive: true })
  .filter((path) => path.endsWith(".html") && !path.split(/[\\/]/).some((part) => part.startsWith(".")))
  .sort();

function localTarget(reference, page, { navigation = false } = {}) {
  // Absolute published URLs (including the separately built dev site) are not local source files.
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(reference)) return null;
  const url = new URL(reference, `${siteOrigin}/${page}`);
  if (url.origin !== siteOrigin) return null;
  // Root-relative 404 links are relative to the published docs root, not the repository.
  let path = decodeURIComponent(url.pathname).slice(1);
  if (navigation) {
    if (path.endsWith("/") || path === "") path += "index.html";
    else if (!extname(path)) path += ".html";
  }
  return { file: new URL(path, docsRoot), fragment: decodeURIComponent(url.hash.slice(1)) };
}

describe("documentation navigation", () => {
  it.each(pages)("keeps local links, assets, IDs and copy targets valid in %s", (page) => {
    const window = new Window({ url: `https://pi-web.dev/${page}` });
    try {
      window.document.write(readFileSync(new URL(`../docs/${page}`, import.meta.url), "utf8"));
      const ids = [...window.document.querySelectorAll("[id]")].map((element) => element.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const link of window.document.querySelectorAll("a[href]")) {
        const href = link.getAttribute("href");
        const target = localTarget(href, page, { navigation: true });
        if (target === null) continue;
        expect(existsSync(target.file), `${page}: ${href}`).toBe(true);
        expect(statSync(target.file).isFile(), `${page}: ${href}`).toBe(true);
        const { fragment } = target;
        if (fragment) {
          const content = readFileSync(target.file, "utf8");
          if (target.file.pathname.endsWith(".md")) {
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
      for (const element of window.document.querySelectorAll('script[src], link[rel~="stylesheet"][href], link[rel~="icon"][href], img[src]')) {
        const reference = element.getAttribute("src") ?? element.getAttribute("href");
        const target = localTarget(reference, page);
        if (target === null) continue;
        expect(existsSync(target.file), `${page}: ${reference}`).toBe(true);
        expect(statSync(target.file).isFile(), `${page}: ${reference}`).toBe(true);
      }
      for (const button of window.document.querySelectorAll("[data-copy]")) {
        const selector = button.getAttribute("data-copy");
        const targets = window.document.querySelectorAll(selector);
        expect(targets.length, `${page}: ${selector}`).toBe(1);
        expect(targets[0].textContent.trim(), `${page}: ${selector}`).not.toBe("");
      }
    } finally {
      window.close();
    }
  });
});

describe("documentation clipboard controls", () => {
  const windows = [];

  function openCopyControl(page, selector) {
    const window = new Window({ url: `${siteOrigin}/${page}` });
    windows.push(window);
    window.document.write(readFileSync(new URL(page, docsRoot), "utf8"));
    const button = window.document.querySelector(`[data-copy="${selector}"]`);
    const target = window.document.querySelector(selector);
    expect(button).not.toBeNull();
    expect(target).not.toBeNull();
    const writeText = vi.spyOn(window.navigator.clipboard, "writeText").mockResolvedValue(undefined);
    // Control only the browser timer boundary; exercise the actual click handler.
    const timers = [];
    window.setTimeout = (callback) => timers.push(callback);
    window.eval(siteScript);
    return { window, button, target, writeText, restoreFeedback: () => timers.splice(0).forEach((callback) => callback()) };
  }

  afterEach(() => {
    for (const window of windows.splice(0)) window.close();
    vi.restoreAllMocks();
  });

  it("copies installation commands without shell prompts and restores the button after success", async () => {
    const { button, writeText, restoreFeedback } = openCopyControl("install.html", "#linux-install");
    const original = button.textContent;
    let resolveWrite;
    writeText.mockReturnValue(new Promise((resolve) => { resolveWrite = resolve; }));
    button.click();
    expect(writeText).toHaveBeenCalledExactlyOnceWith([
      "npm install -g @jmfederico/pi-web --allow-scripts=node-pty",
      "pi-web install",
      "pi-web doctor",
    ].join("\n"));
    expect(button.textContent).toBe(original);
    resolveWrite();
    // The evaluated handler and the clipboard mock use different promise realms.
    await setImmediate();
    expect(button.textContent.trim()).not.toBe("");
    expect(button.textContent).not.toBe(original);
    restoreFeedback();
    expect(button.textContent).toBe(original);
  });

  it.each([
    ["install.html", "#nginx-prefix-proxy"],
    ["config.html", "#project-config-example"],
    ["plugins.html", "#plugin-prompt"],
  ])("copies %s %s without changing non-shell content", async (page, selector) => {
    const { button, target, writeText } = openCopyControl(page, selector);
    button.click();
    await setImmediate();
    expect(writeText).toHaveBeenCalledExactlyOnceWith(target.textContent.trim());
  });

  it("copies the homepage installer unchanged from the installation guide", async () => {
    const home = openCopyControl("index.html", "#home-install");
    const guide = openCopyControl("install.html", "#one-line-install");
    home.button.click();
    guide.button.click();
    await setImmediate();
    const command = "curl -fsSL https://raw.githubusercontent.com/jmfederico/pi-web/main/install.sh | sh";
    expect(home.writeText).toHaveBeenCalledExactlyOnceWith(command);
    expect(guide.writeText).toHaveBeenCalledExactlyOnceWith(command);
  });

  it("strips only leading shell prompts, retaining variables, quoted dollars and continuation indentation", async () => {
    const { button, target, writeText } = openCopyControl("install.html", "#linux-install");
    // Supply edge-case command content through a real page target, not a replacement handler.
    target.textContent = [
      '  $ printf "%s\\n" "$HOME" "cost: $ 5"',
      "$ pi-web install \\",
      '    --config "$HOME/pi web/config.json"',
      "# Keep this command comment",
      '$ echo "$(whoami)"',
    ].join("\n");
    button.click();
    await setImmediate();
    expect(writeText).toHaveBeenCalledExactlyOnceWith([
      'printf "%s\\n" "$HOME" "cost: $ 5"',
      "pi-web install \\",
      '    --config "$HOME/pi web/config.json"',
      "# Keep this command comment",
      'echo "$(whoami)"',
    ].join("\n"));
  });

  it("handles clipboard denial without reporting success and permits retry", async () => {
    const { button, writeText, restoreFeedback } = openCopyControl("install.html", "#linux-install");
    writeText.mockRejectedValueOnce(new Error("Clipboard permission denied"));
    const original = button.textContent;
    button.click();
    await setImmediate();
    expect(writeText).toHaveBeenCalledTimes(1);
    const failureFeedback = button.textContent;
    expect(failureFeedback.trim()).not.toBe("");
    expect(failureFeedback).not.toBe(original);
    restoreFeedback();
    expect(button.textContent).toBe(failureFeedback);
    button.click();
    await setImmediate();
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(writeText.mock.calls[1]).toEqual(writeText.mock.calls[0]);
    expect(button.textContent).not.toBe(failureFeedback);
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
