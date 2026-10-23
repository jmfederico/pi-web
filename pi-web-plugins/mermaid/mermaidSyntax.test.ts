import { describe, expect, it, vi } from "vitest";
import { highlightMermaid, mermaidSyntaxHighlighter } from "./mermaidSyntax";

function highlight(text: string) {
  return highlightMermaid({ text, signal: new AbortController().signal });
}

function colored(text: string) {
  return highlight(text).map(({ from, to, kind }) => [text.slice(from, to), kind]);
}

describe("Mermaid lexical highlighting", () => {
  it("colors flowchart structure without interpreting node or edge prose", () => {
    const text = 'flowchart LR\nsubgraph Group\nA[graph --> 42]-->B{end?}\nB -.->|class LR| C((Done))\nend';
    expect(colored(text)).toEqual([
      ["flowchart", "keyword"], ["LR", "literal"], ["subgraph", "keyword"],
      ["[graph --> 42]", "string"], ["-->", "operator"], ["{end?}", "string"],
      ["-.->", "operator"], ["|class LR|", "string"], ["((Done))", "string"], ["end", "keyword"],
    ]);
  });

  it("keeps sequence messages and notes as prose, but colors arrows and control words", () => {
    const text = 'sequenceDiagram\nparticipant Alice as User\nAlice->>Bob: end --> 12 "quoted"\nNote over Bob: loop LR\nalt ready\nBob-->>Alice: OK\nelse retry\nend';
    expect(colored(text)).toEqual([
      ["sequenceDiagram", "keyword"], ["participant", "keyword"], ["as", "keyword"],
      ["->>", "operator"], [":", "punctuation"], [' end --> 12 "quoted"', "string"],
      ["Note", "keyword"], ["over", "keyword"], [":", "punctuation"], [" loop LR", "string"],
      ["alt", "keyword"], ["-->>", "operator"], [":", "punctuation"], [" OK", "string"],
      ["else", "keyword"], ["end", "keyword"],
    ]);
  });

  it("leaves class bodies available for member syntax and multiplicities", () => {
    const text = 'classDiagram\nclass Animal {\n+int age\n+run()\n}\nAnimal <|-- Duck\nAnimal "1" *-- "0..2" Leg';
    expect(colored(text)).toEqual([
      ["classDiagram", "keyword"], ["class", "keyword"], ["{", "punctuation"],
      ["+", "operator"], ["+", "operator"], ["(", "punctuation"], [")", "punctuation"],
      ["}", "punctuation"], ["<|--", "operator"], ['"1"', "string"], ["*--", "operator"],
      ['"0..2"', "string"],
    ]);
  });

  it("recognizes common headers and direction literals", () => {
    for (const header of ["graph", "stateDiagram", "stateDiagram-v2", "erDiagram", "gantt", "pie", "journey", "gitGraph", "mindmap", "timeline", "xychart-beta", "architecture-beta"]) {
      expect(colored(`${header}\ndirection TB`)).toEqual([
        [header, "keyword"], ["direction", "keyword"], ["TB", "literal"],
      ]);
    }
  });

  it("protects comments, multiline directives, and escaped quoted strings", () => {
    const text = '%% flowchart --> "text"\n%%{init: {\n"theme": "dark"}}%%\nclassDiagram\n"a\\" %% --> end" \'it\\\'s graph\' 12.5';
    expect(colored(text)).toEqual([
      ['%% flowchart --> "text"', "comment"], ['%%{init: {\n"theme": "dark"}}%%', "meta"],
      ["classDiagram", "keyword"], ['"a\\" %% --> end"', "string"], ["'it\\'s graph'", "string"], ["12.5", "number"],
    ]);
  });

  it("returns sorted nonoverlapping UTF-16 source ranges across CRLF and emoji", () => {
    const text = 'flowchart LR\r\n😀A[😀 end]-->B\r\n%% 😀 comment\r\n';
    const tokens = highlight(text);
    expect(tokens).toEqual([
      { from: 0, to: 9, kind: "keyword" }, { from: 10, to: 12, kind: "literal" },
      { from: text.indexOf("["), to: text.indexOf("]") + 1, kind: "string" },
      { from: text.indexOf("-->"), to: text.indexOf("-->") + 3, kind: "operator" },
      { from: text.indexOf("%%"), to: text.length - 2, kind: "comment" },
    ]);
    let end = 0;
    for (const token of tokens) {
      expect(token.from).toBeGreaterThanOrEqual(end);
      expect(token.to).toBeGreaterThan(token.from);
      expect(token.to).toBeLessThanOrEqual(text.length);
      end = token.to;
    }
  });

  it("returns only ranges for malicious-looking input without evaluating or rewriting it", () => {
    const text = 'flowchart TD\nA[<script>alert(1)</script>]-->B[<img src=x onerror=alert(2)>]\nclick A "javascript:alert(3)"';
    const tokens = highlight(text);
    expect(colored(text)).toContainEqual(["[<script>alert(1)</script>]", "string"]);
    expect(colored(text)).toContainEqual(['"javascript:alert(3)"', "string"]);
    for (const token of tokens) expect(Object.keys(token).sort()).toEqual(["from", "kind", "to"]);
  });

  it("tolerates unknown syntax and unfinished labels, strings, arrows, and directives", () => {
    expect(highlight("unrecognized words 😀")).toEqual([]);
    expect(highlight("")).toEqual([]);
    expect(colored('flowchart TD\nA[unfinished end -->\nB-->C\n"unterminated\n%%{init:')).toEqual([
      ["flowchart", "keyword"], ["TD", "literal"], ["[unfinished end -->", "string"],
      ["-->", "operator"], ['"unterminated', "string"], ["%%{init:", "meta"],
    ]);
  });

  it("honors cancellation before scanning and during a long label", () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => highlightMermaid({ text: "", signal: controller.signal })).toThrow();

    const during = new AbortController();
    const check = vi.spyOn(during.signal, "throwIfAborted");
    let checks = 0;
    check.mockImplementation(() => {
      if (++checks === 100) during.abort();
      if (during.signal.aborted) throw during.signal.reason;
    });
    try {
      expect(() => highlightMermaid({ text: `flowchart TD\nA[${"x".repeat(5000)}]`, signal: during.signal })).toThrow();
      expect(check).toHaveBeenCalledTimes(100);
    } finally {
      check.mockRestore();
    }
  });

  it("offers the standalone function as a contribution without integration side effects", () => {
    expect(mermaidSyntaxHighlighter).toEqual({
      id: "syntax", languages: ["mermaid"], fileExtensions: ["mmd", "mermaid"], highlight: highlightMermaid,
    });
  });
});
