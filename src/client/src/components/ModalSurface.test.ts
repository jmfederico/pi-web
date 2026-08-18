// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { ModalSurface } from "./ModalSurface";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

describe("modal-surface rendering", () => {
  it("renders a self-contained accessible name around slotted content", async () => {
    const surface = await mountSurface({
      content: `<h1 id="greeting">Hello</h1>`,
      configure: (element) => { element.label = "Greeting dialog"; },
    });
    const section = dialogSection(surface);

    expect(section.getAttribute("aria-modal")).toBe("true");
    expect(section.getAttribute("aria-hidden")).toBeNull();
    expect(section.getAttribute("aria-busy")).toBe("false");
    expect(section.getAttribute("aria-label")).toBe("Greeting dialog");
    expect(section.getAttribute("aria-labelledby")).toBeNull();
    expect(section.tabIndex).toBe(-1);
    const slot = section.querySelector("slot");
    if (!(slot instanceof HTMLSlotElement)) throw new Error("modal-surface did not render its content slot");
    expect(slot.assignedElements().map((element) => element.id)).toEqual(["greeting"]);
  });
});

describe("modal-surface initial focus", () => {
  it("focuses the designated initial target when opened", async () => {
    const surface = await mountSurface({
      content: `<button>First</button><input aria-label="Query">`,
      configure: (element) => { element.initialFocus = "input"; },
    });

    expect(document.activeElement).toBe(surface.querySelector("input"));
  });

  it("focuses the dialog section when no initial target is set", async () => {
    const surface = await mountSurface({ content: `<button>Only</button>` });

    expect(surface.shadowRoot?.activeElement).toBe(dialogSection(surface));
  });

  it("falls back to the section when the initial-focus selector matches nothing", async () => {
    const surface = await mountSurface({
      content: `<button>Only</button>`,
      configure: (element) => { element.initialFocus = "textarea"; },
    });

    expect(surface.shadowRoot?.activeElement).toBe(dialogSection(surface));
  });

  it("falls back to the section when the initial-focus selector is invalid", async () => {
    const surface = await mountSurface({
      content: `<button>Only</button>`,
      configure: (element) => { element.initialFocus = "input["; },
    });

    expect(surface.shadowRoot?.activeElement).toBe(dialogSection(surface));
  });
});

describe("modal-surface refocus on request", () => {
  it("moves focus back to the dialog section when asked", async () => {
    const surface = await mountSurface({ content: `<button>Inside</button>` });
    const outside = appendFocusTarget("Outside");
    outside.focus();
    expect(document.activeElement).toBe(outside);

    surface.focusDialog();

    expect(surface.shadowRoot?.activeElement).toBe(dialogSection(surface));
  });

  it("moves focus to the designated initial target when one is set", async () => {
    const surface = await mountSurface({
      content: `<input aria-label="Query">`,
      configure: (element) => { element.initialFocus = "input"; },
    });
    const outside = appendFocusTarget("Outside");
    outside.focus();

    surface.focusDialog();

    expect(document.activeElement).toBe(surface.querySelector("input"));
  });
});

describe("modal-surface close contract", () => {
  it("routes Escape to the close callback without leaking the key", async () => {
    const onClose = vi.fn<() => void>();
    const surface = await mountSurface({
      content: `<button>Inside</button>`,
      configure: (element) => { element.onClose = onClose; },
    });
    const bodySpy = vi.fn();
    document.body.addEventListener("keydown", bodySpy);

    const event = pressKey(contentButton(surface), "Escape");

    expect(onClose).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
    expect(bodySpy).not.toHaveBeenCalled();
  });

  it("routes Escape to the busy callback instead of closing while busy", async () => {
    const onClose = vi.fn<() => void>();
    const onBusyEscape = vi.fn<() => void>();
    const surface = await mountSurface({
      content: `<button>Inside</button>`,
      configure: (element) => {
        element.onClose = onClose;
        element.onBusyEscape = onBusyEscape;
        element.busy = true;
      },
    });

    const event = pressKey(contentButton(surface), "Escape");

    expect(onClose).not.toHaveBeenCalled();
    expect(onBusyEscape).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
    expect(dialogSection(surface).getAttribute("aria-busy")).toBe("true");
  });

  it("swallows Escape while busy when no busy callback is set", async () => {
    const onClose = vi.fn<() => void>();
    const surface = await mountSurface({
      content: `<button>Inside</button>`,
      configure: (element) => {
        element.onClose = onClose;
        element.busy = true;
      },
    });

    const event = pressKey(contentButton(surface), "Escape");

    expect(onClose).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it("closes when the backdrop itself is pressed, but not while busy", async () => {
    const onClose = vi.fn<() => void>();
    const surface = await mountSurface({
      content: `<button>Inside</button>`,
      configure: (element) => { element.onClose = onClose; },
    });

    backdrop(surface).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, composed: true }));
    expect(onClose).toHaveBeenCalledOnce();

    surface.busy = true;
    await surface.updateComplete;
    backdrop(surface).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, composed: true }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("ignores presses that start on dialog content or the section frame", async () => {
    const onClose = vi.fn<() => void>();
    const surface = await mountSurface({
      content: `<button>Inside</button>`,
      configure: (element) => { element.onClose = onClose; },
    });

    contentButton(surface).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, composed: true }));
    dialogSection(surface).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, composed: true }));

    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("modal-surface Tab trap", () => {
  it("enters the focus cycle from the dialog section in both directions", async () => {
    const surface = await mountTrapSurface();
    const section = dialogSection(surface);
    expect(surface.shadowRoot?.activeElement).toBe(section);

    // happy-dom does not propagate events out of shadow roots, so key presses
    // that would bubble from the section to the host in a browser are
    // dispatched on the host itself; the handler is event-target agnostic.
    pressKey(surface, "Tab");
    expect(document.activeElement).toBe(surface.querySelector("#one"));

    section.focus();
    pressKey(surface, "Tab", { shift: true });
    expect(document.activeElement).toBe(surface.querySelector("#three"));
  });

  it("wraps Tab from the last control and Shift+Tab from the first", async () => {
    const surface = await mountTrapSurface();
    const one = requiredElement(surface.querySelector<HTMLButtonElement>("#one"), "first trap button");
    const three = requiredElement(surface.querySelector<HTMLButtonElement>("#three"), "last trap button");

    three.focus();
    const forward = pressKey(three, "Tab");
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(one);

    one.focus();
    const backward = pressKey(one, "Tab", { shift: true });
    expect(backward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(three);
  });

  it("leaves mid-cycle Tab presses to the browser", async () => {
    const surface = await mountTrapSurface();
    const one = requiredElement(surface.querySelector<HTMLButtonElement>("#one"), "first trap button");

    one.focus();
    const event = pressKey(one, "Tab");

    expect(event.defaultPrevented).toBe(false);
  });

  it("excludes controls hidden by themselves or a composed ancestor", async () => {
    const surface = await mountSurface({
      content: `
        <button id="visible-first">First</button>
        <button id="visible-last">Last</button>
        <button hidden>Hidden control</button>
        <div inert><button>Inert control</button></div>
        <div style="display: none"><button>Display-none control</button></div>
      `,
    });
    const first = requiredElement(surface.querySelector<HTMLButtonElement>("#visible-first"), "first visible button");
    const last = requiredElement(surface.querySelector<HTMLButtonElement>("#visible-last"), "last visible button");

    last.focus();
    pressKey(last, "Tab");
    expect(document.activeElement).toBe(first);

    first.focus();
    pressKey(first, "Tab", { shift: true });
    expect(document.activeElement).toBe(last);
  });

  it("keeps focus on the section when the dialog has no focusable controls", async () => {
    const surface = await mountSurface({ content: `<p>Nothing to focus</p>` });
    const section = dialogSection(surface);

    const event = pressKey(surface, "Tab");

    expect(event.defaultPrevented).toBe(true);
    expect(surface.shadowRoot?.activeElement).toBe(section);
  });
});

describe("modal-surface radio group Tab stops", () => {
  it("wraps Tab from a trailing checked radio group instead of leaking out of the dialog", async () => {
    // The reported path: the Keyboard settings panel while loading, where the
    // panel action is disabled and the Enter-key preference group is the
    // dialog's last Tab stop.
    const surface = await mountRadioGroupSurface({ checkedOption: "send" });
    const send = radioOption(surface, "send");
    const stay = requiredElement(surface.querySelector<HTMLButtonElement>("#stay"), "enabled control");

    send.focus();
    const forward = pressKey(send, "Tab");

    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(stay);
  });

  it("keeps the checked member's own position as the group's stop", async () => {
    const surface = await mountRadioGroupSurface({ checkedOption: "newline" });
    const newline = radioOption(surface, "newline");
    const stay = requiredElement(surface.querySelector<HTMLButtonElement>("#stay"), "enabled control");

    newline.focus();
    const forward = pressKey(newline, "Tab");
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(stay);

    stay.focus();
    const backward = pressKey(stay, "Tab", { shift: true });
    expect(backward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(newline);

    // The unchecked member is not a stop, so a Tab press from it re-enters the
    // cycle at its leading edge instead of counting as mid-cycle.
    const send = radioOption(surface, "send");
    send.focus();
    const fromUnchecked = pressKey(send, "Tab");
    expect(fromUnchecked.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(stay);
  });

  it("uses the first member as the group's stop when nothing is checked", async () => {
    const surface = await mountRadioGroupSurface({ checkedOption: "none" });
    const send = radioOption(surface, "send");
    const stay = requiredElement(surface.querySelector<HTMLButtonElement>("#stay"), "enabled control");

    send.focus();
    const forward = pressKey(send, "Tab");
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(stay);

    stay.focus();
    const backward = pressKey(stay, "Tab", { shift: true });
    expect(backward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(send);
  });

  it("collapses each named group separately, so the last group ends the cycle", async () => {
    const surface = await mountSurface({
      content: `
        <input id="first-group" type="radio" name="operation" checked>
        <input type="radio" name="operation">
        <input id="second-group" type="radio" name="summary" checked>
        <input type="radio" name="summary">
      `,
    });
    const firstGroup = requiredElement(surface.querySelector<HTMLInputElement>("#first-group"), "first group stop");
    const secondGroup = requiredElement(surface.querySelector<HTMLInputElement>("#second-group"), "second group stop");

    // The second group follows the first mid-cycle rather than the first
    // group's unchecked sibling.
    firstGroup.focus();
    const acrossGroups = pressKey(firstGroup, "Tab");
    expect(acrossGroups.defaultPrevented).toBe(false);

    // And the last group's checked member ends the cycle: its trailing
    // unchecked sibling is not a stop of its own.
    secondGroup.focus();
    const wrap = pressKey(secondGroup, "Tab");
    expect(wrap.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(firstGroup);
  });

  it("keeps unnamed radios as independent Tab stops", async () => {
    const surface = await mountSurface({
      content: `<input id="unnamed-one" type="radio"><input id="unnamed-two" type="radio">`,
    });
    const one = requiredElement(surface.querySelector<HTMLInputElement>("#unnamed-one"), "first unnamed radio");
    const two = requiredElement(surface.querySelector<HTMLInputElement>("#unnamed-two"), "second unnamed radio");

    one.focus();
    expect(pressKey(one, "Tab").defaultPrevented).toBe(false);

    two.focus();
    const wrap = pressKey(two, "Tab");
    expect(wrap.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(one);
  });
});

describe("modal-surface nested shadow content", () => {
  it("includes controls inside nested shadow roots in the Tab cycle", async () => {
    const surface = await mountSurface({
      content: `<button id="before">Before</button><modal-surface-test-nested></modal-surface-test-nested><button id="after">After</button>`,
    });
    const nestedButton = nestedFocusButton(surface);

    // The nested control is recognized mid-cycle, so its Tab press is left alone.
    nestedButton.focus();
    const midCycle = pressKey(surface, "Tab");
    expect(midCycle.defaultPrevented).toBe(false);

    // The cycle wraps across the shadow boundary: last is the plain trailing button.
    const after = requiredElement(surface.querySelector<HTMLButtonElement>("#after"), "trailing button");
    after.focus();
    pressKey(after, "Tab");
    expect(document.activeElement).toBe(surface.querySelector("#before"));

    // And Shift+Tab from the first control wraps to the trailing button,
    // proving the nested control sits between them in cycle order.
    const before = requiredElement(surface.querySelector<HTMLButtonElement>("#before"), "leading button");
    before.focus();
    pressKey(before, "Tab", { shift: true });
    expect(document.activeElement).toBe(after);
  });

  it("follows flattened slot order at both edges and skips negative-tabindex controls", async () => {
    const surface = await mountSurface({
      content: `
        <modal-surface-test-slotted>
          <button id="slotted-first">Slotted first</button>
          <button id="slotted-last">Slotted last</button>
          <button id="removed-from-tab-order" tabindex="-1">Programmatic only</button>
          <button tabindex="0" disabled>Disabled</button>
        </modal-surface-test-slotted>
      `,
    });
    const internalAction = nestedInternalAction(surface);
    const slottedLast = requiredElement(surface.querySelector<HTMLButtonElement>("#slotted-last"), "last slotted button");

    slottedLast.focus();
    const forward = pressKey(slottedLast, "Tab");
    expect(forward.defaultPrevented).toBe(true);
    expect(deepActiveElement()).toBe(internalAction);

    internalAction.focus();
    const backward = pressKey(surface, "Tab", { shift: true });
    expect(backward.defaultPrevented).toBe(true);
    expect(deepActiveElement()).toBe(slottedLast);
  });

  it("enters the Tab cycle directly into a nested shadow control", async () => {
    const surface = await mountSurface({ content: `<modal-surface-test-nested></modal-surface-test-nested>` });

    pressKey(surface, "Tab");

    expect(deepActiveElement()).toBe(nestedFocusButton(surface));
  });

  it("closes on Escape while a control inside nested shadow content holds focus", async () => {
    const onClose = vi.fn<() => void>();
    const surface = await mountSurface({
      content: `<modal-surface-test-nested></modal-surface-test-nested>`,
      configure: (element) => { element.onClose = onClose; },
    });

    nestedFocusButton(surface).focus();
    pressKey(surface, "Escape");

    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("modal-surface focus restoration", () => {
  it("restores focus to the previously focused element when removed", async () => {
    const trigger = appendFocusTarget("Open settings");
    trigger.focus();

    const surface = await mountSurface({ content: `<button>Inside</button>` });
    expect(document.activeElement).not.toBe(trigger);

    surface.remove();
    expect(document.activeElement).toBe(trigger);
  });

  it("skips focus restoration when the previously focused element is gone", async () => {
    const trigger = appendFocusTarget("Opener");
    trigger.focus();
    const surface = await mountSurface({ content: `<button>Inside</button>` });

    trigger.remove();
    surface.remove();

    expect(document.activeElement).not.toBe(trigger);
  });

  it("restores through a lower dialog removed while a newer dialog owns focus", async () => {
    const trigger = appendFocusTarget("Opener");
    trigger.focus();

    const first = await mountSurface({ content: `<button>First dialog</button>` });
    const second = await mountSurface({ content: `<button>Second dialog</button>` });
    expect(document.activeElement).toBe(second);

    first.remove();
    expect(document.activeElement).toBe(second);

    second.remove();
    expect(document.activeElement).toBe(trigger);
  });

  it("does not let a lower visual layer steal focus when it connects late", async () => {
    const trigger = appendFocusTarget("Opener");
    trigger.focus();
    const higher = await mountLayeredSurface(30, `<button id="higher-control">Higher dialog</button>`);
    const higherControl = requiredElement(higher.surface.querySelector<HTMLButtonElement>("#higher-control"), "higher-layer control");
    expect(document.activeElement).toBe(higher.host);
    expect(deepActiveElement()).toBe(higherControl);

    const lower = await mountLayeredSurface(10, `<button id="lower-control">Lower dialog</button>`);
    await higher.surface.updateComplete;

    expect(document.activeElement).toBe(higher.host);
    expect(dialogSection(higher.surface).getAttribute("aria-modal")).toBe("true");
    expect(dialogSection(lower.surface).getAttribute("aria-hidden")).toBe("true");
    higher.host.remove();
    await lower.surface.updateComplete;
    expect(deepActiveElement()).toBe(lower.surface.querySelector("#lower-control"));
    expect(dialogSection(lower.surface).getAttribute("aria-modal")).toBe("true");
    expect(dialogSection(lower.surface).getAttribute("aria-hidden")).toBeNull();

    lower.host.remove();
    expect(document.activeElement).toBe(trigger);
  });

  it("falls back inside a surviving lower dialog when its remembered control is disabled", async () => {
    const trigger = appendFocusTarget("Opener");
    trigger.focus();
    const lower = await mountSurface({
      content: `<button id="lower-control">Lower dialog</button>`,
      configure: (surface) => { surface.initialFocus = "button"; },
    });
    const lowerControl = requiredElement(lower.querySelector<HTMLButtonElement>("#lower-control"), "lower dialog control");
    const higher = await mountSurface({ content: `<button>Higher dialog</button>` });
    lowerControl.disabled = true;

    higher.remove();

    expect(lower.shadowRoot?.activeElement).toBe(dialogSection(lower));
    lower.remove();
    expect(document.activeElement).toBe(trigger);
  });
});

interface MountSurfaceOptions {
  content: string;
  configure?: (surface: ModalSurface) => void;
}

async function mountSurface(options: MountSurfaceOptions): Promise<ModalSurface> {
  const surface = new ModalSurface();
  options.configure?.(surface);
  surface.innerHTML = options.content;
  document.body.append(surface);
  await surface.updateComplete;
  return surface;
}

/**
 * Mirrors the reported Keyboard settings shape: a disabled panel action, one
 * enabled control, then a trailing named radio group rendered inside labels.
 */
async function mountRadioGroupSurface(options: { checkedOption: "send" | "newline" | "none" }): Promise<ModalSurface> {
  const surface = await mountSurface({
    content: `
      <button id="reload" disabled>Reload</button>
      <button id="stay">Stay</button>
      <div role="radiogroup" aria-label="Enter key behavior">
        <label><input id="option-send" type="radio" name="prompt-enter-preference"><span>Send</span></label>
        <label><input id="option-newline" type="radio" name="prompt-enter-preference"><span>Newline</span></label>
      </div>
    `,
  });
  if (options.checkedOption !== "none") radioOption(surface, options.checkedOption).checked = true;
  return surface;
}

function radioOption(surface: ModalSurface, option: "send" | "newline"): HTMLInputElement {
  return requiredElement(surface.querySelector<HTMLInputElement>(`#option-${option}`), `${option} radio option`);
}

async function mountTrapSurface(): Promise<ModalSurface> {
  return mountSurface({ content: `<button id="one">One</button><button id="two">Two</button><button id="three">Three</button>` });
}

async function mountLayeredSurface(zIndex: number, content: string): Promise<{ host: HTMLElement; surface: ModalSurface }> {
  const host = document.createElement("div");
  host.style.position = "fixed";
  host.style.zIndex = String(zIndex);
  const root = host.attachShadow({ mode: "open" });
  const surface = new ModalSurface();
  surface.initialFocus = "button";
  surface.innerHTML = content;
  root.append(surface);
  document.body.append(host);
  await surface.updateComplete;
  return { host, surface };
}

function dialogSection(surface: ModalSurface): HTMLElement {
  return requiredElement(surface.shadowRoot?.querySelector("section[role='dialog']"), "modal-surface dialog section");
}

function backdrop(surface: ModalSurface): HTMLElement {
  return requiredElement(surface.shadowRoot?.querySelector(".backdrop"), "modal-surface backdrop");
}

function contentButton(surface: ModalSurface): HTMLButtonElement {
  return requiredElement(surface.querySelector("button"), "content button");
}

function nestedFocusButton(surface: ModalSurface): HTMLButtonElement {
  const host = requiredElement(surface.querySelector("modal-surface-test-nested"), "nested focus host");
  return requiredElement(host.shadowRoot?.querySelector("button"), "nested shadow button");
}

function nestedInternalAction(surface: ModalSurface): HTMLButtonElement {
  const host = requiredElement(surface.querySelector("modal-surface-test-slotted"), "nested slotted host");
  return requiredElement(host.shadowRoot?.querySelector("button"), "nested internal action");
}

function appendFocusTarget(text: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.textContent = text;
  document.body.append(button);
  return button;
}

function pressKey(target: Element, key: string, options: { shift?: boolean } = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    composed: true,
    shiftKey: options.shift ?? false,
  });
  target.dispatchEvent(event);
  return event;
}

function deepActiveElement(): Element | null {
  let active: Element | null = document.activeElement;
  while (active instanceof HTMLElement && active.shadowRoot?.activeElement instanceof Element) {
    active = active.shadowRoot.activeElement;
  }
  // happy-dom reports activeElement as undefined when nothing is focused;
  // the runtime value is normalized even though the type says Element | null.
  return active ?? null;
}

function requiredElement<T extends Element>(element: T | null | undefined, description: string): T {
  if (element === null || element === undefined) throw new Error(`Expected ${description} to exist`);
  return element;
}

class ModalSurfaceTestNested extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    const button = document.createElement("button");
    button.id = "nested";
    button.textContent = "Nested";
    root.append(button);
  }
}

if (customElements.get("modal-surface-test-nested") === undefined) {
  customElements.define("modal-surface-test-nested", ModalSurfaceTestNested);
}

class ModalSurfaceTestSlotted extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    const actionSlot = document.createElement("slot");
    actionSlot.name = "actions";
    const action = document.createElement("button");
    action.id = "internal-action";
    action.textContent = "Internal action";
    actionSlot.append(action);
    root.append(actionSlot, document.createElement("slot"));
  }
}

if (customElements.get("modal-surface-test-slotted") === undefined) {
  customElements.define("modal-surface-test-slotted", ModalSurfaceTestSlotted);
}
