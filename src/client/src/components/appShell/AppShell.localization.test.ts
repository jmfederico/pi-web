// @vitest-environment happy-dom
import { installNativeDialogFake } from "../nativeDialog.testSupport";
installNativeDialogFake();

import { afterEach, expect, it, vi } from "vitest";
import { html, LitElement } from "lit";
import { localization } from "../../localization/browser";
import { appShellMessages as m } from "../../appShellMessages";
import { NavigationDialog } from "./NavigationDialog";
import { AppContextBar } from "./AppContextBar";
import { AppMobileMainTabs } from "./AppMobileMainTabs";
import { AppNavigationPanel } from "./AppNavigationPanel";
import { AppPanelEdgeControl } from "./AppPanelEdgeControl";
import { AppRefreshControl } from "./AppRefreshControl";
import { NavigationSectionResizeHandle } from "./NavigationSectionResizeHandle";
import { WorkspacePanel } from "../WorkspacePanel";
import { horizontalScrollEdges } from "./scrollEdges";

let release: (() => void) | undefined;
afterEach(async () => {
  document.body.replaceChildren();
  release?.();
  release = undefined;
  await localization.setPreferences({ language: "en", formatLocale: "en" });
  localStorage.clear();
  vi.restoreAllMocks();
});
function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Expected shell control");
  return value;
}
async function mount<T extends LitElement>(element: T): Promise<T> {
  document.body.append(element);
  await element.updateComplete;
  return element;
}
async function locale(language: string, ...elements: LitElement[]) {
  await localization.setPreferences({ language, formatLocale: "de-DE" });
  for (const element of elements) await element.updateComplete;
}

it("keeps destination search, focus, selection and pin behavior across live language changes", async () => {
  release = localization.registerCatalog({ id: "shell-test", namespace: "core.appShell", locale: "de", load: () => Promise.resolve({
    navigation: "Navigation wählen", search: "Navigation suchen", showAll: "Alle anzeigen", pin: "{label} anheften",
    destinationPosition: "{label}: {index, number} / {count, number}",
  }) });
  const dialog = new NavigationDialog();
  dialog.tabs = [{ id: "navigation", label: "User Alpha" }, { id: "chat", label: "User Beta" }];
  dialog.onSelect = vi.fn();
  dialog.onClose = vi.fn();
  dialog.onPreferencesChange = vi.fn();
  await mount(dialog);
  const search = required(dialog.shadowRoot?.querySelector("input"));
  search.value = "Beta";
  search.dispatchEvent(new Event("input", { bubbles: true }));
  await dialog.updateComplete;
  search.focus();
  const surface = required(dialog.shadowRoot?.querySelector<LitElement>("modal-surface"));
  const show = vi.spyOn(HTMLDialogElement.prototype, "showModal").mockClear();
  for (const language of ["de", "en-XA", "ar-XB"]) {
    await locale(language, dialog, surface);
    expect(dialog.shadowRoot?.querySelector("input")).toBe(search);
    expect(dialog.shadowRoot?.activeElement).toBe(search);
    expect(search.value).toBe("Beta");
    expect(search.getAttribute("aria-label")).toBe(m.t("search"));
    expect(dialog.shadowRoot?.querySelector(".destination-button")?.textContent).toBe("User Beta");
    expect(dialog.shadowRoot?.querySelector('[role="status"]')?.textContent).toBe(m.t("destinationPosition", { label: "User Beta", index: 1, count: 1 }));
    expect(dialog.onSelect).not.toHaveBeenCalled();
    expect(dialog.onClose).not.toHaveBeenCalled();
    expect(show).not.toHaveBeenCalled();
  }
  required(dialog.shadowRoot?.querySelector<HTMLButtonElement>(".pin-button")).click();
  expect(dialog.onPreferencesChange).toHaveBeenCalledWith({ pinnedIds: ["navigation"], mobileCollapsed: false }, "pinnedIds");
  search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, composed: true }));
  expect(dialog.onSelect).toHaveBeenCalledWith("chat");
  expect(dialog.onClose).toHaveBeenCalledOnce();
});

it("refreshes context actions and fallback labels without translating names, paths or session content", async () => {
  const bar = new AppContextBar();
  bar.onShowNavigation = vi.fn();
  bar.onShowActions = vi.fn();
  bar.onOpenSection = vi.fn();
  await mount(bar);
  const project = required(bar.shadowRoot?.querySelector<HTMLButtonElement>("button.context-chip.empty"));
  project.focus();
  for (const language of ["en-XA", "ar-XB"]) {
    await locale(language, bar);
    expect(bar.shadowRoot?.activeElement).toBe(project);
    expect(project.textContent).toContain(m.t("noProject"));
    expect(project.getAttribute("aria-label")).toBe(m.t("projectSelection", { label: m.t("noProject") }));
    expect(bar.shadowRoot?.querySelector("[data-navigation-trigger]")?.getAttribute("aria-label")).toBe(m.t("navigation"));
  }
  bar.project = { id: "project", name: "User <b>name</b>", path: "/home/مشروع", createdAt: "" };
  await bar.updateComplete;
  expect(project.textContent).toContain("User <b>name</b>");
  expect(project.querySelector("b")).toBeNull();
  expect(project.title).toBe(m.t("projectDetail", { name: bar.project.name, path: bar.project.path }));
  project.click();
  expect(bar.onOpenSection).toHaveBeenCalledWith("projects");
});

it("keeps tool DOM, tab identity and raw contribution labels while formatting badges regionally", async () => {
  const workspace = new WorkspacePanel();
  const id = "plugin:panel";
  workspace.panels = [{ id, title: "User tool", badge: () => 1234, render: () => html`<input value="draft">` }];
  workspace.onShowNavigation = vi.fn();
  workspace.onTogglePanel = vi.fn();
  await mount(workspace);
  const tool = required(workspace.shadowRoot?.querySelector("input"));
  tool.value = "Retained draft";
  tool.focus();
  await locale("ar-XB", workspace);
  expect(workspace.shadowRoot?.querySelector("input")).toBe(tool);
  expect(tool.value).toBe("Retained draft");
  expect(workspace.shadowRoot?.activeElement).toBe(tool);
  expect(workspace.shadowRoot?.querySelector(".tab-label")?.textContent).toBe("User tool");
  expect(workspace.shadowRoot?.querySelector(".tab-badge")?.textContent).toBe("1.234");
  expect(workspace.shadowRoot?.querySelector(".ui-tab")?.getAttribute("aria-label")).toBe(m.t("badge", { label: "User tool", badge: "1.234" }));
  const tabs = new AppMobileMainTabs();
  tabs.tabs = [{ id: "chat", label: "User tool", badge: 1234 }];
  tabs.onShowNavigation = vi.fn();
  await mount(tabs);
  expect(tabs.shadowRoot?.querySelector(".tab-badge")?.textContent).toBe("1.234");
  workspace.panels = [];
  await workspace.updateComplete;
  expect(workspace.shadowRoot?.querySelector("h2")?.textContent).toBe(m.t("selectWorkspace"));
});

it("updates panel and section controls in place and mirrors width keys in RTL", async () => {
  const edge = new AppPanelEdgeControl();
  edge.resizable = true;
  edge.panelWidth = 340;
  edge.onResize = vi.fn();
  await mount(edge);
  const handle = required(edge.shadowRoot?.querySelector<HTMLElement>('[role="separator"]'));
  handle.focus();
  await locale("ar-XB", edge);
  expect(edge.shadowRoot?.activeElement).toBe(handle);
  expect(handle.getAttribute("aria-label")).toBe(m.t("resizeNavigation"));
  handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
  expect(edge.onResize).toHaveBeenLastCalledWith(364);
  handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  expect(edge.onResize).toHaveBeenLastCalledWith(316);
  const section = new NavigationSectionResizeHandle();
  section.sectionLabel = "User section";
  await mount(section);
  expect(section.shadowRoot?.querySelector("div")?.getAttribute("aria-label")).toBe(m.t("resizeSection", { section: "User section" }));
  const navigation = await mount(new AppNavigationPanel());
  navigation.onTogglePanel = vi.fn();
  navigation.onShowActions = vi.fn();
  const refresh = await mount(new AppRefreshControl());
  refresh.onReload = vi.fn();
  await locale("en-XA", navigation, refresh, section, edge);
  expect(navigation.shadowRoot?.querySelector(".actions-button")?.getAttribute("aria-label")).toBe(m.t("showActions"));
  expect(navigation.shadowRoot?.querySelector("[data-panel-toggle]")?.getAttribute("aria-label")).toBe(m.t("collapseNavigation"));
  required(refresh.shadowRoot?.querySelector("button")).click();
  expect(refresh.onReload).toHaveBeenCalledOnce();
  expect(refresh.shadowRoot?.querySelector("button")?.title).toBe(m.t("reload"));
});

it("reports physical scroll overflow at both RTL and LTR edges", () => {
  expect(horizontalScrollEdges(0, 200, "ltr")).toEqual({ left: false, right: true });
  expect(horizontalScrollEdges(200, 200, "ltr")).toEqual({ left: true, right: false });
  expect(horizontalScrollEdges(0, 200, "rtl")).toEqual({ left: true, right: false });
  expect(horizontalScrollEdges(-200, 200, "rtl")).toEqual({ left: false, right: true });
  expect(horizontalScrollEdges(-100, 200, "rtl")).toEqual({ left: true, right: true });
  expect(horizontalScrollEdges(0, 0, "rtl")).toEqual({ left: false, right: false });
});
