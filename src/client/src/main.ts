import "./components/PiWebApp";
import { initializeLocalization, localizationPolicyFromConfig } from "./localization/browser.js";
import { configureThemePolicy } from "./theme.js";
import { configApi } from "./api.js";

// Defaults belong to the gateway, not whichever machine/workspace is selected.
// Browser-local preferences remain usable while the request is pending or fails.
const config = configApi.config().then((response) => {
  configureThemePolicy(response);
  return response;
}).catch((cause: unknown) => {
  console.warn("[i18n] Could not load gateway localization defaults; using browser preferences", cause);
  return undefined;
});
void initializeLocalization(undefined, window, undefined,
  config.then((response) => response?.effectiveConfig.defaultLocalization),
  config.then((response) => response === undefined ? {} : localizationPolicyFromConfig(response)),
).catch((cause: unknown) => {
  console.error("[i18n] Localization startup failed", cause);
});
