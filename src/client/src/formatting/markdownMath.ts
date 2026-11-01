import { renderToString } from "katex";
import type { MarkedExtension, TokenizerAndRendererExtension } from "marked";

interface MathMatch {
  raw: string;
  text: string;
  displayMode: boolean;
}

function isEscaped(source: string, index: number): boolean {
  let backslashes = 0;
  while (index > 0 && source[--index] === "\\") backslashes++;
  return backslashes % 2 === 1;
}

function matchMath(source: string): MathMatch | undefined {
  const opener = /^(\$\$|\\\[|\\\(|\$)/u.exec(source)?.[0];
  if (opener === undefined) return;
  const singleDollar = opener === "$";
  if (singleDollar && /^\s/u.test(source.slice(1))) return;
  const closer = opener === "\\(" ? "\\)" : opener === "\\[" ? "\\]" : opener;
  let end = opener.length;
  while ((end = source.indexOf(closer, end)) !== -1) {
    if (singleDollar && source.slice(1, end).includes("\n")) return;
    const validClose = !isEscaped(source, end) && (!singleDollar || (
      !/\s/u.test(source[end - 1] ?? "") && !/[\d$]/u.test(source[end + 1] ?? "")
    ));
    if (validClose) {
      const text = source.slice(opener.length, end);
      if (text.trim() === "") return;
      return { raw: source.slice(0, end + closer.length), text, displayMode: opener === "$$" || opener === "\\[" };
    }
    end += closer.length;
  }
  return;
}

function mathExtension(block: boolean): TokenizerAndRendererExtension {
  return {
    name: block ? "mathBlock" : "mathInline",
    level: block ? "block" : "inline",
    start(source) {
      return block
        ? /(?:^|\n) {0,3}(?:\$\$|\\\[)/u.exec(source)?.index
        : /\$|\\[([]/u.exec(source)?.index;
    },
    tokenizer(source) {
      const indent = block ? /^ {0,3}/u.exec(source)?.[0] ?? "" : "";
      const match = matchMath(source.slice(indent.length));
      if (match === undefined) {
        // Consume an unfinished delimiter as one literal token. In particular,
        // streaming $$...$ must not be reinterpreted as $ followed by inline math.
        const opener = /^(\$\$|\\\[|\\\()/u.exec(source)?.[0];
        return !block && opener !== undefined ? { type: "text", raw: opener, text: opener } : undefined;
      }
      if (block && !match.displayMode) return;
      let raw = indent + match.raw;
      if (block) {
        const endOfLine = /^[\t ]*(?:\n|$)/u.exec(source.slice(raw.length));
        if (endOfLine === null) return;
        raw += endOfLine[0];
      }
      return { ...match, type: block ? "mathBlock" : "mathInline", raw };
    },
    renderer(token) {
      const text: unknown = token["text"];
      if (typeof text !== "string") return false;
      // Never enable trusted TeX commands (HTML, links or external images), and
      // keep macro expansion and user-controlled dimensions bounded. Options
      // and macros are fresh for each expression, including streamed updates.
      return renderToString(text, {
        displayMode: token["displayMode"] === true,
        output: "htmlAndMathml",
        throwOnError: false,
        trust: false,
        strict: "ignore",
        maxExpand: 1000,
        maxSize: 20,
      });
    },
  };
}

// An instance-local extension: workspace previews have a separate allowlist
// sanitizer and must not inherit math markup through Marked's global defaults.
export const markdownMath: MarkedExtension = { extensions: [mathExtension(true), mathExtension(false)] };
