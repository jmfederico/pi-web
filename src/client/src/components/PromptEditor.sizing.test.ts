import { describe, expect, it } from "vitest";
import { promptEditorStyles } from "./shared";

// This checks the sizing CSS contract, not rendered geometry (verified in a browser).
function declarations(selector: string): string {
  const css = promptEditorStyles.cssText.replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = css.split("}").find((candidate) => candidate.trim().startsWith(`${selector} {`));
  if (rule === undefined) throw new Error(`Missing composer sizing rule: ${selector}`);
  return rule.slice(rule.indexOf("{") + 1);
}

describe("composer input sizing", () => {
  it("reserves two lines plus padding independently of placeholder or document content", () => {
    const content = declarations(".markdown-editor .cm-content");
    expect(declarations(".markdown-editor .cm-scroller")).toContain("line-height: 1.4;");
    expect(content).toContain("min-height: 2.8em;");
    expect(content).toContain("padding: 0 52px 0 16px;");
    expect(declarations(".markdown-editor .cm-editor")).toContain("padding-block: 12px;");
  });

  it("keeps content height automatic so longer drafts can grow and shrink within the scroll cap", () => {
    const content = declarations(".markdown-editor .cm-content");
    expect(content).not.toMatch(/(?:^|;)\s*(?:height|max-height):/);
    const scroller = declarations(".markdown-editor .cm-scroller");
    expect(scroller).toContain("max-height: 196px;");
    expect(scroller).toContain("overflow-y: auto;");
  });
});
