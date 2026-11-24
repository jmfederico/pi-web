import { describe, expect, it, vi } from "vitest";
import { ComposerFocusRequest, type ComposerFocusSurface } from "./composerFocusRequest";

function surface(patch: Partial<ComposerFocusSurface> = {}): ComposerFocusSurface {
  return { selectedChatKey: "local:new", chatVisible: true, modalOpen: false, focus: () => true, ...patch };
}

describe("ComposerFocusRequest", () => {
  it("waits across renders until the target composer exists, then focuses it once", () => {
    const request = new ComposerFocusRequest();
    request.request("local:new", () => true);
    const focus = vi.fn(() => false);

    request.offer(() => surface({ focus }));
    focus.mockReturnValue(true);
    request.offer(() => surface({ focus }));
    request.offer(() => surface({ focus }));

    expect(focus).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["navigation moved on", { current: false, patch: {} }],
    ["another chat is selected", { current: true, patch: { selectedChatKey: "local:other" } }],
    ["no chat is selected", { current: true, patch: { selectedChatKey: undefined } }],
    ["Chat became hidden", { current: true, patch: { chatVisible: false } }],
    ["a modal owns focus", { current: true, patch: { modalOpen: true } }],
  ] as const)("drops the request without focusing when %s", (_reason, { current, patch }) => {
    const request = new ComposerFocusRequest();
    request.request("local:new", () => current);
    const focus = vi.fn(() => true);

    request.offer(() => surface({ ...patch, focus }));
    request.offer(() => surface({ focus }));

    expect(focus).not.toHaveBeenCalled();
  });

  it("targets only the latest request", () => {
    const request = new ComposerFocusRequest();
    request.request("local:first", () => true);
    request.request("local:new", () => true);
    const focus = vi.fn(() => true);

    request.offer(() => surface({ focus }));
    expect(focus).toHaveBeenCalledOnce();

    request.request("local:first", () => true);
    request.request("local:new", () => true);
    request.offer(() => surface({ selectedChatKey: "local:first", focus }));
    expect(focus).toHaveBeenCalledOnce();
  });
});
