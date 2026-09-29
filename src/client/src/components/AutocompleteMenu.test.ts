// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutocompleteMenu } from "./AutocompleteMenu";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("AutocompleteMenu", () => {
  it("renders all forty matches and scrolls later selections into view", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => undefined);
    const menu = new AutocompleteMenu();
    menu.items = Array.from({ length: 40 }, (_, index) => ({
      kind: "command", replaceFrom: 0, replaceTo: 7, insertText: `/skill:example-${String(index + 1)}`, detail: "skill",
    }));
    document.body.append(menu);
    await menu.updateComplete;
    frames.splice(0).forEach((callback) => { callback(0); });
    scroll.mockClear();

    menu.selectedIndex = 39;
    await menu.updateComplete;
    frames.splice(0).forEach((callback) => { callback(0); });

    expect(menu.shadowRoot?.querySelectorAll("button")).toHaveLength(40);
    const selected = menu.shadowRoot?.querySelector("button.selected");
    expect(selected?.textContent).toContain("/skill:example-40");
    expect(scroll).toHaveBeenCalledExactlyOnceWith({ block: "nearest" });
    expect(scroll.mock.instances[0]).toBe(selected);

    const pick = vi.fn();
    menu.onPick = pick;
    selected?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(pick).toHaveBeenCalledWith(menu.items[39]);
  });

  it("renders the argument hint next to the command name, before the description", async () => {
    const menu = new AutocompleteMenu();
    menu.items = [{ kind: "command", replaceFrom: 0, replaceTo: 1, insertText: "/pr", detail: "prompt", description: "Review PRs from URLs", argumentHint: "<PR-URL>" }];
    document.body.append(menu);
    await menu.updateComplete;

    const label = menu.shadowRoot?.querySelector(".label");
    expect(label?.textContent).toContain("/pr");
    expect(label?.querySelector(".argument-hint")?.textContent).toBe("<PR-URL>");
    expect(menu.shadowRoot?.querySelector(".detail")?.textContent).toBe("prompt");
    expect(menu.shadowRoot?.querySelector("small")?.textContent).toBe("Review PRs from URLs");
  });

  it("omits the hint element for items without an argument hint", async () => {
    const menu = new AutocompleteMenu();
    menu.items = [{ kind: "file", replaceFrom: 0, replaceTo: 1, insertText: "@src/index.ts", detail: "tracked" }];
    document.body.append(menu);
    await menu.updateComplete;

    expect(menu.shadowRoot?.querySelector(".argument-hint")).toBeNull();
    expect(menu.shadowRoot?.querySelector(".label strong")?.textContent).toBe("@src/index.ts");
  });
});
