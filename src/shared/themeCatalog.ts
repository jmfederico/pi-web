import type { PiWebThemePreference } from "./apiTypes.js";

export interface PiWebThemeStylesheetMetadata {
  id: string;
  /** Relative to the declaring plugin's browserRoot. */
  path: string;
  order?: number;
}

export interface PiWebThemeMetadata {
  id: string;
  name: string;
  description?: string;
  order?: number;
  colorScheme: "light" | "dark";
  stylesheets: PiWebThemeStylesheetMetadata[];
}

export interface PiWebThemePairMetadata {
  id: string;
  name: string;
  description?: string;
  order?: number;
  /** Local theme IDs within the same plugin. */
  light: string;
  dark: string;
}

export interface PiWebDeclarativeTheme extends Omit<PiWebThemeMetadata, "stylesheets"> {
  /** Theme IDs in catalog responses are qualified as pluginId:localId. */
  pluginId: string;
  /** Qualified stylesheet IDs and application-relative, revision-qualified URLs. */
  stylesheets: { id: string; url: string; order?: number }[];
}

export interface PiWebDeclarativeThemePair extends PiWebThemePairMetadata {
  pluginId: string;
}

export interface PiWebThemeBootstrap {
  catalog: PiWebThemeCatalogResponse;
  stylesheets: { url: string; cssText: string }[];
}

export interface PiWebThemeCatalogResponse {
  themes: PiWebDeclarativeTheme[];
  /** Pair IDs and both member IDs are qualified as pluginId:localId. */
  themePairs: PiWebDeclarativeThemePair[];
  defaultTheme?: PiWebThemePreference;
  enforcedBy?: string;
}
