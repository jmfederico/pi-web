import { readFileSync } from "node:fs";
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
