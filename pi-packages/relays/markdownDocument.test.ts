// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { isMarkdownDocumentPath, renderRelayDocumentHtml } from "./markdownDocument";

describe("isMarkdownDocumentPath", () => {
  it("matches .md documents case-insensitively", () => {
    expect(isMarkdownDocumentPath(".pi-web/relays/r/status.md")).toBe(true);
    expect(isMarkdownDocumentPath("NOTES.MD")).toBe(true);
    expect(isMarkdownDocumentPath(".pi-web/relays/r/data.json")).toBe(false);
    expect(isMarkdownDocumentPath(".pi-web/relays/r/markdown.txt")).toBe(false);
  });
});

describe("renderRelayDocumentHtml", () => {
  it("renders GFM markdown: headings, emphasis, lists, and code fences", () => {
    const fragment = fragmentOf(renderRelayDocumentHtml([
      "# Status",
      "",
      "All **good**.",
      "",
      "- one",
      "- two",
      "",
      "```sh",
      "echo hi",
      "```",
    ].join("\n")));

    expect(fragment.querySelector("h1")?.textContent).toBe("Status");
    expect(fragment.querySelector("strong")?.textContent).toBe("good");
    expect(fragment.querySelectorAll("li")).toHaveLength(2);
    expect(fragment.querySelector("pre code")?.textContent).toContain("echo hi");
  });

  it("renders soft line breaks as <br> so plain-wrapped relay docs stay readable", () => {
    const fragment = fragmentOf(renderRelayDocumentHtml("one\ntwo"));

    expect(fragment.querySelector("p br")).not.toBeNull();
  });

  it("escapes raw HTML instead of embedding it", () => {
    const fragment = fragmentOf(renderRelayDocumentHtml("before\n\n<script>alert('xss')</script>\n\n<em>after</em>"));

    expect(fragment.querySelector("script")).toBeNull();
    expect(fragment.querySelector("em")).toBeNull();
    expect(fragment.textContent).toContain("<script>alert('xss')</script>");
  });

  it("strips javascript: URLs from links and images while keeping safe protocols", () => {
    const fragment = fragmentOf(renderRelayDocumentHtml([
      "[bad](javascript:alert('xss'))",
      "",
      "[web](https://example.com/docs)",
      "",
      "[mail](mailto:ops@example.com)",
      "",
      "[anchor](#details)",
      "",
      "![pic](javascript:alert('xss'))",
    ].join("\n")));

    const links = [...fragment.querySelectorAll("a")];
    expect(links.find((link) => link.textContent === "bad")?.hasAttribute("href")).toBe(false);
    expect(links.find((link) => link.textContent === "web")?.getAttribute("href")).toBe("https://example.com/docs");
    expect(links.find((link) => link.textContent === "mail")?.getAttribute("href")).toBe("mailto:ops@example.com");
    expect(links.find((link) => link.textContent === "anchor")?.getAttribute("href")).toBe("#details");
    expect(fragment.querySelector("img")?.hasAttribute("src")).toBe(false);
  });

  it("forces rendered links to open in a new tab without opener access", () => {
    const fragment = fragmentOf(renderRelayDocumentHtml("[docs](https://example.com)"));

    const link = fragment.querySelector("a");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noreferrer noopener");
  });

  it("wraps tables in a labeled scroll region", () => {
    const fragment = fragmentOf(renderRelayDocumentHtml("| a | b |\n| - | - |\n| 1 | 2 |"));

    const wrapper = fragment.querySelector(".table-scroll");
    expect(wrapper?.getAttribute("role")).toBe("region");
    expect(wrapper?.getAttribute("aria-label")).toBe("Table");
    expect(wrapper?.querySelector("table")).not.toBeNull();
    expect(wrapper?.querySelectorAll("td")).toHaveLength(2);
  });
});

/** Parse rendered HTML back into a fragment for assertions. */
function fragmentOf(html: string): DocumentFragment {
  const template = document.createElement("template");
  template.innerHTML = html;
  return template.content;
}
