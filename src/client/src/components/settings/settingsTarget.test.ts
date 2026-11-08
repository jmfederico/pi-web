// @vitest-environment happy-dom

import { html, LitElement } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import { ModalSurface } from "../ModalSurface";
import { deepActiveElement } from "../modalLayerRegistry";
import { installNativeDialogFake } from "../nativeDialog.testSupport";
import { revealSettingsTarget } from "./settingsTarget";

installNativeDialogFake();

class TargetPanel extends LitElement {
  destination = "uploads";
  locked = false;
  override render() {
    return html`<section data-settings-target=${this.destination} tabindex="-1">
      <input aria-label="Upload folder" ?disabled=${this.locked}>
    </section>`;
  }
}
customElements.define("settings-target-test-panel", TargetPanel);

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it.each(["uploads", 'appearance["custom"]'])("reveals the named target %s across shadow roots after its panel renders", async (name) => {
  const panel = new TargetPanel();
  panel.destination = name;
  const outer = document.createElement("div");
  outer.attachShadow({ mode: "open" }).append(panel);
  document.body.append(outer);
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView");

  expect(await revealSettingsTarget(document.body, name, () => true)).toBe(true);
  expect(deepActiveElement(document)).toBe(panel.shadowRoot?.querySelector("input"));
  expect(scroll).toHaveBeenCalledOnce();
});

it("focuses a locked subsection instead of its disabled control", async () => {
  const panel = new TargetPanel();
  panel.locked = true;
  document.body.append(panel);

  expect(await revealSettingsTarget(document.body, "uploads", () => true)).toBe(true);
  expect(deepActiveElement(document)).toBe(panel.shadowRoot?.querySelector("section"));
});

it.each(["missing", "cancelled", "disconnected"])("leaves existing focus alone for a %s destination", async (state) => {
  const panel = new TargetPanel();
  const previous = document.createElement("button");
  document.body.append(previous, panel);
  previous.focus();
  const pending = revealSettingsTarget(document.body, state === "missing" ? "absent" : "uploads", () => state !== "cancelled");
  if (state === "disconnected") panel.remove();

  expect(await pending).toBe(false);
  expect(deepActiveElement(document)).toBe(previous);
});

it("does not steal focus from a newer modal", async () => {
  const lower = new ModalSurface();
  lower.append(new TargetPanel());
  document.body.append(lower);
  await lower.updateComplete;
  const upper = new ModalSurface();
  upper.initialFocus = "input";
  const input = document.createElement("input");
  upper.append(input);
  document.body.append(upper);
  await upper.updateComplete;

  expect(await revealSettingsTarget(lower, "uploads", () => true)).toBe(false);
  expect(deepActiveElement(document)).toBe(input);
});
