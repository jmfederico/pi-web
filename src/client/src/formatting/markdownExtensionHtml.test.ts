// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { sanitizeMarkdownExtensionHtml } from "./markdownExtensionHtml";

function sanitized(html: string, mathFixture = false): DocumentFragment {
  // happy-dom does not parse MathML namespaces. Supply correctly namespaced
  // source nodes for policy tests; actual HTML parsing is a browser check.
  if (mathFixture) {
    const source = document.createElement("template");
    source.innerHTML = html;
    const nodes = [...source.content.querySelectorAll("math, math *")];
    for (const node of nodes) {
      const math = document.createElementNS("http://www.w3.org/1998/Math/MathML", node.localName);
      for (const attribute of node.attributes) math.setAttribute(attribute.name, attribute.value);
      math.append(...node.childNodes);
      node.replaceWith(math);
    }
    Object.defineProperty(source, "innerHTML", { set() { /* prepared parser result */ } });
    vi.spyOn(document, "createElement").mockReturnValueOnce(source);
  }
  let clean: string;
  try { clean = sanitizeMarkdownExtensionHtml(html); }
  finally { vi.restoreAllMocks(); }
  const template = document.createElement("template");
  template.innerHTML = clean;
  return template.content;
}

describe("extension HTML presentation policy", () => {
  it("retains math presentation, accessibility and numeric dimension/color styles", () => {
    const output = sanitized('<span class="katex" aria-label="x squared"><span aria-hidden="true" style="height:0.8em; vertical-align:-.2em; margin-right:0.05em; color: rgb(1, 2, 3); border-bottom-width: .04em">x</span><math display="inline"><semantics><mrow><msup><mi>x</mi><mn>2</mn></msup><mspace width="0.2em"></mspace></mrow><annotation encoding="application/x-tex">x^2</annotation></semantics></math></span>', true);
    expect(output.querySelector(".katex")?.getAttribute("aria-label")).toBe("x squared");
    const html = output.querySelector("[aria-hidden]");
    expect(html?.getAttribute("style")).toContain("vertical-align: -.2em");
    expect(html?.getAttribute("style")).toContain("color: rgb(1, 2, 3)");
    expect(output.querySelector("math")?.getAttribute("display")).toBe("inline");
    expect(output.querySelector("msup")?.textContent).toBe("x2");
    expect(output.querySelector("mspace")?.getAttribute("width")).toBe("0.2em");
    expect(output.querySelector("annotation")?.textContent).toBe("x^2");
  });

  it("rejects active/resource elements, URL attributes, custom elements, comments and fence identities", () => {
    const output = sanitized('<div class="katex plain-code-block code-block-wrapper" id="collision" data-workspace-file="x" onclick="evil()"><a href="https://evil.invalid">link</a><img src="https://evil.invalid/image"><script>evil()</script><style>@import "https://evil.invalid";</style><iframe src="https://evil.invalid"></iframe><object data="https://evil.invalid"></object><video poster="https://evil.invalid"></video><form><input autofocus></form><pi-web-markdown-image src="https://evil.invalid"></pi-web-markdown-image><pre>fake fence</pre><!--fake placeholder--><span title="safe" onmouseover="evil()">kept</span></div>');
    expect(output.querySelectorAll("a, img, script, style, iframe, object, video, form, input, pi-web-markdown-image, pre")).toHaveLength(0);
    expect(output.querySelector("div")?.className).toBe("katex");
    expect(output.querySelector("[id], [onclick], [onmouseover], [data-workspace-file]")).toBeNull();
    expect(output.querySelector("span")?.textContent).toBe("kept");
    expect(output.querySelector("span")?.getAttribute("title")).toBe("safe");
    expect(output.textContent).not.toContain("evil");
    const walker = document.createTreeWalker(output, NodeFilter.SHOW_COMMENT);
    expect(walker.nextNode()).toBeNull();
  });

  it("rejects resource CSS, escaped declarations, variables, positioning modes and HTML URL attributes on MathML", () => {
    const output = sanitized('<span style="background-image:url(https://evil.invalid); width:expression(evil()); height:var(--evil); color:u\\72l(https://evil.invalid); position:fixed; z-index:999; margin-top:1em!important; padding: 1em 2px; border-color:#abc; --evil:1px; behavior:url(evil)">safe</span><math constructor="evil" href="https://evil.invalid" mathbackground="url(https://evil.invalid)" style="background:url(https://evil.invalid)"><mrow xlink:href="https://evil.invalid"><mi>x</mi></mrow><annotation-xml encoding="text/html"><img src="https://evil.invalid"></annotation-xml></math>', true);
    expect(output.querySelector("span")?.getAttribute("style")).toBe("padding: 1em 2px; border-color: #abc");
    expect(output.querySelector("math")?.attributes).toHaveLength(0);
    expect(output.querySelector("mrow")?.attributes).toHaveLength(0);
    expect(output.querySelector("annotation-xml, img")).toBeNull();
  });

  it("retains only inert SVG geometry for stretchy math glyphs, including case-sensitive viewBox", () => {
    const output = sanitized('<span class="sqrt"><svg xmlns="http://www.w3.org/2000/svg" width="400em" height="1.08em" viewBox="0 0 400000 1080" preserveAspectRatio="xMinYMin slice" focusable="false" onload="evil()"><path d="M95,702 c-2.7,0 -7.17,-2.7 -13.5,-8 L400000 40 Z" fill="currentColor"></path><use href="https://evil.invalid/glyph.svg#x"></use><image href="https://evil.invalid/image"></image><foreignObject><div>foreign</div></foreignObject><animate attributeName="href" values="https://evil.invalid"></animate><path d="M0 0L1 1" fill="url(https://evil.invalid/x)" filter="url(#x)"></path></svg></span>');
    const svg = output.querySelector("svg");
    expect(svg?.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(svg?.getAttribute("viewBox")).toBe("0 0 400000 1080");
    expect(svg?.getAttribute("preserveAspectRatio")).toBe("xMinYMin slice");
    expect(svg?.getAttribute("onload")).toBeNull();
    expect(output.querySelectorAll("path")).toHaveLength(2);
    expect(output.querySelector("path")?.getAttribute("fill")).toBe("currentColor");
    expect(output.querySelectorAll("use, image, foreignObject, animate, [href], [filter]")).toHaveLength(0);
    expect(output.querySelectorAll("path")[1]?.getAttribute("fill")).toBeNull();
  });

  it("rebuilds malformed namespace-crossing markup without admitting resources", () => {
    const html = sanitizeMarkdownExtensionHtml('<math><mtext><svg><foreignObject><style><img src=x onerror=evil()></style></foreignObject></svg></mtext></math><svg><desc><iframe src="https://evil.invalid"></iframe></desc></svg>');
    const output = sanitized(html);
    expect(output.querySelectorAll("img, style, foreignObject, iframe, [onerror], [src]")).toHaveLength(0);
    expect(sanitizeMarkdownExtensionHtml(html)).toBe(html);
  });
});
