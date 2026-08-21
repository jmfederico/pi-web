/**
 * Minimal declarations for the vendored marked ESM build (./marked.esm.js).
 * Covers only the surface markdownDocument.ts uses; widen it if usage grows.
 * The plugin build copies the .js verbatim and skips this file, so these
 * declarations exist for tsc and editor tooling only.
 */

export interface MarkedHtmlToken {
  text: string;
}

export interface MarkedRenderer {
  html: (token: MarkedHtmlToken) => string;
}

export interface MarkedParseOptions {
  async?: false;
  breaks?: boolean;
  gfm?: boolean;
  renderer?: MarkedRenderer;
}

export interface Marked {
  Renderer: new () => MarkedRenderer;
  parse(source: string, options?: MarkedParseOptions): string;
}

export const marked: Marked;
