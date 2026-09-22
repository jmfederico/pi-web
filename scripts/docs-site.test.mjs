import { existsSync, readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

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

  it("keeps local links and copy targets valid in config.html", () => {
    const page = "config.html";
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
