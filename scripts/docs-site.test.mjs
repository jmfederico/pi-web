import { existsSync, readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const siteScript = readFileSync(new URL("../docs/site.js", import.meta.url), "utf8");
const siteStyles = readFileSync(new URL("../docs/styles.css", import.meta.url), "utf8");

function createAnimatedHomePage(initialScrollY = 0) {
  const window = new Window({ url: "https://pi-web.dev/" });
  const style = window.document.createElement("style");
  style.textContent = siteStyles;
  window.document.head.append(style);
  window.document.body.className = "home-page";
  window.document.body.innerHTML = `
    <header class="site-header"></header>
    <main>
      <section class="hero"><span class="intro-word">Pi</span></section>
      <section class="section">More PI WEB content</section>
    </main>
  `;
  window.scrollTo(0, initialScrollY);
  window.eval(siteScript);
  return window;
}

function animationState(window, selector) {
  const element = window.document.querySelector(selector);
  if (element === null) throw new Error(`Missing test element: ${selector}`);
  const style = window.getComputedStyle(element);
  return { animation: style.animation, opacity: style.opacity, transform: style.transform };
}

describe("configuration documentation navigation", () => {
  it("exposes setting scope, defaults, purpose, and restart rules without opening details", () => {
    const window = new Window();
    try {
      window.document.write(readFileSync(new URL("../docs/config.html", import.meta.url), "utf8"));
      const tables = [...window.document.querySelectorAll(".settings-table")];
      expect(tables.length).toBeGreaterThan(0);
      for (const table of tables) {
        expect(table.closest("details")).toBeNull();
        expect([...table.querySelectorAll("thead th")].map((cell) => cell.textContent)).toEqual([
          "Setting", "Applies to", "Default", "What it changes", "Apply / restart",
        ]);
        for (const row of table.querySelectorAll("tbody tr")) {
          expect(row.children.length).toBe(5);
          expect(row.querySelector('th[scope="row"]')).not.toBeNull();
          for (const cell of row.children) expect(cell.textContent.trim()).not.toBe("");
        }
      }
    } finally {
      window.close();
    }
  });

  it.each(["config.html", "plugins.html", "community-plugins.html", "faq.html"])("keeps local links and copy targets valid in %s", (page) => {
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

describe("plugin guide", () => {
  it("offers a copyable agent prompt with a documentation entry point and one final input", () => {
    const window = new Window();
    try {
      window.document.write(readFileSync(new URL("../docs/plugins.html", import.meta.url), "utf8"));
      const prompt = window.document.querySelector("#agent-development pre code").textContent;
      expect(prompt).toContain("https://pi-web.dev/plugins.md");
      expect(prompt.match(/\[[^\]]+\]/g)).toEqual(["[Describe your plugin]"]);
      expect(prompt.trim().endsWith("[Describe your plugin]")).toBe(true);
      const copyButton = window.document.querySelector("#agent-development [data-copy]");
      expect(window.document.querySelector(copyButton.getAttribute("data-copy")).textContent).toBe(prompt);
    } finally {
      window.close();
    }
  });
});

describe("plugin directory navigation", () => {
  it.each(["index", "remote-first", "machines", "install", "config", "faq", "plugins", "community-plugins"])("opens the directory from the Plugins menu on %s", (page) => {
    const window = new Window();
    try {
      window.document.write(readFileSync(new URL(`../docs/${page}.html`, import.meta.url), "utf8"));
      const link = [...window.document.querySelectorAll(".nav-pages a")].find((link) => link.textContent === "Plugins");
      expect(link.getAttribute("href")).toBe("community-plugins");
      expect(link.getAttribute("aria-current")).toBe(page === "community-plugins" ? "page" : null);
      if (page === "community-plugins") {
        expect(window.document.querySelector('.page-hero a[href="plugins"]').textContent).toBe("Plugin guide");
        expect(window.document.querySelector('.page-hero a[href="plugins#agent-development"]').textContent).toBe("Build a plugin");
      }
      if (page === "plugins") {
        expect(window.document.querySelector('.page-hero a[href="community-plugins"]').textContent).toContain("Browse community plugins");
      }
    } finally {
      window.close();
    }
  });
});

describe("community plugin discovery", () => {
  it("searches each publishing keyword independently and explains the trust boundary", () => {
    const window = new Window({ url: "https://pi-web.dev/community-plugins" });
    try {
      window.document.write(readFileSync(new URL("../docs/community-plugins.html", import.meta.url), "utf8"));
      const searches = [...window.document.querySelectorAll('#discover a[href^="https://www.npmjs.com/search"]')];
      expect(searches.map((link) => new URL(link.href).searchParams.get("q"))).toEqual([
        "keywords:pi-web.dev-plugin",
        "keywords:pi-web-plugin",
      ]);
      const snippet = window.document.querySelector("#publish pre code");
      expect(snippet.closest(".code-card")).not.toBeNull();
      const keywords = JSON.parse(snippet.textContent).keywords;
      expect(keywords).toEqual(["pi-web.dev-plugin", "pi-package", "pi-web-plugin"]);
      expect(window.document.querySelector("#discover").textContent).toContain("not reviewed or endorsed");
      expect(window.document.querySelector("#install").textContent).toContain("npm:@scope/package-name");
    } finally {
      window.close();
    }
  });
});

describe("community plugin directory layout", () => {
  it("keeps discovery prominent and guides available in collapsed native disclosures", () => {
    const window = new Window({ url: "https://pi-web.dev/community-plugins" });
    try {
      window.document.write(readFileSync(new URL("../docs/community-plugins.html", import.meta.url), "utf8"));
      window.eval(siteScript);
      expect(window.document.querySelector(".toc, .docs-toc-toggle")).toBeNull();
      for (const id of ["install", "publish"]) {
        const guide = window.document.getElementById(id);
        expect(guide.tagName).toBe("DETAILS");
        expect(guide.open).toBe(false);
        expect(guide.querySelector("summary").textContent).not.toBe("");
      }
      expect(window.document.querySelector("[data-plugin-search]").closest("details")).toBeNull();
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

describe("homepage screenshot themes", () => {
  let window;
  let motion;
  let colorScheme;
  const query = (selector) => window.document.querySelector(selector);
  const selected = () => query("[data-demo-theme-caption]").textContent;
  const click = (selector) => query(selector).click();
  const advance = () => vi.advanceTimersByTime(3000);

  function openPage({ reducedMotion = false, runScript = true, pageTheme = "dark", systemLight = false } = {}) {
    vi.useFakeTimers();
    window = new Window({ url: "https://pi-web.dev/" });
    window.document.write(readFileSync(new URL("../docs/index.html", import.meta.url), "utf8"));
    // Only clock and browser preference/visibility boundaries are controlled.
    window.setTimeout = setTimeout;
    window.clearTimeout = clearTimeout;
    window.queueMicrotask = (callback) => Promise.resolve().then(callback);
    Object.defineProperty(window.document, "hidden", { configurable: true, value: false });
    motion = new window.EventTarget();
    motion.matches = reducedMotion;
    colorScheme = new window.EventTarget();
    colorScheme.matches = systemLight;
    if (pageTheme === "auto") delete window.document.documentElement.dataset.theme;
    else window.document.documentElement.dataset.theme = pageTheme;
    window.localStorage.setItem("pi-web-theme", pageTheme);
    const matchMedia = window.matchMedia.bind(window);
    window.matchMedia = (query) => query === "(prefers-reduced-motion: reduce)" ? motion
      : query === "(prefers-color-scheme: light)" ? colorScheme : matchMedia(query);
    if (runScript) window.eval(siteScript);
  }

  afterEach(() => {
    window?.close();
    vi.useRealTimers();
  });

  it("keeps one dimensioned static desktop image available without JavaScript", () => {
    openPage({ runScript: false });
    const image = query("[data-demo-gallery] img");
    expect(image.getAttribute("src")).toBe("assets/pi-web-desktop-pi-web-dark.png");
    expect([image.width, image.height]).toEqual([1440, 900]);
    expect(image.alt).toContain("PI WEB Dark");
    expect(query("[data-demo-controls]").hidden).toBe(true);
    expect(query("[data-demo-gallery]").querySelectorAll("img")).toHaveLength(1);
  });

  it.each([
    ["dark", "PI WEB Dark", "Graphite", "graphite"],
    ["light", "PI WEB Light", "Paper", "paper"],
  ])("rotates only the %s pair every three seconds", (pageTheme, first, second, asset) => {
    openPage({ pageTheme });
    expect(selected()).toBe(first);
    expect(query("[data-demo-controls]").hidden).toBe(false);
    expect([...window.document.querySelectorAll("[data-demo-dot]:not([hidden])")].map(dot => dot.dataset.demoTheme)).toEqual([first, second]);
    vi.advanceTimersByTime(2999);
    expect(selected()).toBe(first);
    vi.advanceTimersByTime(1);
    expect(selected()).toBe(second);
    expect(query("[data-demo-gallery] img").getAttribute("src")).toBe(`assets/pi-web-desktop-${asset}.png`);
    advance();
    expect(selected()).toBe(first);
    click("[data-demo-prev]");
    expect(selected()).toBe(second);
    click("[data-demo-next]");
    expect(selected()).toBe(first);
  });

  it.each([
    ["desktop", 1440, 900],
    ["tablet", 1024, 768],
    ["mobile", 390, 844],
  ])("selects %s screenshots and keeps rotating the matching pair", (device, width, height) => {
    openPage();
    query(`[data-demo-device="${device}"]`).focus();
    click(`[data-demo-device="${device}"]`);
    const image = query("[data-demo-gallery] img");
    const deviceButton = query('[data-demo-device][aria-pressed="true"]');
    expect(deviceButton.dataset.demoDevice).toBe(device);
    expect(deviceButton.getAttribute("aria-label").toLowerCase()).toBe(device);
    expect(deviceButton.title).toBe(deviceButton.getAttribute("aria-label"));
    expect(deviceButton.querySelector("svg").getAttribute("aria-hidden")).toBe("true");
    expect([image.width, image.height]).toEqual([width, height]);
    expect(image.getAttribute("src")).toBe(`assets/pi-web-${device}-pi-web-dark.png`);
    expect(image.alt).toContain(`PI WEB ${device} workspace`);
    expect(query("[data-demo-device-caption]").textContent.toLowerCase()).toContain(device);
    advance();
    expect(image.getAttribute("src")).toBe(`assets/pi-web-${device}-graphite.png`);
    click("[data-demo-colors]");
    expect(image.getAttribute("src")).toBe(`assets/pi-web-${device}-paper.png`);
    advance();
    expect(image.getAttribute("src")).toBe(`assets/pi-web-${device}-pi-web-light.png`);
  });

  it("preserves theme selection and explicit pause when switching devices", () => {
    openPage();
    click('[data-demo-dot="graphite"]');
    click("[data-demo-rotation]");
    click('[data-demo-device="mobile"]');
    advance();
    expect(query("[data-demo-gallery] img").getAttribute("src")).toBe("assets/pi-web-mobile-graphite.png");
    click('[data-demo-device="tablet"]');
    advance();
    expect(query("[data-demo-gallery] img").getAttribute("src")).toBe("assets/pi-web-tablet-graphite.png");
    click("[data-demo-lightbox-trigger]");
    expect(query("[data-demo-lightbox-image]").getAttribute("src")).toContain("pi-web-tablet-graphite.png");
    expect(query("[data-demo-lightbox-caption]").textContent).toContain("Tablet");
  });

  it("inverts screenshot colors without changing the page, selected variant, or pause", () => {
    openPage();
    click("[data-demo-rotation]");
    click('[data-demo-dot="graphite"]');
    click("[data-demo-colors]");
    expect(selected()).toBe("Paper");
    expect(query("[data-demo-colors]").getAttribute("aria-label")).toBe("Show dark screenshots");
    expect(window.document.documentElement.dataset.theme).toBe("dark");
    advance();
    expect(selected()).toBe("Paper");
    click("[data-demo-colors]");
    expect(selected()).toBe("Graphite");
    expect(query("[data-demo-colors]").getAttribute("aria-label")).toBe("Show light screenshots");
  });

  it("follows system and page theme changes while preserving inversion", async () => {
    openPage({ pageTheme: "auto", systemLight: true });
    expect(selected()).toBe("PI WEB Light");
    colorScheme.matches = false;
    colorScheme.dispatchEvent(new window.Event("change"));
    expect(selected()).toBe("PI WEB Dark");
    click("[data-demo-colors]");
    expect(selected()).toBe("PI WEB Light");
    window.document.documentElement.dataset.theme = "light";
    await window.happyDOM.whenAsyncComplete();
    expect(selected()).toBe("PI WEB Dark");
    colorScheme.matches = true;
    colorScheme.dispatchEvent(new window.Event("change"));
    expect(selected()).toBe("PI WEB Dark");
  });

  it("preserves explicit pause through hover and visibility changes until resumed", () => {
    openPage();
    click("[data-demo-rotation]");
    expect(query("[data-demo-rotation]").getAttribute("aria-label")).toBe("Resume rotation");
    expect(query("[data-demo-rotation]").dataset.paused).toBe("true");
    query("[data-demo-gallery]").dispatchEvent(new window.Event("mouseenter"));
    query("[data-demo-gallery]").dispatchEvent(new window.Event("mouseleave"));
    window.document.dispatchEvent(new window.Event("visibilitychange"));
    advance();
    expect(selected()).toBe("PI WEB Dark");
    click("[data-demo-rotation]");
    expect(query("[data-demo-rotation]").getAttribute("aria-label")).toBe("Pause rotation");
    expect(query("[data-demo-rotation]").dataset.paused).toBe("false");
    advance();
    expect(selected()).toBe("Graphite");
  });

  it("pauses while the image is hovered or focused, or the page is hidden and restarts with a full interval", async () => {
    openPage();
    const gallery = query("[data-demo-gallery]");
    gallery.dispatchEvent(new window.Event("mouseenter"));
    advance();
    expect(selected()).toBe("PI WEB Dark");
    gallery.dispatchEvent(new window.Event("mouseleave"));
    query("[data-demo-lightbox-trigger]").focus();
    advance();
    expect(selected()).toBe("PI WEB Dark");
    query("[data-demo-lightbox-trigger]").blur();
    await Promise.resolve();
    advance();
    expect(selected()).toBe("Graphite");
    Object.defineProperty(window.document, "hidden", { configurable: true, value: true });
    window.document.dispatchEvent(new window.Event("visibilitychange"));
    advance();
    expect(selected()).toBe("Graphite");
    Object.defineProperty(window.document, "hidden", { configurable: true, value: false });
    window.document.dispatchEvent(new window.Event("visibilitychange"));
    vi.advanceTimersByTime(2999);
    expect(selected()).toBe("Graphite");
    vi.advanceTimersByTime(1);
    expect(selected()).toBe("PI WEB Dark");
  });

  it("keeps rotating while the color toggle is hovered and focused, including after resume", () => {
    openPage();
    query("[data-demo-colors]").dispatchEvent(new window.Event("mouseenter"));
    query("[data-demo-colors]").focus();
    click("[data-demo-colors]");
    expect(selected()).toBe("PI WEB Light");
    advance();
    expect(selected()).toBe("Paper");
    click("[data-demo-rotation]");
    advance();
    expect(selected()).toBe("Paper");
    query("[data-demo-rotation]").focus();
    click("[data-demo-rotation]");
    advance();
    expect(selected()).toBe("PI WEB Light");
  });

  it("defaults to paused for reduced motion and allows an explicit resume", () => {
    openPage({ reducedMotion: true });
    expect(query("[data-demo-rotation]").getAttribute("aria-label")).toBe("Resume rotation");
    advance();
    expect(selected()).toBe("PI WEB Dark");
    click("[data-demo-colors]");
    click('[data-demo-dot="paper"]');
    expect(selected()).toBe("Paper");
    click("[data-demo-rotation]");
    advance();
    expect(selected()).toBe("PI WEB Light");
    motion.dispatchEvent(new window.Event("change"));
    advance();
    expect(selected()).toBe("PI WEB Light");
    expect(query("[data-demo-rotation]").getAttribute("aria-label")).toBe("Resume rotation");
  });

  it("keeps the lightbox on the opened theme and returns focus on close", () => {
    openPage();
    click("[data-demo-colors]");
    click('[data-demo-dot="paper"]');
    click("[data-demo-lightbox-trigger]");
    const dialog = query("[data-demo-lightbox]");
    const preview = query("[data-demo-lightbox-image]");
    const source = preview.src;
    expect(dialog.open).toBe(true);
    expect(preview.alt).toContain("Paper theme");
    expect(query("[data-demo-lightbox-caption]").textContent).toContain("Paper");
    // Even if focus leaves the carousel, an open lightbox blocks rotation.
    window.document.activeElement.blur();
    advance();
    expect(selected()).toBe("Paper");
    expect(preview.src).toBe(source);
    click("[data-demo-lightbox-close]");
    expect(dialog.open).toBe(false);
    expect(window.document.activeElement).toBe(query("[data-demo-lightbox-trigger]"));
    advance();
    expect(selected()).toBe("Paper");
  });
});

describe("PI WEB docs homepage intro", () => {
  it("finishes every intro animation as soon as the page scrolls", () => {
    const window = createAnimatedHomePage();
    try {
      expect(animationState(window, ".site-header")).toMatchObject({ opacity: "0" });

      window.dispatchEvent(new window.Event("scroll"));

      expect(window.document.body.classList.contains("intro-skipped")).toBe(true);
      expect(animationState(window, ".site-header")).toMatchObject({ animation: "none", opacity: "1" });
      expect(animationState(window, ".intro-word")).toEqual({ animation: "none", opacity: "1", transform: "none" });
      expect(animationState(window, "main > .section")).toMatchObject({ animation: "none", opacity: "1" });
    } finally {
      window.close();
    }
  });

  it("shows the full page immediately when the browser restores a scroll position", () => {
    const window = createAnimatedHomePage(120);
    try {
      expect(window.document.body.classList.contains("intro-skipped")).toBe(true);
      expect(animationState(window, ".intro-word")).toEqual({ animation: "none", opacity: "1", transform: "none" });
    } finally {
      window.close();
    }
  });
});
