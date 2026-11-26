// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

it("queues one selectionchange task for selection changes made in the same task, as browsers do", () => {
  vi.useFakeTimers();
  const text = document.createTextNode("selection");
  document.body.append(text);
  const events: Event[] = [];
  document.addEventListener("selectionchange", (event) => { events.push(event); });
  const selection = document.getSelection();
  if (selection === null) throw new Error("Expected a document selection");

  selection.collapse(text, 1);
  selection.collapse(text, 2);
  expect(events).toHaveLength(0);

  vi.runAllTimers();
  expect(events).toHaveLength(1);
});
