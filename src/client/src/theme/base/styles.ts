import { css, unsafeCSS, type CSSResult } from "lit";

/** Base-theme presentation stays below consumer and selected-theme overrides. */
export function baseThemeStyles(cssText: string): CSSResult {
  return css`@layer pi-web-base { ${unsafeCSS(cssText)} }`;
}
