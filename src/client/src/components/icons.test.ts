// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { html, render } from "lit";
import { renderAttachIcon, renderSendIcon, renderQueueIcon, renderSteerIcon, renderStopIcon, renderThinkingGauge } from "./promptEditorIcons";
import { renderAppTabIcon, renderBuiltinTabIcon, renderNavigationMenuIcon } from "./tabIcons";
import { renderSessionWarningIcon } from "./shared";
import { defaultPin } from "./DefaultPin";

let host: HTMLDivElement;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); });
afterEach(() => { document.body.replaceChildren(); });

describe("standard UI icons", () => {
  it("preserves plugin-supplied icons", () => {
    render(renderAppTabIcon(html`<span data-plugin-icon>Plugin</span>`), host);
    expect(host.querySelector("[data-plugin-icon]")?.textContent).toBe("Plugin");
    expect(host.querySelector(".tab-custom-icon")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("renders decorative, theme-colored Heroicons outlines without external resources", () => {
    const icons = [renderAttachIcon(), renderSendIcon(), renderQueueIcon(), renderSteerIcon(), renderStopIcon(),
      renderBuiltinTabIcon("chat"), renderBuiltinTabIcon("navigation"), renderNavigationMenuIcon(),
      renderSessionWarningIcon("info", "warning"), renderSessionWarningIcon("warning", "warning"), renderSessionWarningIcon("error", "warning")];
    render(icons, host);
    const nodes = document.body.querySelectorAll("svg");
    expect(nodes).toHaveLength(icons.length);
    for (const icon of nodes) {
      expect(icon.namespaceURI).toBe("http://www.w3.org/2000/svg");
      expect(icon.getAttribute("viewBox")).toBe("0 0 24 24");
      expect(icon.getAttribute("stroke-width")).toBe("1.5");
      expect(icon.getAttribute("stroke")).toBe("currentColor");
      expect(icon.getAttribute("aria-hidden")).toBe("true");
      expect(icon.getAttribute("focusable")).toBe("false");
      expect(icon.querySelector("path")?.getAttribute("d")).toBeTruthy();
    }
    expect(document.body.querySelector("img, use, script")).toBeNull();
  });

  it("preserves default selection, labels, disabled state and click behavior", () => {
    const click = vi.fn();
    render(defaultPin("Model", true, false, click), host);
    const button = document.body.querySelector("button");
    expect(button?.getAttribute("aria-label")).toBe("Use Model as default for new sessions");
    expect(button?.getAttribute("aria-pressed")).toBe("true");
    expect(button?.querySelector("svg")?.getAttribute("fill")).toBe("currentColor");
    button?.click();
    expect(click).toHaveBeenCalledOnce();
    render(defaultPin("Model", false, true, click), host);
    expect(button?.disabled).toBe(true);
    expect(button?.getAttribute("aria-pressed")).toBe("false");
    expect(button?.querySelector("svg")?.getAttribute("fill")).toBe("none");
    button?.click();
    expect(click).toHaveBeenCalledOnce();
  });

  it("retains the dynamic thinking gauge instead of replacing it with a static icon", () => {
    render(renderThinkingGauge({ total: 6, filled: 4 }), host);
    expect(document.body.querySelectorAll(".gauge-bar")).toHaveLength(6);
    expect(document.body.querySelectorAll(".gauge-bar-active")).toHaveLength(4);
  });
});
