// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandPicker } from "./CommandPicker";
import { ModelPicker } from "./ModelPicker";
import { pressKey, pressNativeButtonEnter, requiredElement, settleRenderedDialog } from "./modalSurfaceTestSupport";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
});

function root(picker: CommandPicker | ModelPicker): ShadowRoot {
  const shadow = picker.shadowRoot;
  if (!shadow) throw new Error("Expected picker shadow root");
  return shadow;
}

for (const Picker of [CommandPicker, ModelPicker]) {
  describe(`${Picker.name} default pins`, () => {
    async function mount(onSetDefault?: (value: string) => Promise<unknown>) {
      const picker = new Picker();
      picker.options = [{ value: "p/a", label: "Alpha" }, { value: "p/b", label: "Beta" }];
      picker.defaultValue = "p/a";
      if (onSetDefault) picker.onSetDefault = onSetDefault;
      picker.onPick = vi.fn();
      document.body.append(picker);
      await settleRenderedDialog(picker);
      return picker;
    }

    function pins(picker: CommandPicker | ModelPicker) {
      return [...root(picker).querySelectorAll<HTMLButtonElement>(".default-pin")];
    }

    it("leaves the generic list unchanged without a callback", async () => {
      const picker = await mount();
      expect(pins(picker)).toHaveLength(0);
      expect(root(picker).querySelector(".default-help")).toBeNull();
      expect(root(picker).querySelectorAll(".options > button")).toHaveLength(2);
    });

    it("shows one heading and icon-only controlled pins separate from picking", async () => {
      const save = vi.fn().mockResolvedValue(undefined);
      const picker = await mount(save);
      const first = requiredElement(pins(picker)[0], "first pin");
      const second = requiredElement(pins(picker)[1], "second pin");
      expect(root(picker).querySelectorAll(".default-help strong")).toHaveLength(1);
      expect(requiredElement(root(picker).querySelector(".default-help"), "help").textContent).toBe("New session default");
      expect(requiredElement(root(picker).querySelector(".options"), "options").textContent).not.toContain("Default");
      expect(root(picker).querySelector("button button")).toBeNull();
      expect(first.textContent.trim()).toBe("");
      expect(first.getAttribute("aria-pressed")).toBe("true");
      expect(requiredElement(first.querySelector("svg"), "pin icon").getAttribute("fill")).toBe("currentColor");
      expect(second.getAttribute("aria-pressed")).toBe("false");
      expect(requiredElement(second.querySelector("svg"), "default star").getAttribute("fill")).toBe("none");
      expect(second.title).toBe("Use Beta as default for new sessions");
      expect(second.getAttribute("aria-label")).toBe(second.title);
      second.click();
      await settleRenderedDialog(picker);
      expect(save).toHaveBeenCalledExactlyOnceWith("p/b");
      expect(picker.onPick).not.toHaveBeenCalled();
      expect(second.getAttribute("aria-pressed")).toBe("false");
      picker.defaultValue = "p/b";
      await settleRenderedDialog(picker);
      expect(second.getAttribute("aria-pressed")).toBe("true");
      requiredElement(root(picker).querySelector<HTMLButtonElement>(".default-row > button:not(.default-pin)"), "pick").click();
      expect(picker.onPick).toHaveBeenCalledExactlyOnceWith("p/a");
      expect(save).toHaveBeenCalledTimes(1);
    });

    it("blocks duplicate saves while pending and loading, and recovers after rejection", async () => {
      let reject!: (reason: Error) => void;
      const save = vi.fn(() => new Promise<unknown>((_resolve, fail) => { reject = fail; }));
      const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const picker = await mount(save);
      requiredElement(pins(picker)[1], "pin").click();
      requiredElement(pins(picker)[0], "pin").click();
      await settleRenderedDialog(picker);
      expect(pins(picker).every((pin) => pin.disabled)).toBe(true);
      expect(save).toHaveBeenCalledTimes(1);
      reject(new Error("host failure"));
      await settleRenderedDialog(picker);
      expect(pins(picker).every((pin) => !pin.disabled)).toBe(true);
      expect(warning).toHaveBeenCalledOnce();
      expect(requiredElement(pins(picker)[0], "pin").getAttribute("aria-pressed")).toBe("true");
      picker.defaultsLoading = true;
      await settleRenderedDialog(picker);
      requiredElement(pins(picker)[1], "pin").click();
      expect(pins(picker).every((pin) => pin.disabled)).toBe(true);
      expect(save).toHaveBeenCalledTimes(1);
    });

    it("preserves native pin Enter/Space without invoking row keyboard picking", async () => {
      const save = vi.fn().mockResolvedValue(undefined);
      const picker = await mount(save);
      const pin = requiredElement(pins(picker)[1], "pin");
      pin.focus();
      expect(pressNativeButtonEnter(pin).defaultPrevented).toBe(false);
      await settleRenderedDialog(picker);
      // happy-dom does not synthesize the native Space click default.
      expect(pressKey(pin, " ").defaultPrevented).toBe(false);
      pin.click();
      await settleRenderedDialog(picker);
      expect(save).toHaveBeenCalledTimes(2);
      expect(picker.onPick).not.toHaveBeenCalled();
    });
  });
}

it("shows model pins in both modes and disables unavailable models without toggling membership", async () => {
  const picker = new ModelPicker();
  picker.options = [{ value: "p/a", label: "Alpha" }];
  picker.catalog = [
    { provider: "p", id: "a", enabled: true },
    { provider: "p", id: "b", enabled: false },
  ];
  picker.defaultValue = "p/a";
  picker.onSetDefault = vi.fn().mockResolvedValue(undefined);
  picker.onPick = vi.fn();
  picker.onToggleEnabled = vi.fn();
  document.body.append(picker);
  await settleRenderedDialog(picker);
  expect(root(picker).querySelectorAll(".default-pin")).toHaveLength(1);
  const all = requiredElement([...root(picker).querySelectorAll<HTMLButtonElement>(".scope-toggle button")].find((button) => button.textContent === "All models"), "All models");
  all.click();
  await settleRenderedDialog(picker);
  const pins = [...root(picker).querySelectorAll<HTMLButtonElement>(".default-pin")];
  expect(pins).toHaveLength(2);
  expect(requiredElement(pins[0], "pin").getAttribute("aria-pressed")).toBe("true");
  expect(requiredElement(pins[1], "pin").disabled).toBe(true);
  requiredElement(pins[1], "pin").click();
  expect(picker.onSetDefault).not.toHaveBeenCalled();
  requiredElement(pins[0], "pin").click();
  await settleRenderedDialog(picker);
  expect(picker.onSetDefault).toHaveBeenCalledExactlyOnceWith("p/a");
  expect(picker.onToggleEnabled).not.toHaveBeenCalled();
  expect(picker.onPick).not.toHaveBeenCalled();
  expect(root(picker).querySelector("button button")).toBeNull();
});
