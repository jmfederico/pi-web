import { describe, expect, it, vi } from "vitest";
import { activateSelectableRow, handleSelectableRowKeyboard } from "./selectableRow";

describe("selectable row activation", () => {
  it("activates rows from non-interactive click targets", () => {
    const action = vi.fn();
    activateSelectableRow(eventWithPath(matchTarget(() => false)), action);
    expect(action).toHaveBeenCalledOnce();
  });

  it("preserves contributed links inside rows", () => {
    const action = vi.fn();
    activateSelectableRow(eventWithPath(matchTarget((selector: string) => selector.includes("a[href]"))), action);
    expect(action).not.toHaveBeenCalled();
  });

  it("activates rows from Enter and Space", () => {
    const enterAction = vi.fn();
    const spaceAction = vi.fn();
    const enter = keyboardEventWithPath("Enter", matchTarget(() => false));
    const space = keyboardEventWithPath(" ", matchTarget(() => false));

    expect(handleSelectableRowKeyboard(enter, { activate: enterAction })).toBe(true);
    expect(handleSelectableRowKeyboard(space, { activate: spaceAction })).toBe(true);

    expect(enterAction).toHaveBeenCalledOnce();
    expect(spaceAction).toHaveBeenCalledOnce();
    expect(enter.preventDefault).toHaveBeenCalledOnce();
    expect(space.preventDefault).toHaveBeenCalledOnce();
  });

  it("does not activate rows from keyboard events inside interactive elements", () => {
    const action = vi.fn();
    const event = keyboardEventWithPath("Enter", matchTarget((selector: string) => selector.includes("button")));

    expect(handleSelectableRowKeyboard(event, { activate: action })).toBe(false);

    expect(action).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("routes row keyboard navigation to adjacent section callbacks", () => {
    const nextSection = vi.fn();
    const event = keyboardEventWithPath("ArrowRight", matchTarget(() => false));

    expect(handleSelectableRowKeyboard(event, { activate: vi.fn(), nextSection })).toBe(true);

    expect(nextSection).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
  });

  it("routes Escape row keyboard navigation to cancel", () => {
    const cancel = vi.fn();
    const event = keyboardEventWithPath("Escape", matchTarget(() => false));

    expect(handleSelectableRowKeyboard(event, { activate: vi.fn(), cancel })).toBe(true);

    expect(cancel).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
  });
});

type EventWithPath = Pick<Event, "composedPath">;
type KeyboardEventWithPath = EventWithPath & Pick<KeyboardEvent, "key" | "preventDefault" | "stopPropagation">;
type MatchTarget = EventTarget & Pick<Element, "matches">;

function matchTarget(matches: Element["matches"]): MatchTarget {
  return Object.assign(new EventTarget(), { matches });
}

function eventWithPath(target: MatchTarget): EventWithPath {
  return { composedPath: () => [target] };
}

function keyboardEventWithPath(key: string, target: MatchTarget): KeyboardEventWithPath {
  return { key, preventDefault: vi.fn<() => void>(), stopPropagation: vi.fn<() => void>(), composedPath: () => [target] };
}
