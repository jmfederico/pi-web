import { describe, expect, it, vi } from "vitest";
import { activateSelectableRow, activateSelectableRowFromKeyboard } from "./selectableRow";

describe("selectable row activation", () => {
  it("activates rows from non-interactive click targets", () => {
    const action = vi.fn();
    activateSelectableRow(eventWithPath(matchTarget(() => false)), action);
    expect(action).toHaveBeenCalledOnce();
  });

  it("preserves contributed links and other interactive elements", () => {
    const action = vi.fn();
    activateSelectableRow(eventWithPath(matchTarget((selector: string) => selector.includes("a[href]"))), action);
    expect(action).not.toHaveBeenCalled();
  });

  it("activates rows from Enter and Space", () => {
    const enterAction = vi.fn();
    const spaceAction = vi.fn();
    const enter = keyboardEventWithPath("Enter", matchTarget(() => false));
    const space = keyboardEventWithPath(" ", matchTarget(() => false));

    activateSelectableRowFromKeyboard(enter, enterAction);
    activateSelectableRowFromKeyboard(space, spaceAction);

    expect(enterAction).toHaveBeenCalledOnce();
    expect(spaceAction).toHaveBeenCalledOnce();
    expect(enter.preventDefault).toHaveBeenCalledOnce();
    expect(space.preventDefault).toHaveBeenCalledOnce();
  });

  it("does not activate rows from keyboard events inside interactive elements", () => {
    const action = vi.fn();
    const event = keyboardEventWithPath("Enter", matchTarget((selector: string) => selector.includes("button")));

    activateSelectableRowFromKeyboard(event, action);

    expect(action).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});

type EventWithPath = Pick<Event, "composedPath">;
type KeyboardEventWithPath = EventWithPath & Pick<KeyboardEvent, "key" | "preventDefault">;
type MatchTarget = EventTarget & Pick<Element, "matches">;

function matchTarget(matches: Element["matches"]): MatchTarget {
  return Object.assign(new EventTarget(), { matches });
}

function eventWithPath(target: MatchTarget): EventWithPath {
  return { composedPath: () => [target] };
}

function keyboardEventWithPath(key: string, target: MatchTarget): KeyboardEventWithPath {
  return { key, preventDefault: vi.fn<() => void>(), composedPath: () => [target] };
}
