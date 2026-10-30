// Response-delivered CSS stays available independently of compiler/registry startup.
// This is page-lifetime data, not browser preferences or persistent storage.
const sources = new Map<string, string>();

export function setInitialThemeStylesheets(stylesheets: readonly { url: string; cssText: string }[]): void {
  sources.clear();
  addThemeStylesheets(stylesheets);
}

export function addThemeStylesheets(stylesheets: readonly { url: string; cssText: string }[]): void {
  for (const stylesheet of stylesheets) sources.set(stylesheet.url, stylesheet.cssText);
}

export function providedStylesheetSource(url: string): string | undefined {
  return sources.get(url);
}
