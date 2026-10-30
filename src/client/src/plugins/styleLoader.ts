import { ident, string, tokenize, tokenTypes, url as cssUrl } from "css-tree";
import type { PluginStylesheetLoader } from "./styleRegistry";

export interface PluginStylesheetLoaderOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly createSheet?: () => CSSStyleSheet;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  /** Bytes delivered with the document; use the same validation/compilation as fetched CSS. */
  readonly source?: (url: string) => string | undefined;
}

/** One bounded fetch/compile per registry file, never one per component. */
export function createPluginStylesheetLoader(options: PluginStylesheetLoaderOptions = {}): PluginStylesheetLoader {
  const fetchFile = options.fetch ?? globalThis.fetch.bind(globalThis);
  const createSheet = options.createSheet ?? (() => new CSSStyleSheet());
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;

  return async (url, signal) => {
    const controller = new AbortController();
    const abort = () => { controller.abort(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(() => {
      controller.abort(new Error(`Stylesheet load timed out after ${String(timeoutMs)}ms`));
    }, timeoutMs);
    try {
      controller.signal.throwIfAborted();
      // Content negotiation also keeps dev servers from returning a CSS-as-JS module.
      const sourceText = options.source?.(url);
      const response = sourceText === undefined
        ? await fetchFile(url, { signal: controller.signal, headers: { Accept: "text/css" } })
        : new Response(sourceText, { headers: { "Content-Type": "text/css" } });
      if (!response.ok) throw new Error(`Stylesheet request failed: HTTP ${String(response.status)}`);
      const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (contentType !== "text/css") throw new Error("Stylesheet response must have Content-Type text/css");
      const text = await readStylesheet(response, maxBytes, controller.signal);
      // Redirected CSS resolves assets against its final response URL, not the request URL.
      const source = resolveStylesheetAssets(text, response.url || url);
      controller.signal.throwIfAborted();
      const sheet = createSheet();
      sheet.replaceSync(source);
      return sheet;
    } catch (error) {
      // Preserve timeout/unload reasons instead of the generic fetch AbortError.
      controller.signal.throwIfAborted();
      throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      // Cancel any unread response body after a header or compilation failure.
      controller.abort();
    }
  };
}

async function readStylesheet(response: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  if (response.body === null) throw new Error("Stylesheet response has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const cancel = () => {
    // read() is released even for a stream not owned by fetch; the abort reason is
    // reported by throwIfAborted(), including when cancel itself rejects.
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error(`Stylesheet exceeds ${String(maxBytes)} bytes`);
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel();
    reader.releaseLock();
  }
}

interface Replacement { from: number; to: number; value: string }

/**
 * Tokenize rather than regex-rewrite: comments, escapes, strings, and nested functions
 * must keep their CSS meaning. This preserves unknown/new CSS syntax without a grammar
 * allowlist. URL tokens and direct image-set string candidates are the resource forms.
 */
export function resolveStylesheetAssets(source: string, baseUrl: string): string {
  const normalizedFunctions: Replacement[] = [];
  tokenize(source, (type, from, to) => {
    if (type === tokenTypes.AtKeyword && ident.decode(source.slice(from + 1, to)).toLowerCase() === "import") {
      throw new Error("Stylesheet @import is not supported; bundle imports into the contributed CSS file");
    }
    if (type === tokenTypes.Function && ident.decode(source.slice(from, to - 1)).toLowerCase() === "url") {
      // A CSS-escaped function name must receive the tokenizer's special URL handling too.
      normalizedFunctions.push({ from, to, value: "url(" });
    }
  });
  source = replaceRanges(source, normalizedFunctions);
  const replacements: Replacement[] = [];
  const contexts: string[] = [];
  tokenize(source, (type, from, to) => {
    const token = source.slice(from, to);
    if (type === tokenTypes.Function) {
      contexts.push(ident.decode(token.slice(0, -1)).toLowerCase());
    } else if (type === tokenTypes.LeftParenthesis || type === tokenTypes.LeftSquareBracket || type === tokenTypes.LeftCurlyBracket) {
      contexts.push("");
    } else if (type === tokenTypes.RightParenthesis || type === tokenTypes.RightSquareBracket || type === tokenTypes.RightCurlyBracket) {
      contexts.pop();
    } else if (type === tokenTypes.Url) {
      replacements.push({ from, to, value: cssUrl.encode(resolveResourceUrl(cssUrl.decode(token), baseUrl)) });
    } else if (type === tokenTypes.String && ["url", "image-set", "-webkit-image-set"].includes(contexts.at(-1) ?? "")) {
      replacements.push({ from, to, value: string.encode(resolveResourceUrl(string.decode(token), baseUrl)) });
    } else if (type === tokenTypes.BadUrl || type === tokenTypes.BadString) {
      throw new Error("Stylesheet contains an invalid URL or string");
    }
  });
  return replaceRanges(source, replacements);
}

function resolveResourceUrl(value: string, baseUrl: string): string {
  // Fragment-only URLs refer to local SVG resources, not the stylesheet file.
  return value.startsWith("#") ? value : new URL(value, baseUrl).href;
}

function replaceRanges(source: string, replacements: readonly Replacement[]): string {
  let result = "";
  let cursor = 0;
  for (const { from, to, value } of replacements) {
    result += source.slice(cursor, from) + value;
    cursor = to;
  }
  return result + source.slice(cursor);
}
