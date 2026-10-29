// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_CHAT_BEHAVIORS } from "./chatBehaviors";
import { PiWebApp } from "./components/PiWebApp";

// Test the real entry point's policy injection without starting app networking,
// plugins or localization. Those services have their own contract tests.
vi.mock("./components/PiWebApp", async () => {
  const { DEFAULT_CHAT_BEHAVIORS: defaults } = await import("./chatBehaviors");
  class App extends HTMLElement { chatBehaviors = defaults; }
  const element = customElements.get("pi-web-app") ?? App;
  if (customElements.get("pi-web-app") === undefined) customElements.define("pi-web-app", element);
  return { PiWebApp: element };
});
vi.mock("./api.js", () => ({ configApi: { config: vi.fn(() => Promise.resolve({ effectiveConfig: {} })) } }));
vi.mock("./theme.js", () => ({ configureThemePolicy: vi.fn() }));
vi.mock("./localization/browser.js", () => ({
  initializeLocalization: vi.fn(() => Promise.resolve()),
  localizationPolicyFromConfig: vi.fn(() => ({})),
}));

beforeEach(() => { vi.resetModules(); });
afterEach(() => { document.body.replaceChildren(); vi.unstubAllEnvs(); });

it.each([false, true])("leaves experimental windowing disabled in the live app (DEV=%s)", async (development) => {
  vi.stubEnv("DEV", development);
  const app = new PiWebApp();
  document.body.append(app);
  await import("./main");
  expect(app.chatBehaviors).toBe(DEFAULT_CHAT_BEHAVIORS);
  expect(DEFAULT_CHAT_BEHAVIORS.mountingWindow).toBe(false);
});
