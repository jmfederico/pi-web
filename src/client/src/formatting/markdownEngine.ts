import { Marked, Renderer, type Token, type Tokens, type TokenizerAndRendererExtension } from "marked";
import type { MarkdownExtensionContribution, MarkdownExtensionToken } from "../../../shared/markdownTypes";
import { sanitizeMarkdownExtensionHtml } from "./markdownExtensionHtml";

export interface MarkdownParseResult {
  html: string;
  codeBlocks: readonly Tokens.Code[];
}

export interface MarkdownEngine {
  /** The caller owns ordinary Markdown HTML policy, including escaping raw HTML. */
  parse(text: string, renderer: Renderer, sanitize: (html: string) => string): MarkdownParseResult;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isContribution(value: unknown): value is MarkdownExtensionContribution {
  return isRecord(value) && typeof value["id"] === "string" && value["id"].trim() !== ""
    && (value["level"] === "inline" || value["level"] === "block")
    && typeof value["start"] === "function" && typeof value["tokenize"] === "function" && typeof value["render"] === "function";
}

/** Copy and freeze the registration envelope, not plugin-owned opaque token data. */
export function snapshotMarkdownExtension(value: unknown): Readonly<MarkdownExtensionContribution> {
  if (!isContribution(value)) {
    throw new TypeError("Markdown extensions require an id, inline/block level, start, tokenize, and render functions");
  }
  return Object.freeze({
    id: value.id,
    level: value.level,
    start: value.start.bind(value),
    tokenize: value.tokenize.bind(value),
    render: value.render.bind(value),
  });
}

const MAX_MEMO_ENTRIES = 128;
const MAX_MEMO_BYTES = 1024 * 1024;

function createRenderMemo(): { get(raw: string): string | undefined; set(raw: string, html: string): void } {
  const entries = new Map<string, string>();
  let bytes = 0;
  return {
    get(raw) {
      const html = entries.get(raw);
      if (html !== undefined) {
        entries.delete(raw);
        entries.set(raw, html);
      }
      return html;
    },
    set(raw, html) {
      const size = (raw.length + html.length) * 2;
      if (size > MAX_MEMO_BYTES) return;
      while (entries.size >= MAX_MEMO_ENTRIES || bytes + size > MAX_MEMO_BYTES) {
        const oldest = entries.entries().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest[0]);
        bytes -= (oldest[0].length + oldest[1].length) * 2;
      }
      entries.set(raw, html);
      bytes += size;
    },
  };
}

function requireSynchronous(value: unknown): void {
  if (typeof value === "object" && value !== null && "then" in value) {
    // Invalid async callbacks are reported at the extension boundary below. Also
    // observe rejection so a rejected Promise cannot become an unhandled error.
    void Promise.resolve(value).catch(() => undefined);
    throw new TypeError("Markdown extension callbacks must return synchronously");
  }
}

function snapshotToken(value: unknown, source: string): Readonly<MarkdownExtensionToken> {
  requireSynchronous(value);
  if (!isRecord(value)) throw new TypeError("Expected a Markdown extension token");
  const { raw, text, data } = value;
  if (typeof raw !== "string" || raw.length === 0 || !source.startsWith(raw) || typeof text !== "string") {
    throw new TypeError("Markdown extension tokens require text and a nonempty raw prefix of the source");
  }
  return Object.freeze({ raw, text, data });
}

function restoreFragments(html: string, prefix: string, fragments: readonly string[]): string {
  if (fragments.length === 0) return html;
  const output = document.createElement("template");
  output.innerHTML = html;
  const comments = document.createTreeWalker(output.content, NodeFilter.SHOW_COMMENT);
  const replacements: { comment: Node; html: string }[] = [];
  for (let comment = comments.nextNode(); comment !== null; comment = comments.nextNode()) {
    const value = comment.nodeValue ?? "";
    if (!value.startsWith(prefix)) continue;
    const index = value.slice(prefix.length);
    if (!/^(?:0|[1-9]\d*)$/u.test(index)) continue;
    const fragment = fragments[Number(index)];
    if (fragment !== undefined) replacements.push({ comment, html: fragment });
  }
  for (const replacement of replacements) {
    const fragment = document.createElement("template");
    fragment.innerHTML = replacement.html;
    replacement.comment.parentNode?.replaceChild(fragment.content, replacement.comment);
  }
  return output.innerHTML;
}

/**
 * Isolated synchronous Markdown engine. Contributions are first-match-wins within
 * each level. Native fences, indented code, inline code, and doubled-backslash
 * escapes take priority. Other escapes remain native unless a contribution
 * explicitly claims backslash-prefixed syntax (for example a math delimiter).
 * A failed callback disables that contribution for this parse, logs its id, and
 * leaves its source for the next contribution or ordinary Markdown tokenization.
 *
 * Pure callbacks must produce the same render output for an identical raw token:
 * each extension retains an LRU of at most 128 sanitized outputs and 1 MiB of
 * raw+HTML UTF-16 payload (two bytes/code unit, excluding object overhead). Larger
 * entries are not cached. Token data is opaque, shallow-readonly, and never used
 * as a cache key. Cache lifetime is the engine's lifetime; replacing registrations
 * requires a new engine. These limits do not sandbox plugin execution or bound a
 * single callback's allocation/time. There is no per-plugin post-parse source scan.
 *
 * The caller must preserve comments through its sanitizer. Unique internal
 * comments carry already-sanitized extension fragments across that boundary;
 * restoration only replaces actual comment nodes, never attributes or text.
 * The caller's renderer/sanitizer still owns ordinary Markdown and raw HTML.
 */
export function createMarkdownEngine(extensions: readonly MarkdownExtensionContribution[] = []): MarkdownEngine {
  const contributions = extensions.map((value) => ({ extension: snapshotMarkdownExtension(value), memo: createRenderMemo() }));
  return {
    parse(text, renderer, sanitize) {
      // A fresh Marked instance keeps its mutable lexer/renderer options local to
      // this call; only bounded extension render memos survive streaming parses.
      const marked = new Marked({ gfm: true, breaks: true, async: false });
      // Marked writes parser/options onto its renderer. Copy own overrides and
      // retain subclass methods without mutating the caller's renderer instance.
      const callRenderer = Object.assign(new Renderer(), renderer);
      Object.setPrototypeOf(callRenderer, renderer);
      let renderingImage = false;
      const renderImage = renderer.image.bind(callRenderer);
      callRenderer.image = function (token) {
        const previous = renderingImage;
        renderingImage = true;
        try { return renderImage(token); }
        finally { renderingImage = previous; }
      };
      const disabled = new Set<MarkdownExtensionContribution>();
      const fragments: string[] = [];
      const tokenHtml = new WeakMap<object, string>();
      // getRandomValues, unlike randomUUID, is available on LAN HTTP origins.
      const nonce = contributions.length === 0 ? "" : [...crypto.getRandomValues(new Uint32Array(4))].join("-");
      const prefix = `pi-web-md-${nonce}:`;
      const report = (extension: MarkdownExtensionContribution, phase: string, error: unknown): void => {
        disabled.add(extension);
        console.error(`Markdown extension "${extension.id}" failed in ${phase}; using ordinary Markdown.`, error);
      };
      const adapters: TokenizerAndRendererExtension[] = (["block", "inline"] as const).map((level) => {
        const available = contributions.filter(({ extension }) => extension.level === level);
        const name = `pi-web-extension-${level}`;
        return {
          name,
          level,
          start(source) {
            let earliest: number | undefined;
            for (const { extension } of available) {
              if (disabled.has(extension)) continue;
              try {
                const index = extension.start(source);
                requireSynchronous(index);
                if (index === undefined) continue;
                if (!Number.isInteger(index) || index < 0 || index >= source.length) {
                  throw new TypeError("start must return undefined or an index within the source");
                }
                earliest = earliest === undefined ? index : Math.min(earliest, index);
              } catch (error) {
                report(extension, "start", error);
              }
            }
            return earliest;
          },
          tokenizer(source) {
            const rules = this.lexer.options.tokenizer?.rules;
            if (level === "block"
              ? rules?.block.code.test(source) === true || rules?.block.fences.test(source) === true
              : source.startsWith("\\\\") || rules?.inline.code.test(source) === true || this.lexer.state.inRawBlock) {
              return undefined;
            }
            for (const { extension, memo } of available) {
              if (disabled.has(extension)) continue;
              let phase = "tokenize";
              try {
                const value = extension.tokenize(source);
                if (value === undefined) continue;
                const token = snapshotToken(value, source);
                phase = "render";
                let html = memo.get(token.raw);
                if (html === undefined) {
                  const output = extension.render(token);
                  requireSynchronous(output);
                  if (typeof output !== "string") throw new TypeError("render must return an HTML string");
                  html = sanitizeMarkdownExtensionHtml(output);
                  memo.set(token.raw, html);
                }
                const nativeToken = { type: name, raw: token.raw, text: token.text };
                tokenHtml.set(nativeToken, html);
                return nativeToken;
              } catch (error) {
                report(extension, phase, error);
              }
            }
            return undefined;
          },
          renderer(token) {
            // Marked uses its text renderer for image alt text, but still calls
            // extension renderers there. Never emit markup/placeholders into alt.
            if (renderingImage) return typeof token["text"] === "string" ? token["text"] : token.raw;
            const html = tokenHtml.get(token);
            if (html === undefined) throw new Error("Missing host Markdown extension fragment");
            const index = fragments.push(html) - 1;
            return `<!--${prefix}${String(index)}-->`;
          },
        };
      });
      if (contributions.length > 0) marked.use({ extensions: adapters });
      const tokens = marked.lexer(text);
      const codeBlocks: Tokens.Code[] = [];
      const isNativeCode = (token: Token): token is Tokens.Code => token.type === "code";
      void marked.walkTokens(tokens, (token) => {
        if (isNativeCode(token)) codeBlocks.push(token);
      });
      const html = marked.parser(tokens, { ...marked.defaults, renderer: callRenderer });
      return { html: restoreFragments(sanitize(html), prefix, fragments), codeBlocks };
    },
  };
}

export const defaultMarkdownEngine: MarkdownEngine = createMarkdownEngine();
