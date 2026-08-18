// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { renderWorkspaceMarkdownHtml, sanitizeWorkspaceMarkdownHtml } from "./workspaceMarkdown";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

describe("workspace Markdown sanitizer", () => {
  it("keeps only the generated element and attribute allowlists", () => {
    const root = parseHtml(sanitizeWorkspaceMarkdownHtml(`
      <section><strong>removed with its unknown container</strong></section>
      <p id="clobber" class="attacker" onclick="alert(1)">
        <strong data-extra="no">kept</strong>
        <a href="https://example.test/docs" title="Docs" target="_self" rel="opener" style="color:red">safe link</a>
      </p>
      <ol start="3" reversed><li value="9">third</li></ol>
      <table style="background:url(https://attacker.test/x)"><tbody><tr><td align="center" colspan="3">cell</td></tr></tbody></table>
      <svg onload="alert(1)"><a href="https://attacker.test">svg link</a></svg>
      <iframe src="https://attacker.test/frame"></iframe>
    `));

    expect(root.querySelector("section, svg, iframe")).toBeNull();
    expect(root.textContent).not.toContain("removed with its unknown container");

    const paragraph = requiredElement(root.querySelector("p"), "paragraph");
    expect([...paragraph.attributes]).toEqual([]);
    expect(requiredElement(root.querySelector("strong"), "strong element").getAttributeNames()).toEqual([]);

    const link = requiredElement(root.querySelector("a"), "safe link");
    expect(link.getAttributeNames().sort()).toEqual(["href", "referrerpolicy", "rel", "target", "title"]);
    expect(link.getAttribute("href")).toBe("https://example.test/docs");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.getAttribute("referrerpolicy")).toBe("no-referrer");

    const list = requiredElement(root.querySelector("ol"), "ordered list");
    expect(list.getAttributeNames()).toEqual(["start"]);
    expect(requiredElement(root.querySelector("li"), "list item").getAttributeNames()).toEqual([]);
    const cell = requiredElement(root.querySelector("td"), "table cell");
    expect(cell.getAttributeNames()).toEqual(["align"]);
    expect(cell.getAttribute("align")).toBe("center");
  });

  it("allows only explicit link protocols and gives every usable link a safe opener", () => {
    const root = parseHtml(sanitizeWorkspaceMarkdownHtml(`
      <p>
        <a href="https://example.test">https</a>
        <a href="HTTP://example.test">http</a>
        <a href="mailto:user@example.test">mail</a>
        <a href="javascript:alert(1)" target="_blank" rel="opener">script</a>
        <a href="data:text/html,boom">data</a>
        <a href="//example.test/path">protocol relative</a>
        <a href="/workspace/path">relative</a>
        <a href="#fragment">fragment</a>
      </p>
    `));

    for (const text of ["https", "http", "mail"]) {
      const link = linkWithText(root, text);
      expect(link.hasAttribute("href")).toBe(true);
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toBe("noopener noreferrer");
      expect(link.getAttribute("referrerpolicy")).toBe("no-referrer");
    }
    for (const text of ["script", "data", "protocol relative", "relative", "fragment"]) {
      const link = linkWithText(root, text);
      expect(link.hasAttribute("href")).toBe(false);
      expect(link.hasAttribute("target")).toBe(false);
      expect(link.hasAttribute("rel")).toBe(false);
      expect(link.hasAttribute("referrerpolicy")).toBe(false);
    }
  });

  it("escapes raw HTML and omits Markdown resources instead of loading them", () => {
    const source = `
# Safe heading

- [x] completed without a form control

<img src="https://attacker.test/raw.png" onerror="alert(1)">
<script>alert("raw")</script>
<iframe src="https://attacker.test/frame"></iframe>

![tracking pixel](https://attacker.test/tracker.png "tracker")

[click](https://example.test/docs)
`;
    const root = parseHtml(renderWorkspaceMarkdownHtml(source));

    expect(root.querySelector("h1")?.textContent).toBe("Safe heading");
    expect(root.querySelector("img, script, iframe, object, embed, svg, input, audio, video, source")).toBeNull();
    expect(root.querySelector("[src], [srcset], [poster], [style]")).toBeNull();
    expect(root.textContent).toContain("<img src=\"https://attacker.test/raw.png\" onerror=\"alert(1)\">");
    expect(root.textContent).toContain("<script>alert(\"raw\")</script>");
    expect(root.textContent).toContain("[x] completed without a form control");
    expect(root.textContent).toContain("[Image omitted: tracking pixel]");
    const link = linkWithText(root, "click");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("strips parser-generated classes and wraps tables with trusted accessibility attributes", () => {
    const root = parseHtml(renderWorkspaceMarkdownHtml(`
\`\`\`javascript
alert("shown as code")
\`\`\`

| left | centered |
| :--- | :------: |
| one  | two      |
`));

    const code = requiredElement(root.querySelector("pre code"), "code block");
    expect(code.getAttributeNames()).toEqual([]);
    const wrapper = requiredElement(root.querySelector(".table-scroll"), "table scroll region");
    expect(wrapper.tagName).toBe("DIV");
    expect(wrapper.getAttributeNames().sort()).toEqual(["aria-label", "class", "role", "tabindex"]);
    expect(wrapper.getAttribute("role")).toBe("region");
    expect(wrapper.getAttribute("aria-label")).toBe("Table");
    expect(wrapper.getAttribute("tabindex")).toBe("0");
    expect(requiredElement(wrapper.querySelector("th"), "table header").getAttribute("align")).toBe("left");
  });
});

function parseHtml(html: string): DocumentFragment {
  const template = document.createElement("template");
  template.innerHTML = html;
  return template.content;
}

function linkWithText(root: ParentNode, text: string): HTMLAnchorElement {
  const link = [...root.querySelectorAll("a")].find((candidate) => candidate.textContent === text);
  return requiredElement(link, `${text} link`);
}

function requiredElement<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`Expected ${label}`);
  return value;
}
