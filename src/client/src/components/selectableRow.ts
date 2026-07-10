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
type SelectableNavigationKeyboardEvent = ComposedPathEvent
  & Pick<KeyboardEvent, "key" | "preventDefault">
  & Partial<Pick<KeyboardEvent, "currentTarget" | "stopPropagation">>;

export interface SelectableRowKeyboardOptions {
  activate: () => void;
  previousSection?: (() => void) | undefined;
  nextSection?: (() => void) | undefined;
  cancel?: (() => void) | undefined;
}

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

export function handleSelectableRowKeyboard(event: SelectableNavigationKeyboardEvent, options: SelectableRowKeyboardOptions): boolean {
  if (isFromInteractiveElement(event)) return false;
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    options.activate();
    return true;
  }
  if (event.key === "ArrowUp") return handleRowFocusKey(event, () => { focusRelativeSelectableRow(event.currentTarget, -1); });
  if (event.key === "ArrowDown") return handleRowFocusKey(event, () => { focusRelativeSelectableRow(event.currentTarget, 1); });
  if (event.key === "Home") return handleRowFocusKey(event, () => { focusIndexedSelectableRow(event.currentTarget, 0); });
  if (event.key === "End") return handleRowFocusKey(event, () => { focusIndexedSelectableRow(event.currentTarget, -1); });
  if (event.key === "ArrowLeft" && options.previousSection !== undefined) return handleRowFocusKey(event, options.previousSection);
  if (event.key === "ArrowRight" && options.nextSection !== undefined) return handleRowFocusKey(event, options.nextSection);
  if (event.key === "Escape" && options.cancel !== undefined) return handleRowFocusKey(event, options.cancel);
  return false;
}

export function focusSelectedOrFirstSelectableRow(root: ParentNode, options: { fallbackSelector?: string | undefined } = {}): boolean {
  const target = root.querySelector<HTMLElement>(".action-row.selected")
    ?? root.querySelector<HTMLElement>(".action-row")
    ?? (options.fallbackSelector === undefined ? undefined : root.querySelector<HTMLElement>(options.fallbackSelector));
  if (target === undefined || target === null) return false;
  target.focus();
  target.scrollIntoView({ block: "nearest" });
  return true;
}

function handleRowFocusKey(event: SelectableNavigationKeyboardEvent, action: () => void): true {
  event.preventDefault();
  event.stopPropagation?.();
  action();
  return true;
}

function focusRelativeSelectableRow(target: EventTarget | null | undefined, delta: number): void {
  const rows = selectableRowsForTarget(target);
  const current = currentSelectableRow(target);
  if (current === undefined || rows.length === 0) return;
  const index = rows.indexOf(current);
  if (index < 0) return;
  focusSelectableRowAt(rows, index + delta);
}

function focusIndexedSelectableRow(target: EventTarget | null | undefined, index: number): void {
  const rows = selectableRowsForTarget(target);
  if (rows.length === 0) return;
  focusSelectableRowAt(rows, index < 0 ? rows.length - 1 : index);
}

function focusSelectableRowAt(rows: HTMLElement[], index: number): void {
  const target = rows[Math.min(Math.max(index, 0), rows.length - 1)];
  target?.focus();
  target?.scrollIntoView({ block: "nearest" });
}

function selectableRowsForTarget(target: EventTarget | null | undefined): HTMLElement[] {
  const root = currentSelectableRow(target)?.getRootNode();
  if (root === undefined || !isSelectableRowRoot(root)) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(".action-row"));
}

function isSelectableRowRoot(root: Node): root is Document | DocumentFragment {
  return (typeof Document !== "undefined" && root instanceof Document)
    || (typeof DocumentFragment !== "undefined" && root instanceof DocumentFragment);
}

function currentSelectableRow(target: EventTarget | null | undefined): HTMLElement | undefined {
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) return undefined;
  return target.closest<HTMLElement>(".action-row") ?? undefined;
}
