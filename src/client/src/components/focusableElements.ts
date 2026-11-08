import { isHiddenOrInertInComposedTree } from "./modalLayerRegistry";

const FOCUSABLE_SELECTOR = "button, input, select, textarea, a[href], [tabindex]";

/**
 * Focusable descendants in flattened Tab-cycle
 * order. Open shadow roots replace a host's light children, and slots insert
 * their assigned children where the slot is rendered.
 */
export function composedFocusableElements(root: Element): HTMLElement[] {
  const focusable: HTMLElement[] = [];
  const collect = (element: Element): void => {
    if (element instanceof HTMLElement && isSequentiallyFocusable(element)) focusable.push(element);
    for (const child of flattenedChildElements(element)) collect(child);
  };
  for (const child of flattenedChildElements(root)) collect(child);
  return withOneStopPerRadioGroup(focusable);
}

/**
 * Collapses every named radio group to the single Tab stop the platform gives
 * it: the checked member, or the group's first focusable member when none is
 * checked. Counting each radio separately would put the trap's last stop
 * before the group's real end, so Tab from the checked radio of a trailing
 * group would be treated as mid-cycle and walk focus out of the dialog.
 *
 * Groups are keyed by form owner and name, matching how HTML scopes a radio
 * group; radios with no name are independent stops and keep their own.
 */
function withOneStopPerRadioGroup(focusable: readonly HTMLElement[]): HTMLElement[] {
  const stopsByOwner = new Map<HTMLFormElement | null, Map<string, HTMLInputElement>>();
  for (const element of focusable) {
    const radio = namedRadio(element);
    if (radio === null) continue;
    const stopsByName = stopsByOwner.get(radio.form) ?? new Map<string, HTMLInputElement>();
    stopsByOwner.set(radio.form, stopsByName);
    const stop = stopsByName.get(radio.name);
    // First member wins until a checked member appears; a group has at most one
    // checked radio, so the checked member then keeps the stop for good.
    if (stop === undefined || (radio.checked && !stop.checked)) stopsByName.set(radio.name, radio);
  }
  const stops = new Set<HTMLElement>(Array.from(stopsByOwner.values()).flatMap((stopsByName) => Array.from(stopsByName.values())));
  return focusable.filter((element) => namedRadio(element) === null || stops.has(element));
}

function namedRadio(element: HTMLElement): HTMLInputElement | null {
  if (!(element instanceof HTMLInputElement) || element.type !== "radio" || element.name === "") return null;
  return element;
}

function isSequentiallyFocusable(element: HTMLElement): boolean {
  if (element.matches(":disabled") || isHiddenOrInertInComposedTree(element)) return false;
  if (element instanceof HTMLInputElement && element.type === "hidden") return false;
  // Native controls match by tag even when an explicit negative tabindex has
  // removed them from sequential keyboard navigation.
  return element.matches(FOCUSABLE_SELECTOR) && element.tabIndex >= 0;
}

function flattenedChildElements(parent: Element | ShadowRoot): Element[] {
  if (parent instanceof HTMLSlotElement) {
    const assigned = parent.assignedNodes({ flatten: true });
    // Preserve fallback content when a DOM implementation reports an empty
    // assigned list; assigned text keeps the list nonempty and suppresses it.
    const rendered = assigned.length === 0 ? parent.childNodes : assigned;
    return Array.from(rendered).filter((node): node is Element => node instanceof Element);
  }
  const renderedRoot = parent instanceof Element ? parent.shadowRoot ?? parent : parent;
  return Array.from(renderedRoot.children);
}
