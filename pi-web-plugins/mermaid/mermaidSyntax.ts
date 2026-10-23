import type { SyntaxHighlighterContribution, SyntaxHighlightToken, SyntaxHighlightTokenKind } from "@jmfederico/pi-web/plugin-api";

const headers = new Set([
  "flowchart", "graph", "sequenceDiagram", "classDiagram", "stateDiagram", "stateDiagram-v2",
  "erDiagram", "gantt", "pie", "journey", "gitGraph", "mindmap", "timeline", "quadrantChart",
  "requirementDiagram", "C4Context", "C4Container", "C4Component", "C4Dynamic", "C4Deployment",
  "xychart-beta", "block-beta", "packet-beta", "architecture-beta", "kanban", "sankey-beta", "zenuml",
]);
const keywords = new Set([
  "subgraph", "end", "direction", "style", "classDef", "class", "click", "linkStyle",
  "participant", "actor", "as", "activate", "deactivate", "autonumber", "Note", "note",
  "over", "left", "right", "of", "loop", "alt", "else", "opt", "par", "and", "rect",
  "critical", "option", "break", "create", "destroy", "box", "links", "properties",
  "title", "accTitle", "accDescr", "section", "dateFormat", "axisFormat", "excludes",
  "includes", "todayMarker", "state", "hide", "namespace", "annotation",
  "commit", "branch", "checkout", "switch", "merge", "cherry-pick", "reset", "tag",
  "showData", "strict", "callback", "link", "cssClass", "TB", "TD", "BT", "RL", "LR",
]);
const directions = new Set(["TB", "TD", "BT", "RL", "LR"]);

/** A lexical fallback, not a Mermaid parser: unknown source stays untouched. */
export function highlightMermaid({ text, signal }: { text: string; signal: AbortSignal }): readonly SyntaxHighlightToken[] {
  signal.throwIfAborted();
  const tokens: SyntaxHighlightToken[] = [];
  const word = /[A-Za-z_]\w*(?:-\w+)*/y;
  const number = /\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  const operator = /(?:[<|o*x}]{0,2}(?:-\.+-|-+|={2,}|\.{2})(?:\|[>|]|>>?|[ox*)])?|:::{0,1}|[+=<>~])/y;
  let diagram = "";
  let lineStart = true;
  let i = 0;
  const emit = (from: number, to: number, kind: SyntaxHighlightTokenKind) => tokens.push({ from, to, kind });

  // Quotes and labels stop at a line boundary so unfinished input cannot hide later lines.
  function quotedEnd(start: number): number {
    const quote = text[start];
    let end = start + 1;
    while (end < text.length && text[end] !== "\r" && text[end] !== "\n") {
      signal.throwIfAborted();
      if (text[end] === quote) return end + 1;
      if (text[end] === "\\" && end + 1 < text.length && !/[\r\n]/u.test(text.charAt(end + 1))) end++;
      end++;
    }
    return end;
  }

  while (i < text.length) {
    signal.throwIfAborted();
    const from = i;
    const char = text.charAt(i);
    if (/\s/u.test(char)) {
      if (char === "\n" || char === "\r") lineStart = true;
      i++;
      continue;
    }
    if (text.startsWith("%%", i)) {
      const directive = text.startsWith("%%{", i);
      const close = directive ? text.indexOf("}%%", i + 3) : -1;
      if (directive) i = close < 0 ? text.length : close + 3;
      else {
        while (i < text.length && text[i] !== "\n" && text[i] !== "\r") {
          signal.throwIfAborted();
          i++;
        }
      }
      emit(from, i, directive ? "meta" : "comment");
      continue;
    }
    if (char === '"' || char === "'") {
      i = quotedEnd(i);
      emit(from, i, "string");
    } else if ((diagram === "flowchart" || diagram === "graph") && "[({|".includes(char)) {
      // Node shapes and edge labels contain prose, including keyword/arrow lookalikes.
      const closers = [char === "|" ? "|" : char === "[" ? "]" : char === "(" ? ")" : "}"];
      i++;
      while (i < text.length && text[i] !== "\n" && text[i] !== "\r" && closers.length > 0) {
        signal.throwIfAborted();
        const current = text.charAt(i);
        if (current === '"' || current === "'") i = quotedEnd(i);
        else {
          if (current === closers[closers.length - 1]) closers.pop();
          else if (char !== "|" && "[({".includes(current)) closers.push(current === "[" ? "]" : current === "(" ? ")" : "}");
          i++;
        }
      }
      emit(from, i, "string");
    } else if (diagram === "sequenceDiagram" && char === ":") {
      emit(i, ++i, "punctuation");
      const start = i;
      while (i < text.length && text[i] !== "\r" && text[i] !== "\n") {
        signal.throwIfAborted();
        i++;
      }
      if (i > start) emit(start, i, "string");
    } else {
      word.lastIndex = i;
      number.lastIndex = i;
      operator.lastIndex = i;
      const operation = operator.exec(text)?.[0];
      const identifier = operation !== undefined ? undefined : word.exec(text)?.[0];
      const numeric = operation !== undefined || identifier !== undefined ? undefined : number.exec(text)?.[0];
      if (identifier !== undefined) {
        i += identifier.length;
        if (lineStart && headers.has(identifier)) {
          diagram = identifier;
          emit(from, i, "keyword");
        } else if (directions.has(identifier)) emit(from, i, "literal");
        else if (keywords.has(identifier)) emit(from, i, "keyword");
      } else if (numeric !== undefined || operation !== undefined) {
        i += (numeric ?? operation ?? "").length;
        emit(from, i, numeric !== undefined ? "number" : "operator");
      } else {
        i++;
        if ("[](){}:;,.|".includes(char)) emit(from, i, "punctuation");
      }
    }
    lineStart = false;
  }
  signal.throwIfAborted();
  return tokens;
}

export const mermaidSyntaxHighlighter: SyntaxHighlighterContribution = {
  id: "syntax",
  languages: ["mermaid"],
  fileExtensions: ["mmd", "mermaid"],
  highlight: highlightMermaid,
};
