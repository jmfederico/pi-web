const interactiveSelector = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  "[role='button']",
  "[role='link']",
  "[contenteditable='true']",
].join(",");

type ComposedPathEvent = Pick<Event, "composedPath">;
type SelectableKeyboardEvent = ComposedPathEvent & Pick<KeyboardEvent, "key" | "preventDefault">;

export function isFromInteractiveElement(event: ComposedPathEvent): boolean {
  return event.composedPath().some((target) => targetMatches(target, interactiveSelector));
}

function targetMatches(target: EventTarget, selector: string): boolean {
  if (typeof Element !== "undefined" && target instanceof Element) return target.matches(selector);
  if (!("matches" in target)) return false;
  const { matches } = target;
  return typeof matches === "function" && matches.call(target, selector) === true;
}

export function activateSelectableRow(event: ComposedPathEvent, action: () => void): void {
  if (isFromInteractiveElement(event)) return;
  action();
}

export function activateSelectableRowFromKeyboard(event: SelectableKeyboardEvent, action: () => void): void {
  if (event.key !== "Enter" && event.key !== " ") return;
  if (isFromInteractiveElement(event)) return;
  event.preventDefault();
  action();
}
