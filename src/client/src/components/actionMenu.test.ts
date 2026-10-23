// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { ProjectList } from "./ProjectList";
import { installPopoverFake } from "./anchoredPopup.testSupport";

installPopoverFake();
afterEach(() => { document.body.replaceChildren(); localStorage.clear(); vi.restoreAllMocks(); });

it("reconciles native dismissal with a list's selected action row", async () => {
  const list = new ProjectList();
  list.projects = [{ id: "a", name: "A", path: "/a", createdAt: "2026-01-01" }];
  document.body.append(list); await list.updateComplete;
  const trigger = list.shadowRoot?.querySelector<HTMLButtonElement>(".action-menu-toggle");
  trigger?.click(); await list.updateComplete;
  const panel = list.shadowRoot?.querySelector<HTMLElement>(".action-menu-panel");
  expect(panel?.getAttribute("popover")).toBe("auto");
  panel?.hidePopover(); await list.updateComplete;
  expect(list.shadowRoot?.querySelector(".action-menu-panel")).toBeNull();
  trigger?.click(); await list.updateComplete;
  expect(list.shadowRoot?.querySelector(".action-menu-panel")).not.toBeNull();
});
