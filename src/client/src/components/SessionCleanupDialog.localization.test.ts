// @vitest-environment happy-dom
import { installNativeDialogFake } from "./nativeDialog.testSupport";
installNativeDialogFake();
import { afterEach, expect, it, vi } from "vitest";
import type { SessionCleanupPreviewResponse } from "../api";
import { localization } from "../localization/browser";
import { sessionCleanupMessages as messages } from "../sessionCleanupMessages";
import { SessionCleanupDialog } from "./SessionCleanupDialog";

let release: (() => void) | undefined;
afterEach(async () => {
  document.body.replaceChildren();
  release?.(); release = undefined;
  await localization.setPreferences({ language: "en", formatLocale: "en" });
  localStorage.clear();
  vi.unstubAllGlobals();
});

const preview: SessionCleanupPreviewResponse = {
  generatedAt: "2026-10-21T12:00:00Z", thresholds: { archiveIdleDays: 30 },
  projects: [
    { cwd: "/repo/<b>user path</b>", archiveCount: 1234, deleteCount: 0 },
    { cwd: "/other", archiveCount: 4, deleteCount: 0 },
  ], totals: { archiveCount: 1238, deleteCount: 0 }, skippedBusySessionIds: ["busy"],
};
function required<T extends HTMLElement>(view: SessionCleanupDialog, selector: string, type: new () => T): T {
  const element = view.shadowRoot?.querySelector(selector);
  if (!(element instanceof type)) throw new Error(`Missing ${selector}`);
  return element;
}
async function mount(): Promise<SessionCleanupDialog> {
  const view = new SessionCleanupDialog();
  view.preview = preview;
  view.previewRequest = { archiveIdleDays: 30, deleteArchivedDays: null, skipPinned: true };
  view.onPreview = vi.fn(); view.onRun = vi.fn(); view.onClose = vi.fn();
  document.body.append(view);
  await view.updateComplete; await view.updateComplete;
  return view;
}

it("updates review selection, counts and diagnostics live without resetting controls or running actions", async () => {
  const view = await mount();
  const firstProject = required(view, "tbody input", HTMLInputElement);
  firstProject.click(); await view.updateComplete;
  firstProject.focus();
  view.errorMessage = () => messages.t("previewFailed", { error: "Raw <img> backend diagnostic" });
  release = localization.registerCatalog({ id: "cleanup-test", namespace: "core.sessionCleanup", locale: "de", load: () => Promise.resolve({
    archiveRule: "Nach dieser Anzahl inaktiver Tage archivieren",
    deleteRule: "Nach dieser Anzahl Tage im Archiv löschen",
    preview: "Vorschau", previewFailed: "Vorschau fehlgeschlagen: {error}",
  }) });
  for (const language of ["de", "en-XA", "ar-XB", "en"]) {
    await localization.setPreferences({ language, formatLocale: "ar-EG" });
    await view.updateComplete; await view.updateComplete;
    expect(view.shadowRoot?.querySelector("fieldset")).toBeNull();
    const summary = required(view, ".review-summary", HTMLElement);
    expect(summary.textContent).toContain(messages.t("summaryPinsProtected"));
    expect(summary.textContent).not.toContain(messages.t("summaryPinsIncluded"));
    expect(summary.textContent).toContain(messages.t("summaryEstimates"));
    expect(view.shadowRoot?.activeElement).toBe(firstProject);
    expect(firstProject.checked).toBe(false);
    expect(required(view, "tfoot td", HTMLElement).textContent).toBe(localization.number(4));
    expect(required(view, ".selection-controls span", HTMLElement).textContent).toBe(messages.t("selection", { selected: 1, total: 2 }));
    expect(view.shadowRoot?.textContent).toContain(preview.projects[0]?.cwd);
    expect(view.shadowRoot?.textContent).toContain(messages.t("previewFailed", { error: "Raw <img> backend diagnostic" }));
    expect(view.shadowRoot?.querySelector("b, img")).toBeNull();
    expect(view.onPreview).not.toHaveBeenCalled(); expect(view.onRun).not.toHaveBeenCalled(); expect(view.onClose).not.toHaveBeenCalled();
  }
});

it("shows the pinned-session risk and permanent-deletion rule when protection is off", async () => {
  const view = await mount();
  required(view, "footer button:first-child", HTMLButtonElement).click();
  await view.updateComplete;
  required(view, "#skip-pinned", HTMLInputElement).click();
  required(view, '.cleanup-rule:nth-child(2) input[type="checkbox"]', HTMLInputElement).click();
  view.previewRequest = { archiveIdleDays: 30, deleteArchivedDays: 90, skipPinned: false };
  view.preview = { ...preview, thresholds: { archiveIdleDays: 30, deleteArchivedDays: 90 } };
  await view.updateComplete;
  for (const language of ["en", "en-XA", "ar-XB"]) {
    await localization.setPreferences({ language, formatLocale: "en" });
    await view.updateComplete;
    const summary = required(view, ".review-summary", HTMLElement);
    expect(summary.textContent).toContain(messages.t("summaryPinsIncluded"));
    expect(summary.textContent).not.toContain(messages.t("summaryPinsProtected"));
    expect(summary.textContent).toContain(messages.t("deleteSummary", { days: 90 }));
    expect(summary.textContent).toContain(messages.t("summaryBusy"));
    for (const icon of summary.querySelectorAll("svg")) expect(icon.getAttribute("aria-hidden")).toBe("true");
  }
});

it("renders structured validation live and previews only valid requests", async () => {
  const view = await mount();
  required(view, "footer button:first-child", HTMLButtonElement).click();
  await view.updateComplete;
  const threshold = required(view, ".days", HTMLInputElement);
  threshold.value = "";
  threshold.dispatchEvent(new InputEvent("input", { bubbles: true }));
  await view.updateComplete;
  required(view, "footer button:nth-child(2)", HTMLButtonElement).click();
  for (const language of ["en-XA", "ar-XB", "en"]) {
    await localization.setPreferences({ language, formatLocale: "de-DE" });
    await view.updateComplete;
    expect(required(view, ".dialog-error", HTMLElement).textContent).toBe(messages.t("archiveRequired"));
    expect(view.onPreview).not.toHaveBeenCalled();
  }
  threshold.value = "7";
  threshold.dispatchEvent(new InputEvent("input", { bubbles: true }));
  await view.updateComplete;
  required(view, "footer button:nth-child(2)", HTMLButtonElement).click();
  expect(view.onPreview).toHaveBeenCalledExactlyOnceWith({ archiveIdleDays: 7, deleteArchivedDays: null, skipPinned: true });
});

it("confirms the selected project totals in the current language and never executes a rejected confirmation", async () => {
  const view = await mount();
  const confirm = vi.fn(() => false);
  vi.stubGlobal("confirm", confirm);
  required(view, "tbody input", HTMLInputElement).click(); await view.updateComplete;
  await localization.setPreferences({ language: "ar-XB", formatLocale: "ar-EG" });
  await view.updateComplete;
  required(view, "footer .danger", HTMLButtonElement).click();
  expect(confirm).toHaveBeenCalledExactlyOnceWith(messages.t("confirm", { archive: 4, delete: 0 }));
  expect(view.onRun).not.toHaveBeenCalled();
  confirm.mockReturnValue(true);
  required(view, "footer .danger", HTMLButtonElement).click();
  expect(view.onRun).toHaveBeenCalledExactlyOnceWith({ archiveIdleDays: 30, deleteArchivedDays: null, skipPinned: true, projectCwds: ["/other"] });
});

it.each([
  [0, 0, "Run cleanup?"],
  [1, 0, "Run cleanup and archive 1 idle session?"],
  [2, 0, "Run cleanup and archive 2 idle sessions?"],
  [0, 1, "Run cleanup and permanently delete 1 archived session?"],
  [0, 2, "Run cleanup and permanently delete 2 archived sessions?"],
  [1, 1, "Run cleanup and archive 1 idle session and permanently delete 1 archived session?"],
  [2, 2, "Run cleanup and archive 2 idle sessions and permanently delete 2 archived sessions?"],
])("uses a complete destructive confirmation for archive=%s delete=%s", (archive, deletion, expected) => {
  expect(messages.t("confirm", { archive, delete: deletion })).toBe(`${expected}\n\nThese counts are estimates. Eligible sessions and counts may change before cleanup runs.\n\nPermanent deletion only applies to archived sessions and cannot be undone.`);
});
