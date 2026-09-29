// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { html, render } from "lit";
import { renderCaptainMarkdown } from "../src/browser/markdown.js";

function markdown(source: string): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  render(renderCaptainMarkdown(html, source), container);
  return container;
}

afterEach(() => { document.body.replaceChildren(); });

describe("Captain's Log Markdown", () => {
  it("renders headings, nested lists, emphasis, quotes, and tables as semantic elements", () => {
    const view = markdown(`# Captain\n\n## Orders\n\n### Crew\n\n#### Deck\n\n##### Watch\n\n###### Bell\n\nA **bold** and *fine* ~~old~~ tale.\n\n3. First\n4. Second\n   - Nested\n\n> Steady\n\n| Port | Cargo |\n| --- | --- |\n| East | **Gold** |\n\n---`);
    expect(Array.from(view.querySelectorAll("h1,h2,h3,h4,h5,h6"), (heading) => heading.textContent)).toEqual(["Captain", "Orders", "Crew", "Deck", "Watch", "Bell"]);
    expect(view.querySelector("p strong")?.textContent).toBe("bold");
    expect(view.querySelector("em")?.textContent).toBe("fine");
    expect(view.querySelector("del")?.textContent).toBe("old");
    expect(view.querySelector("ol")?.getAttribute("start")).toBe("3");
    expect(view.querySelector("ol > li ul > li")?.textContent).toBe("Nested");
    expect(view.querySelector("blockquote p")?.textContent).toBe("Steady");
    expect(view.querySelectorAll("th")).toHaveLength(2);
    expect(view.querySelector("td strong")?.textContent).toBe("Gold");
    expect(view.querySelector("hr")).not.toBeNull();
  });

  it("preserves code text without interpreting tags, entities, Markdown, or indentation", () => {
    const code = '  <script>alert("arrr")</script>\n\t**gold** &amp; ${crew}\n\nlast  ';
    const view = markdown(`Inline \`<b> &amp; **gold**\`\n\n\`\`\`html\n${code}\n\`\`\``);
    expect(view.querySelector("p code")?.textContent).toBe("<b> &amp; **gold**");
    expect(view.querySelector("pre code")?.textContent).toBe(code);
    expect(view.querySelector("script,b")).toBeNull();
  });

  it("keeps raw HTML inert and omits image loading", () => {
    const source = '<script>alert(1)</script>\n\n<img src="https://evil.test/pixel" onerror="alert(1)">\n\n<iframe src="https://evil.test"></iframe>\n\n![Treasure](https://evil.test/image.png)\n\nInline <b onclick="alert(1)">tag</b>';
    const view = markdown(source);
    expect(view.querySelector("script,img,iframe,b")).toBeNull();
    expect(view.textContent).toContain('<script>alert(1)</script>');
    expect(view.textContent).toContain('<img src="https://evil.test/pixel" onerror="alert(1)">');
    expect(view.textContent).toContain("Treasure");
    expect(view.textContent).toContain('<b onclick="alert(1)">tag</b>');
  });

  it("only creates absolute HTTP(S) links with isolated new-tab navigation", () => {
    const view = markdown('[**Safe**](https://example.com/path?q=1#gold) [HTTP](http://example.com) <https://example.org> [Script](javascript:alert%281%29) [Data](data:text/html,hi) [Relative](/api/secrets) [Protocol-relative](//evil.test) [Mail](mailto:captain@example.com) [Encoded](jav&#x61;script:alert%281%29)');
    const links = Array.from(view.querySelectorAll("a"));
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["https://example.com/path?q=1#gold", "http://example.com/", "https://example.org/"]);
    for (const link of links) {
      expect(link.target).toBe("_blank");
      expect(link.rel.split(" ").sort()).toEqual(["noopener", "noreferrer"]);
    }
    expect(links[0]?.querySelector("strong")?.textContent).toBe("Safe");
    for (const label of ["Script", "Data", "Relative", "Protocol-relative", "Mail", "Encoded"]) expect(view.textContent).toContain(label);
  });

  it("renders reference links and task lists without interactive inputs", () => {
    const view = markdown('[Chart][map]\n\n[map]: https://example.com/chart\n\n- [x] Done\n- [ ] Next');
    expect(view.querySelector("a")?.getAttribute("href")).toBe("https://example.com/chart");
    const tasks = Array.from(view.querySelectorAll("input"));
    expect(tasks.map((task) => task.checked)).toEqual([true, false]);
    expect(tasks.every((task) => task.disabled)).toBe(true);
  });
});
