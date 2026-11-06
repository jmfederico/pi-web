// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { localization } from "../localization/browser";
import { BrowserErrorReporter, browserErrorScopeKey, machineBrowserErrorScope } from "../browserErrors";
import { initialAppState } from "../appState";
import { AuthController } from "../controllers/authController";
import { NotificationArea } from "./NotificationArea";

const releases: (() => void)[] = [];
afterEach(async () => {
  document.body.replaceChildren();
  for (const release of releases.splice(0)) release();
  await localization.setPreferences({ language: "en", formatLocale: "en" });
  localStorage.clear();
});

it("translates whole dismiss labels and retry controls while preserving the diagnostic and callbacks", async () => {
  releases.push(localization.registerCatalog({ id: "banner-test", namespace: "core.banners", locale: "de", load: () => Promise.resolve({
    dismissError: "Fehler ausblenden", dismissWarning: "Warnung ausblenden", dismissInfo: "Hinweis ausblenden", retry: "Erneut versuchen",
  }) }));
  await localization.setPreferences({ language: "de", formatLocale: "en" });
  releases.push(localization.registerCatalog({ id: "notification-test", namespace: "core.sessionNotifications", locale: "de", load: () => Promise.resolve({
    dismiss: "Benachrichtigung ausblenden: {summary}",
  }) }));
  await localization.ready;
  for (const severity of ["error", "warning", "info"] as const) {
    const dismiss = vi.fn(); const retry = vi.fn();
    const area = new NotificationArea();
    area.groups = [{ id: "browser", items: [{ id: severity, source: "browser", severity, message: "Unchanged diagnostic", dismiss, retry }] }];
    document.body.append(area); await area.updateComplete;
    const retryButton = area.renderRoot.querySelector<HTMLButtonElement>(".notification-retry");
    const dismissButton = area.renderRoot.querySelector<HTMLButtonElement>(".notification-row-dismiss");
    expect(area.renderRoot.querySelector(".notification-message")?.textContent).toBe("Unchanged diagnostic");
    expect(retryButton?.textContent).toBe("Erneut versuchen");
    expect(dismissButton?.getAttribute("aria-label")).toBe("Benachrichtigung ausblenden: Unchanged diagnostic");
    retryButton?.click(); await area.updateComplete; await area.updateComplete;
    dismissButton?.click();
    expect(retry).toHaveBeenCalledOnce(); expect(dismiss).toHaveBeenCalledOnce();
    area.remove();
  }
});

it("retains localized authentication feedback until dismissal, following language changes without another auth request", async () => {
  let state = initialAppState();
  const setState = (patch: Partial<typeof state>): void => { state = { ...state, ...patch }; };
  const controller = new AuthController(() => state, setState, vi.fn());
  await controller.openMcpAuth("login");
  const scope = machineBrowserErrorScope("local");
  const error = state.browserErrors[browserErrorScopeKey(scope)];
  expect(error?.message).toBe("Select a session to authenticate MCP servers.");
  releases.push(localization.registerCatalog({ id: "auth-banner-test", namespace: "core.auth", locale: "de", load: () => Promise.resolve({
    selectSession: "Eine Sitzung auswählen.",
  }) }));
  await localization.setPreferences({ language: "de", formatLocale: "en" });
  expect(error?.displayMessage?.()).toBe("Eine Sitzung auswählen.");
  // The original fallback remains the dismissal identity, independent of locale.
  expect(state.browserErrors[browserErrorScopeKey(scope)]).toBe(error);
  const reporter = new BrowserErrorReporter(() => state, setState);
  reporter.clear(scope, error?.message);
  expect(state.browserErrors).toEqual({});
  controller.dispose();
});
