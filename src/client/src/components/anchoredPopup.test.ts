// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { LitElement, html } from "lit";
import { AnchoredPopupController, anchoredPopupStyle } from "./anchoredPopup";
import { installNativeDialogFake } from "./nativeDialog.testSupport";
installNativeDialogFake();
import { installPopoverFake } from "./anchoredPopup.testSupport";

installPopoverFake();
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

class PopupFixture extends LitElement {
  open = false;
  closed = vi.fn(() => { this.open = false; this.requestUpdate(); });
  readonly popup = new AnchoredPopupController(this, () => {
    const anchor = this.renderRoot.querySelector<HTMLElement>("button");
    const panel = this.renderRoot.querySelector<HTMLElement>("[popover]");
    return this.open && anchor && panel ? { anchor, panel, onClose: this.closed } : undefined;
  });
  override render() { return html`<button @click=${() => { this.open = !this.open; this.requestUpdate(); }}>Actions</button>${this.open ? html`<div popover="auto"><button>Copy</button></div>` : null}`; }
}
customElements.define("test-anchored-popup", PopupFixture);

async function mount() {
  const host = new PopupFixture(); document.body.append(host); await host.updateComplete;
  const trigger = host.shadowRoot?.querySelector("button");
  if (!trigger) throw new Error("Missing trigger");
  trigger.click(); await host.updateComplete;
  const panel = host.shadowRoot?.querySelector<HTMLElement>("[popover]");
  if (!panel) throw new Error("Missing popup");
  return { host, trigger, panel };
}

describe("anchored transient popup", () => {
  it("keeps the native panel in its themed root and reconciles native dismissal once", async () => {
    const { host, panel } = await mount();
    expect(panel.getRootNode()).toBe(host.shadowRoot);
    expect(panel.getAttribute("popover")).toBe("auto");
    panel.hidePopover(); await host.updateComplete;
    expect(host.closed).toHaveBeenCalledOnce();
    expect(host.shadowRoot?.querySelector("[popover]")).toBeNull();
  });

  it("clears consumer state on disconnect instead of reopening on reconnect", async () => {
    const { host } = await mount();
    host.remove();
    expect(host.closed).toHaveBeenCalledOnce();
    document.body.append(host);
    await host.updateComplete;
    expect(host.shadowRoot?.querySelector("[popover]")).toBeNull();
  });

  it("closes background popups when modality changes and refuses reopening behind it", async () => {
    const { host, trigger } = await mount();
    const modal = document.createElement("dialog"); document.body.append(modal);
    modal.showModal();
    try {
      await Promise.resolve();
      await host.updateComplete;
      expect(host.closed).toHaveBeenCalledOnce();
      trigger.click(); await host.updateComplete; await host.updateComplete;
      expect(host.shadowRoot?.querySelector("[popover]")).toBeNull();
      expect(host.closed).toHaveBeenCalledTimes(2);
    } finally { modal.close(); }
  });

  it("allows popup ownership within the current modal", async () => {
    const modal = document.createElement("dialog"); document.body.append(modal);
    const host = new PopupFixture(); modal.append(host); await host.updateComplete;
    modal.showModal();
    try {
      host.shadowRoot?.querySelector("button")?.click(); await host.updateComplete;
      expect(host.shadowRoot?.querySelector("[popover]")).not.toBeNull();
      expect(host.closed).not.toHaveBeenCalled();
    } finally { modal.close(); }
  });

  it("consumes Escape before ancestor shortcuts and restores trigger focus", async () => {
    const { host, trigger, panel } = await mount();
    const ancestor = vi.fn(); host.addEventListener("keydown", ancestor);
    panel.querySelector("button")?.focus();
    panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true, cancelable: true }));
    await host.updateComplete;
    expect(host.closed).toHaveBeenCalledOnce();
    expect(ancestor).not.toHaveBeenCalled();
    expect(host.shadowRoot?.activeElement).toBe(trigger);
  });

  it("flips above the visible keyboard and clamps offscreen anchors", () => {
    vi.stubGlobal("visualViewport", { offsetLeft: 0, offsetTop: 50, width: 400, height: 350 });
    const anchor = document.createElement("button");
    const measure = vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue(new DOMRect(354, 300, 36, 36));
    expect(anchoredPopupStyle(anchor)).toMatchObject({ bottom: `${String(window.innerHeight - 300)}px`, "max-height": "250px", right: `${String(window.innerWidth - 390)}px`, "max-width": "390px" });
    measure.mockReturnValue(new DOMRect(354, 700, 36, 36));
    expect(anchoredPopupStyle(anchor)["max-height"]).toBe("350px");
  });

  it("shares start, completion and left-strip sizing options", () => {
    const anchor = document.createElement("button");
    vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 300, 200, 30));
    expect(anchoredPopupStyle(anchor, { placement: "above-start", width: "anchor", gap: 6, maxHeight: 260 })).toMatchObject({ left: "100px", width: "200px", "max-height": "260px" });
    expect(anchoredPopupStyle(anchor, { placement: "left-end", padding: 8 })).toMatchObject({ "max-width": "92px", right: `${String(window.innerWidth - 100)}px` });
    expect(anchoredPopupStyle(anchor, { placement: "below-start", width: 280, padding: 8 })["width"]).toBe("280px");
  });
});
