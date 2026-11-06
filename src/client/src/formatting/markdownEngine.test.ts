// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { Marked, Renderer, marked } from "marked";
import type { MarkdownExtensionContribution, MarkdownExtensionToken } from "../../../shared/markdownTypes";
import { createMarkdownEngine, defaultMarkdownEngine, snapshotMarkdownExtension } from "./markdownEngine";

function extension(overrides: Partial<MarkdownExtensionContribution> = {}): MarkdownExtensionContribution {
  return {
    id: "test:math",
    level: "inline",
    start(source) {
      const index = source.indexOf("$");
      return index < 0 ? undefined : index;
    },
    tokenize(source) {
      const match = /^\$([^$\n]+)\$/u.exec(source);
      return match === null ? undefined : { raw: match[0], text: match[1] ?? "" };
    },
    render: (token) => `<span class="math">${token.text}</span>`,
    ...overrides,
  };
}

function renderer(): Renderer {
  const result = new Renderer();
  result.html = ({ text }) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return result;
}

function fragment(html: string): DocumentFragment {
  const template = document.createElement("template");
  template.innerHTML = html;
  return template.content;
}

const unchanged = (html: string): string => html;

afterEach(() => { vi.restoreAllMocks(); });

describe("Markdown engine", () => {
  it("uses one lexer and parser pass, gathers nested native fences in render order, and does not use global marked", () => {
    const lex = vi.spyOn(Marked.prototype, "lexer");
    const parse = vi.spyOn(Marked.prototype, "parser");
    const globalParse = vi.spyOn(marked, "parse");
    const globalLexer = vi.spyOn(marked, "lexer");
    const engine = createMarkdownEngine([extension()]);
    const input = "$x$\n\n```js\nfirst\n```\n\n- nested\n\n  ```ts\n  second\n  ```\n\n> ```txt\n> third\n> ```";
    const result = engine.parse(input, renderer(), unchanged);
    expect(result.codeBlocks.map((token) => [token.lang, token.text])).toEqual([["js", "first"], ["ts", "second"], ["txt", "third"]]);
    expect(fragment(result.html).querySelectorAll("pre")).toHaveLength(3);
    expect(lex).toHaveBeenCalledTimes(1);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(globalParse).not.toHaveBeenCalled();
    expect(globalLexer).not.toHaveBeenCalled();
  });

  it("keeps contributions ordered, isolated, and snapshotted, with block and inline syntax", () => {
    const first = extension({ render: () => "<b>first</b>" });
    const later = extension({ render: () => "<i>later</i>" });
    const block = extension({
      id: "test:block", level: "block",
      start: (source) => source.includes(":::note") ? source.indexOf(":::note") : undefined,
      tokenize: (source) => source.startsWith(":::note\n") ? { raw: ":::note\n", text: "note" } : undefined,
      render: () => "<div>block</div>",
    });
    const contributions = [first, later, block];
    const engine = createMarkdownEngine(contributions);
    Object.assign(first, { render: () => "mutated" });
    contributions.reverse();
    const output = fragment(engine.parse("$x$\n\n:::note\n\nend", renderer(), unchanged).html);
    expect(output.querySelector("b")?.textContent).toBe("first");
    expect(output.querySelector("i")).toBeNull();
    expect(output.querySelector("div")?.textContent).toBe("block");
    expect(createMarkdownEngine([later]).parse("$x$", renderer(), unchanged).html).toContain("later");
    expect(defaultMarkdownEngine.parse("$x$", renderer(), unchanged).html).toContain("$x$");
  });

  it("preserves native code, escaped delimiters and incomplete syntax while recognizing Markdown-contained syntax", () => {
    const engine = createMarkdownEngine([extension()]);
    const input = "`$inline$` and \\$escaped$\n\n```txt\n$fenced$\n```\n\n    $indented$\n\n**$bold$** and $unfinished";
    const output = fragment(engine.parse(input, renderer(), unchanged).html);
    expect([...output.querySelectorAll("code")].map((node) => node.textContent)).toEqual(["$inline$", "$fenced$\n", "$indented$\n"]);
    expect(output.querySelectorAll(".math")).toHaveLength(1);
    expect(output.querySelector("strong .math")?.textContent).toBe("bold");
    expect(output.textContent).toContain("$escaped$");
    expect(output.textContent).toContain("$unfinished");
  });

  it("does not let eager extensions replace native literal tokens", () => {
    const eager = extension({
      start: () => 0,
      tokenize: (source) => ({ raw: source, text: source }),
      render: () => "<span>replacement</span>",
    });
    const output = createMarkdownEngine([eager, { ...eager, level: "block" }]);
    expect(output.parse("```txt\n$x$\n```", renderer(), unchanged).codeBlocks[0]?.text).toBe("$x$");
    expect(output.parse("    $x$", renderer(), unchanged).codeBlocks[0]?.text).toBe("$x$");
    const inline = createMarkdownEngine([eager]);
    expect(inline.parse("`$x$`", renderer(), unchanged).html).toContain("<code>$x$</code>");
    expect(inline.parse(String.raw`\\`, renderer(), unchanged).html).toContain("\\");
    expect(inline.parse(String.raw`\\`, renderer(), unchanged).html).not.toContain("replacement");
  });

  it("allows explicit backslash-delimited syntax while doubled-backslash escapes remain literal", () => {
    const math = extension({
      start(source) {
        const index = source.indexOf(String.raw`\(`);
        return index < 0 ? undefined : index;
      },
      tokenize(source) {
        const end = source.indexOf(String.raw`\)`, 2);
        return source.startsWith(String.raw`\(`) && end >= 0 ? { raw: source.slice(0, end + 2), text: source.slice(2, end) } : undefined;
      },
    });
    const engine = createMarkdownEngine([math]);
    const output = fragment(engine.parse(String.raw`before \(x\) and \\(literal\\)`, renderer(), unchanged).html);
    expect(output.querySelectorAll(".math")).toHaveLength(1);
    expect(output.querySelector(".math")?.textContent).toBe("x");
    expect(output.textContent).toContain(String.raw`\(literal\)`);
  });

  it("does not mutate supplied renderer state between parses", () => {
    class CustomRenderer extends Renderer {
      override strong(): string { return "<b>custom</b>"; }
    }
    const supplied = new CustomRenderer();
    const options = supplied.options;
    const parser = supplied.parser;
    const engine = createMarkdownEngine([extension()]);
    expect(engine.parse("**text**", supplied, unchanged).html).toContain("<b>custom</b>");
    expect(supplied.options).toBe(options);
    expect(supplied.parser).toBe(parser);
    expect(engine.parse("**text**", renderer(), unchanged).html).toContain("<strong>text</strong>");
  });

  it.each([
    ["empty raw", { tokenize: () => ({ raw: "", text: "lost" }) }],
    ["non-prefix raw", { tokenize: () => ({ raw: "unrelated", text: "lost" }) }],
    ["missing text", { tokenize: () => ({ raw: "$x$" }) }],
    ["token exception", { tokenize: () => { throw new Error("broken tokenizer"); } }],
    ["async token", { tokenize: () => Promise.resolve({ raw: "$x$", text: "x" }) }],
    ["render exception", { render: () => { throw new Error("broken renderer"); } }],
    ["non-string render", { render: () => ({ html: "lost" }) }],
    ["async render", { render: () => Promise.reject(new Error("async renderer")) }],
  ])("recovers ordinary prose after %s and attributes one failure per parse", (_name, invalid) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const engine = createMarkdownEngine([snapshotMarkdownExtension({ ...extension(), ...invalid })]);
    const output = fragment(engine.parse("before $x$ **after** $x$", renderer(), unchanged).html);
    expect(output.textContent).toContain("before $x$ after $x$");
    expect(output.querySelector("strong")?.textContent).toBe("after");
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[0]).toContain('"test:math"');
  });

  it("rejects bad start hints, and lets a later contribution recover from a failed first match", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const badStart = extension({ start: () => -1, tokenize: () => undefined });
    expect(createMarkdownEngine([badStart]).parse("prose $x$", renderer(), unchanged).html).toContain("prose $x$");
    expect(error.mock.calls[0]?.[0]).toContain("start");
    const broken = extension({ render: () => { throw new Error("broken"); } });
    expect(createMarkdownEngine([broken, extension()]).parse("$x$", renderer(), unchanged).html).toContain('class="math"');
  });

  it("passes a frozen token envelope with opaque data to render", () => {
    const data = { formula: "x" };
    const render = vi.fn((token: Readonly<MarkdownExtensionToken>) => {
      expect(Object.isFrozen(token)).toBe(true);
      expect(token.data).toBe(data);
      return "<span>x</span>";
    });
    createMarkdownEngine([extension({ tokenize: () => ({ raw: "$x$", text: "x", data }), render })]).parse("$x$", renderer(), unchanged);
    expect(render).toHaveBeenCalledTimes(1);
    expect(Object.isFrozen(data)).toBe(false);
  });

  it("keeps extension presentation separate from the caller policy and leaves source HTML escaped", () => {
    const sanitize = vi.fn((html: string) => {
      const template = document.createElement("template");
      template.innerHTML = html;
      template.content.querySelectorAll("img").forEach((image) => { image.remove(); });
      template.content.querySelectorAll("a").forEach((link) => { link.setAttribute("rel", "noreferrer"); });
      template.content.querySelectorAll("[style]").forEach((node) => { node.removeAttribute("style"); });
      return template.innerHTML;
    });
    const math = extension({ render: () => '<span style="height:1em" onclick="evil()">x</span><img src="https://evil.invalid"><pre>not a fence</pre>' });
    const result = createMarkdownEngine([math]).parse('$x$ <span style="height:2em">raw</span> [link](https://example.org) ![pic](https://example.org/image.png)', renderer(), sanitize);
    const output = fragment(result.html);
    expect(sanitize).toHaveBeenCalledTimes(1);
    expect(sanitize.mock.calls[0]?.[0]).not.toContain("onclick");
    expect(output.querySelector("span")?.getAttribute("style")).toBe("height: 1em");
    expect(output.querySelector("span")?.hasAttribute("onclick")).toBe(false);
    expect(output.querySelector("a")?.getAttribute("rel")).toBe("noreferrer");
    expect(output.querySelectorAll("img, pre")).toHaveLength(0);
    expect(output.textContent).toContain('<span style="height:2em">raw</span>');
    expect(result.codeBlocks).toHaveLength(0);
  });

  it("never restores fragment placeholders into attributes or escaped text", () => {
    const engine = createMarkdownEngine([extension({ render: () => '<span title="safe">math</span>' })]);
    const output = fragment(engine.parse('![before $x$ after](https://example.org/image.png) and $x$', renderer(), unchanged).html);
    expect(output.querySelectorAll("span")).toHaveLength(1);
    expect(output.querySelector("img")?.getAttribute("title")).toBeNull();
    expect(output.querySelector("img")?.getAttribute("alt")).toBe("before x after");
    expect(output.querySelector("img")?.getAttribute("src")).toBe("https://example.org/image.png");
  });

  it("memoizes identical raw tokens across streaming parses and keeps caches engine-local", () => {
    const render = vi.fn(() => "<span>x</span>");
    const contribution = extension({ render });
    const engine = createMarkdownEngine([contribution]);
    for (const text of ["$x$", "$x$ more", "$x$ more prose $x$"]) engine.parse(text, renderer(), unchanged);
    expect(render).toHaveBeenCalledTimes(1);
    createMarkdownEngine([contribution]).parse("$x$", renderer(), unchanged);
    expect(render).toHaveBeenCalledTimes(2);
  });

  it("evicts least-recently-used render output at the entry limit", () => {
    const render = vi.fn(() => "<span>x</span>");
    const engine = createMarkdownEngine([extension({ render })]);
    for (let index = 0; index < 128; index++) engine.parse(`$${String(index)}$`, renderer(), unchanged);
    engine.parse("$0$", renderer(), unchanged);
    engine.parse("$128$", renderer(), unchanged);
    engine.parse("$0$", renderer(), unchanged);
    expect(render).toHaveBeenCalledTimes(129);
    engine.parse("$1$", renderer(), unchanged);
    expect(render).toHaveBeenCalledTimes(130);
  });

  it("bounds memoized raw plus output bytes and does not cache oversized entries", () => {
    const render = vi.fn(() => `<span>${"x".repeat(270_000)}</span>`);
    const engine = createMarkdownEngine([extension({ render })]);
    for (const text of ["$a$", "$b$", "$a$"]) engine.parse(text, renderer(), unchanged);
    expect(render).toHaveBeenCalledTimes(3);
    const hugeRaw = `$${"r".repeat(530_000)}$`;
    const smallRender = vi.fn(() => "<span>x</span>");
    const rawEngine = createMarkdownEngine([extension({ render: smallRender })]);
    rawEngine.parse(hugeRaw, renderer(), unchanged);
    rawEngine.parse(hugeRaw, renderer(), unchanged);
    expect(smallRender).toHaveBeenCalledTimes(2);
  });

  it("snapshots method identity while retaining contribution method receivers", () => {
    const contribution = {
      ...extension(),
      label: "bound",
      render() { return `<span>${this.label}</span>`; },
    };
    const snapshot = snapshotMarkdownExtension(contribution);
    contribution.render = () => "mutated";
    expect(createMarkdownEngine([snapshot]).parse("$x$", renderer(), unchanged).html).toContain("<span>bound</span>");
  });

  it("rejects malformed registration envelopes before parsing", () => {
    expect(() => snapshotMarkdownExtension({ ...extension(), level: "document" })).toThrow(TypeError);
    expect(() => snapshotMarkdownExtension({ ...extension(), render: undefined })).toThrow(TypeError);
    expect(Object.isFrozen(snapshotMarkdownExtension(extension()))).toBe(true);
  });
});
