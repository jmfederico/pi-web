import { localization as browserLocalization } from "../../localization/browser";
import type { LocalizationService, LocalizedMessages } from "../../localization/service";
import type { PiWebPlugin } from "../types";
import definitions from "./themes.messages";
import { materialFileIcons } from "./material/generated";

const builtInThemeMessageKeys = {
  "themes:pi-web-dark": ["darkName", "darkDescription"],
  "themes:pi-web-light": ["lightName", "lightDescription"],
  "themes:classic": ["classicName", "classicDescription"],
  "themes:paper": ["paperName", "paperDescription"],
  "themes:graphite": ["graphiteName", "graphiteDescription"],
  "themes:pi-web": ["piWebPairName", "piWebPairDescription"],
  "themes:paper-graphite": ["neutralPairName", "neutralPairDescription"],
} as const;

const staticThemeMessages = new WeakMap<LocalizationService, LocalizedMessages<typeof definitions>>();

/** Apply live built-in labels after the host qualifies static catalog identities. */
export function localizeBuiltInThemeMetadata<T extends { id: string; name: string; description?: string }>(
  contribution: T,
  localization: LocalizationService = browserLocalization,
): T {
  const keys = Object.entries(builtInThemeMessageKeys).find(([id]) => id === contribution.id)?.[1];
  if (keys === undefined) return contribution;
  let messages = staticThemeMessages.get(localization);
  if (messages === undefined) {
    // Static metadata lives for the application lifetime, independent of browser activation.
    messages = localization.acquireMessages("plugin:themes:themes", definitions).messages;
    staticThemeMessages.set(localization, messages);
  }
  const labels = messages;
  return {
    ...contribution,
    get name() { return labels.t(keys[0]); },
    get description() { return labels.t(keys[1]); },
  };
}

// Palettes and pairs are discovered statically from pi-web-plugins/themes.
// Keep the browser plugin for file icons and the existing localization namespace.
export const themePackPlugin: PiWebPlugin = {
  apiVersion: 5,
  name: "PI WEB Themes",
  activate: ({ localization }) => {
    if (localization === undefined) throw new Error("The built-in theme pack requires host localization");
    const messages = localization.registerMessages("themes", definitions);
    return { contributions: {
      fileIconThemes: [{
        id: "material",
        get name() { return messages.t("materialName"); },
        get description() { return messages.t("materialDescription"); },
        order: 10,
        ...materialFileIcons,
      }],
    } };
  },
};
