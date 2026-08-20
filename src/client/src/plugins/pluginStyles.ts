import type { PluginStyleEntry } from "./types";

/**
 * Host-side sink for the `styles` plugin contribution.
 *
 * PI WEB is built from many web components, each with its own shadow root. CSS
 * custom properties (theme tokens) inherit across shadow boundaries, but
 * ordinary style rules do not — a single document-level stylesheet cannot reach
 * `app-navigation-panel`, `chat-view`, or any other component's internals. So a
 * plugin that wanted to restyle the host UI previously had to patch
 * `Element.prototype.attachShadow` itself and inject a `<style>` into every
 * shadow root. This module does that once, in the host, so plugins can simply
 * return CSS strings.
 *
 * Mechanism: a single constructable stylesheet (the "shared sheet") is adopted
 * into the document and into every shadow root as it is created, via a one-time
 * patch of `attachShadow` installed before any component mounts. Plugin CSS is
 * written into that sheet with `replaceSync`, so updates propagate live to
 * every root that already adopted it — no per-root bookkeeping needed.
 */

let sharedSheet: CSSStyleSheet | undefined;
let attachShadowPatched = false;

function constructableStyleSheetsSupported(): boolean {
  return (
    typeof CSSStyleSheet === "function"
    && typeof CSSStyleSheet.prototype.replaceSync === "function"
    && typeof Document !== "undefined"
    && "adoptedStyleSheets" in Document.prototype
  );
}

function ensureSharedSheet(): CSSStyleSheet | undefined {
  if (sharedSheet !== undefined) return sharedSheet;
  if (!constructableStyleSheetsSupported()) return undefined;
  sharedSheet = new CSSStyleSheet();
  return sharedSheet;
}

function adoptInto(root: DocumentOrShadowRoot): void {
  const sheet = sharedSheet;
  if (sheet === undefined) return;
  const current = root.adoptedStyleSheets;
  if (current.includes(sheet)) return;
  root.adoptedStyleSheets = [...current, sheet];
}

/**
 * Install the plugin style sink. Idempotent, but must run before any PI WEB
 * component mounts (import it first in the client entrypoint) so the
 * `attachShadow` patch is in place when the first shadow roots are created —
 * there is no way to retroactively reach shadow roots we never saw created.
 */
export function installPluginStyleSink(): void {
  const sheet = ensureSharedSheet();
  if (sheet === undefined) return;
  adoptInto(document);
  if (attachShadowPatched) return;
  attachShadowPatched = true;
  // Capture the platform implementation so the patch can re-invoke it with the
  // element as `this`. It is intentionally an unbound reference.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const originalAttachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function attachShadow(init: ShadowRootInit): ShadowRoot {
    const root = originalAttachShadow.call(this, init);
    // Adopt after the current synchronous work finishes. Lit assigns
    // `renderRoot.adoptedStyleSheets` in `createRenderRoot()` right after
    // calling `attachShadow`, so appending now would be clobbered; a microtask
    // runs after that assignment yet still before paint, so there is no flash.
    queueMicrotask(() => {
      adoptInto(root);
    });
    return root;
  };
}

/**
 * Replace the plugin CSS applied across the app. Pass the composed CSS from all
 * `styles` contributions; an empty string clears it. Safe to call repeatedly —
 * every shadow root shares the same sheet, so the change is reflected instantly.
 */
export function setPluginStyles(css: string): void {
  const sheet = ensureSharedSheet();
  if (sheet === undefined) return;
  try {
    sheet.replaceSync(css);
  } catch (error) {
    console.warn("Failed to apply PI WEB plugin styles", error);
  }
}

/**
 * Concatenate `styles` contributions into a single stylesheet source, tagging
 * each block with its plugin id so the applied CSS is debuggable in devtools.
 */
export function composePluginStyles(entries: readonly PluginStyleEntry[]): string {
  return entries
    .filter((entry) => typeof entry.css === "string" && entry.css.trim() !== "")
    .map((entry) => `/* plugin: ${entry.pluginId} */\n${entry.css}`)
    .join("\n\n");
}
