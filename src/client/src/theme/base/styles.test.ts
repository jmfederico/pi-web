import { generate, parse } from "css-tree";
import { describe, expect, it } from "vitest";
import * as controls from "./controlStyles";
import * as dialogs from "./dialogStyles";
import { uiFormStyles } from "./formStyles";
import { uiFileListStyles } from "./fileListStyles";
import { uiSettingsStyles } from "./settingsStyles";
import { uiNoticeStyles } from "./noticeStyles";
import { uiTranscriptStyles } from "./transcriptStyles";
import { uiTranscriptCardStyles } from "./transcriptCardStyles";
import { chatStyles } from "./chatStyles";
import { conversationLayoutStyles } from "./conversationLayoutStyles";
import { chatNavigationStyles } from "./chatNavigationStyles";
import { sidebarListStyles } from "./sidebarListStyles";
import { formattedTextStyles } from "./formattedTextStyles";
import { codeBlockFrameStyles } from "./codeBlockFrameStyles";
import { sessionNotificationTrayStyles } from "./sessionNotificationTrayStyles";
import {
  appStyles, workspacePanelStyles, listStyles, statusBarStyles,
  autocompleteStyles, promptEditorStyles, promptEditorLayoutStyles,
} from "./shellStyles";
import { baseThemeStyles } from "./styles";

describe("base theme cascade boundary", () => {
  // This protects override precedence, not rendered geometry: one accidentally
  // unlayered default would outrank selected theme rules in participating roots.
  const styles = {
    ...controls, ...dialogs, uiFormStyles, uiFileListStyles, uiSettingsStyles,
    uiNoticeStyles, uiTranscriptStyles, uiTranscriptCardStyles, chatStyles, conversationLayoutStyles,
    chatNavigationStyles, sidebarListStyles, formattedTextStyles,
    codeBlockFrameStyles, sessionNotificationTrayStyles, appStyles, workspacePanelStyles, listStyles, statusBarStyles,
    autocompleteStyles, promptEditorLayoutStyles,
  };

  it.each(Object.entries(styles))("keeps %s defaults in a single base layer", (_name, style) => {
    const ast = parse(style.cssText);
    if (ast.type !== "StyleSheet") throw new Error("Expected a stylesheet");
    expect(ast.children.size).toBeGreaterThan(0);
    ast.children.forEach((node) => {
      if (node.type === "Comment") return;
      expect(node.type).toBe("Atrule");
      if (node.type !== "Atrule") throw new Error("Unlayered base rule");
      expect(node.name).toBe("layer");
      expect(node.prelude && generate(node.prelude)).toBe("pi-web-base");
      expect(node.block?.children.size).toBeGreaterThan(0);
      // Composing another module must not create pi-web-base.pi-web-base.
      const text = node.block && generate(node.block);
      expect(text).not.toContain("@layer");
    });
  });

  it("keeps the editor integration in the same unlayered cascade as CodeMirror", () => {
    const ast = parse(promptEditorStyles.cssText);
    if (ast.type !== "StyleSheet") throw new Error("Expected a stylesheet");
    const selectors: string[] = [];
    ast.children.forEach((node) => {
      if (node.type === "Rule") selectors.push(generate(node.prelude));
    });
    expect(selectors).toContain(".markdown-editor .cm-scroller");
    expect(selectors).toContain(".markdown-editor .cm-editor");
  });

  it("wraps authored CSS without changing its selectors or declarations", () => {
    const source = ".ui-button { border-radius: 9px; }";
    expect(baseThemeStyles(source).cssText).toBe(`@layer pi-web-base { ${source} }`);
  });
});
