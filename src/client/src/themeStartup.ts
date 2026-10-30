import { bootstrapPreference, loadDefaultThemeBootstrap, readInitialThemeBootstrap, type BrowserThemeCatalog } from "./themeCatalog";
import { applyPiWebTheme, resolveThemePreference } from "./theme";
import { addThemeStylesheets, setInitialThemeStylesheets } from "./plugins/styleSources";

/** One startup owner. Importing it has no network or DOM side effects. */
export const themeStartup: {
  started: boolean;
  pending: boolean;
  catalog: Promise<BrowserThemeCatalog | undefined>;
  ready: Promise<void>;
  releaseDocument: (() => void) | undefined;
  failed: boolean;
  documentClaimed: boolean;
  cancelled: boolean;
} = { started: false, pending: false, catalog: Promise.resolve(undefined), ready: Promise.resolve(), releaseDocument: undefined, failed: false, documentClaimed: false, cancelled: false };

/** Prepare the delivered palette while the application module loads in parallel. */
export function beginThemeStartup(): void {
  if (themeStartup.started) return;
  themeStartup.started = true;
  themeStartup.pending = true;
  const initial = readInitialThemeBootstrap(document);
  setInitialThemeStylesheets([]);
  themeStartup.catalog = (initial === undefined ? loadDefaultThemeBootstrap() : Promise.resolve(initial)).then((bootstrap) => {
    addThemeStylesheets(bootstrap.stylesheets);
    return bootstrap.catalog;
  }).catch((error: unknown) => {
    if (themeStartup.cancelled) return undefined;
    console.warn("Could not load declarative themes; runtime themes remain available", error);
    themeStartup.failed = true;
    return undefined;
  });
  // Read initial data (or start fallback discovery) before downloading stylesheet
  // compilation machinery. That shared module and the application load concurrently.
  const registry = import("./plugins/styles").then((styles) => {
    if (!themeStartup.documentClaimed && !themeStartup.cancelled) themeStartup.releaseDocument = styles.pluginStyles.registerRoot(document);
    return styles;
  });
  themeStartup.ready = Promise.all([themeStartup.catalog, registry]).then(async ([catalog, styles]) => {
    if (catalog === undefined || themeStartup.cancelled) return;
    const theme = resolveThemePreference({
      themes: catalog.themes, themePairs: catalog.themePairs,
      preference: bootstrapPreference(catalog, undefined),
      prefersLight: window.matchMedia("(prefers-color-scheme: light)").matches,
      pending: false,
    }).activeTheme;
    // If the intended default needs legacy activation, use the delivered fallback.
    // The application owns browser overrides and later theme changes.
    if (theme !== undefined) await styles.pluginStyles.setTheme(theme.stylesheets ?? [], () => {
      if (!themeStartup.cancelled) applyPiWebTheme(theme);
    });
  }).catch((error: unknown) => {
    if (themeStartup.cancelled) return;
    themeStartup.failed = true;
    console.error("Could not load the initial theme; using the startup palette", error);
  }).finally(() => { themeStartup.pending = false; });
}

/** Called after the application registers the document, transferring root ownership. */
export function claimStartupDocument(): void {
  themeStartup.documentClaimed = true;
  themeStartup.releaseDocument?.();
  themeStartup.releaseDocument = undefined;
}

/** Application teardown invalidates startup work that has not reached publication. */
export function cancelInitialTheme(): void {
  if (!themeStartup.pending) return;
  themeStartup.cancelled = true;
  themeStartup.pending = false;
  themeStartup.releaseDocument?.();
  themeStartup.releaseDocument = undefined;
}

export function revealApplication(): void {
  delete document.documentElement.dataset["piWebLoading"];
  document.getElementById("pi-web-startup")?.remove();
}

export function showStartupFailure(): void {
  const loader = document.getElementById("pi-web-startup");
  if (loader === null) return;
  loader.removeAttribute("aria-label");
  loader.textContent = "PI WEB couldn’t start. Reload the page to try again.";
}
