import type { TemplateResult } from "lit";

/** A complete prefix recognized by a Markdown syntax extension. */
export interface MarkdownExtensionToken {
  readonly raw: string;
  readonly text: string;
  /** Opaque plugin-owned data; treat it as immutable. */
  readonly data?: unknown;
}

/**
 * Synchronous, deterministic syntax extension. The first matching contribution
 * in discovery/declaration order wins. Callbacks must not mutate host state.
 * Rendered output may be cached by exact raw token text for this registration:
 * identical raw text must produce identical output, independent of mutable state.
 * Callback invocation frequency is not guaranteed. Keep matching/rendering cheap;
 * synchronous callbacks cannot be interrupted.
 * Literal code is not an extension surface; use contentRenderers for fences.
 */
export interface MarkdownExtensionContribution {
  readonly id: string;
  readonly level: "inline" | "block";
  /** Earliest possible match, as a UTF-16 offset; undefined when absent. */
  start(source: string): number | undefined;
  /** Return only complete syntax at the start of source, otherwise undefined. */
  tokenize(source: string): MarkdownExtensionToken | undefined;
  /**
   * Presentation HTML, sanitized by the host; never a Promise or a DOM node.
   * Escape untrusted text. The supported presentation policy is documented at
   * https://pi-web.dev/plugins.md#presentation-html-and-styles.
   */
  render(token: Readonly<MarkdownExtensionToken>): string;
}

export interface MarkdownRenderRequest {
  readonly machineId: string;
  readonly text: string;
  readonly truncated?: boolean;
  readonly allowManualPreview?: boolean;
  /** Optional localized text for the host's document policy. Values are escaped. */
  readonly labels?: {
    readonly imageOmitted: (alt: string) => string;
    readonly table: string;
  };
}

/** Host capability { pluginId: "pi-web", id: "markdown-rendering", version: 1 }. */
export interface MarkdownRenderingCapability {
  /**
   * Deferred, visibility-gated Markdown with enabled syntax extensions and code
   * previews. Document policy escapes raw HTML, omits images and allows only safe
   * external links. Register the containing shadow root for plugin stylesheets.
   * Source remains readable if rendering fails. No parsing occurs in this call.
   */
  render(request: MarkdownRenderRequest): TemplateResult;
}
