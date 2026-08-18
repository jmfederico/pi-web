// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppAction } from "../actions";
import { ActionPalette, filterActionPaletteActions } from "./ActionPalette";
import { deepActiveElement, dialogSection, dialogSurface, pressKey, pressNativeButtonEnter, requiredElement, settleRenderedDialog, surfaceBackdrop } from "./modalSurfaceTestSupport";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

describe("filterActionPaletteActions", () => {
  it("keeps disabled actions visible when they have an explanation", () => {
    const actions: AppAction[] = [
      action("enabled", "Enabled action"),
      action("hidden", "Disabled without reason", { enabled: false }),
      action("explained", "Disabled with reason", { enabled: false, disabledReason: "Update and restart the selected machine." }),
    ];

    expect(filterActionPaletteActions(actions, "").map((item) => item.id)).toEqual(["enabled", "explained"]);
  });

  it("matches disabled reasons in search", () => {
    const actions: AppAction[] = [
      action("cleanup", "Clean Up Sessions", { enabled: false, disabledReason: "Selected server does not support cleanup." }),
    ];

    expect(filterActionPaletteActions(actions, "support cleanup").map((item) => item.id)).toEqual(["cleanup"]);
  });
});

describe("action-palette modal surface", () => {
  it("focuses the search input when opened", async () => {
    const palette = await mountPalette();

    expect(deepActiveElement()).toBe(searchInput(palette));
    expect(dialogSection(palette).getAttribute("aria-label")).toBe("Action palette");
  });

  it("cancels on Escape", async () => {
    const onCancel = vi.fn<() => void>();
    const palette = await mountPalette({ onCancel });

    pressKey(dialogSurface(palette), "Escape");

    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("cancels when the backdrop itself is pressed", async () => {
    const onCancel = vi.fn<() => void>();
    const palette = await mountPalette({ onCancel });

    surfaceBackdrop(palette).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, composed: true }));

    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("keeps arrow navigation and runs the selected action on Enter", async () => {
    const onRun = vi.fn<(action: AppAction) => void>();
    const actions = [action("a", "Alpha"), action("b", "Beta"), action("c", "Gamma")];
    const palette = await mountPalette({ onRun, actions });
    expect(selectedActionIndex(palette)).toBe(0);

    pressKey(dialogSurface(palette), "ArrowDown");
    await settleRenderedDialog(palette);
    expect(selectedActionIndex(palette)).toBe(1);

    pressKey(dialogSurface(palette), "ArrowDown");
    await settleRenderedDialog(palette);
    expect(selectedActionIndex(palette)).toBe(2);

    pressKey(dialogSurface(palette), "ArrowDown");
    await settleRenderedDialog(palette);
    expect(selectedActionIndex(palette)).toBe(0);

    pressKey(dialogSurface(palette), "ArrowUp");
    await settleRenderedDialog(palette);
    expect(selectedActionIndex(palette)).toBe(2);

    pressKey(dialogSurface(palette), "Enter");

    expect(onRun).toHaveBeenCalledWith(actions[2]);
  });

  it("lets focused action and Close buttons keep their native Enter meanings", async () => {
    const onRun = vi.fn<(action: AppAction) => void>();
    const onCancel = vi.fn<() => void>();
    const actions = [action("a", "Alpha"), action("b", "Beta")];
    const palette = await mountPalette({ onRun, onCancel, actions });
    const secondAction = requiredElement(actionButtons(palette)[1], "second palette action");

    secondAction.focus();
    await settleRenderedDialog(palette);
    expect(selectedActionIndex(palette)).toBe(1);
    expect(secondAction.getAttribute("aria-current")).toBe("true");
    const actionEvent = pressNativeButtonEnter(secondAction);

    expect(actionEvent.defaultPrevented).toBe(false);
    expect(onRun).toHaveBeenCalledWith(actions[1]);

    const close = closeButton(palette);
    close.focus();
    const closeEvent = pressNativeButtonEnter(close);

    expect(closeEvent.defaultPrevented).toBe(false);
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onRun).toHaveBeenCalledTimes(1);
  });
});

interface ActionPaletteProps {
  actions?: AppAction[];
  onRun?: (action: AppAction) => void;
  onCancel?: () => void;
}

async function mountPalette(props: ActionPaletteProps = {}): Promise<ActionPalette> {
  const palette = new ActionPalette();
  palette.actions = props.actions ?? [action("a", "Alpha"), action("b", "Beta")];
  if (props.onRun !== undefined) palette.onRun = props.onRun;
  if (props.onCancel !== undefined) palette.onCancel = props.onCancel;
  document.body.append(palette);
  await settleRenderedDialog(palette);
  return palette;
}

function searchInput(palette: ActionPalette): HTMLInputElement {
  return requiredElement(palette.shadowRoot?.querySelector<HTMLInputElement>("input"), "action-palette search input");
}

function actionButtons(palette: ActionPalette): HTMLButtonElement[] {
  return [...(palette.shadowRoot?.querySelectorAll<HTMLButtonElement>(".options button") ?? [])];
}

function closeButton(palette: ActionPalette): HTMLButtonElement {
  return requiredElement(palette.shadowRoot?.querySelector<HTMLButtonElement>("header button[aria-label='Close']"), "action-palette Close button");
}

function selectedActionIndex(palette: ActionPalette): number {
  return actionButtons(palette).findIndex((button) => button.classList.contains("selected"));
}

function action(id: string, title: string, patch: Partial<AppAction> = {}): AppAction {
  return { id, title, run: () => undefined, ...patch };
}
