import { generate, parse, walk } from "css-tree";
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

  // The two-column workspace view clips its content-height main column, so an
  // absolutely positioned top chrome leaves the layout along with the only tab
  // strip that layout has. This guards the clip, not the cascade above.
  it("keeps the floating top chrome in flow over the two-column workspace view", () => {
    const ast = parse(appStyles.cssText);
    const declarations = new Map<string, string>();
    walk(ast, (node) => {
      if (node.type !== "Rule") return;
      if (generate(node.prelude).trim() !== ".shell.two-column-layout.workspace-view main .top-chrome") return;
      node.block.children.forEach((child) => {
        if (child.type === "Declaration") declarations.set(child.property, generate(child.value).trim());
      });
    });
    expect(declarations.get("position")).toBe("static");
  });

  // Session warnings and notifications are chrome, not transcript content: they
  // must sit inside the auto-hiding top chrome, or a visible app bar covers their
  // controls and shifts every sticky transcript header down with them.
  it("keeps session warnings and notifications in the shell's top chrome", () => {
    const shellSelectors = selectorsOf(appStyles);
    const chatSelectors = selectorsOf(chatStyles);

    expect(shellSelectors).toContain(".top-notices");
    expect(shellSelectors).toContain(".session-warnings");
    expect(shellSelectors).toContain(".session-warning");
    expect(chatSelectors).not.toContain(".top-notices");
    expect(chatSelectors).not.toContain(".session-warnings");
  });

  // The transcript scrolls under the floating chrome. Its scrollbar must stay
  // visible beside the composer instead of disappearing beneath it.
  it("stops the floating chrome where the transcript reserves its scrollbar", () => {
    expect(declarationsOf(appStyles, "main .top-chrome").get("right")).toBe("var(--pi-chat-scrollbar-gutter, 0px)");
    // The bottom chrome lives in the conversation boundary, which floats over the transcript.
    expect(declarationsOf(conversationLayoutStyles, ".bottom-chrome.floating").get("inset-inline-end")).toBe("var(--pi-chat-scrollbar-gutter, 0px)");
  });

  // A stuck header parks directly below the chrome while it is shown and at the screen
  // edge once it slides away. The offset counts from the scroller's padded content start,
  // so adding the chrome inset back parks every header one chrome too low.
  it("parks sticky transcript headers against the visible chrome edge", () => {
    const chat = declarationsOf(chatStyles, ".chat");
    const stickyTop = chat.get("--pi-chat-sticky-top") ?? "";

    expect(chat.get("scrollbar-gutter")).toBe("stable");
    expect(chat.get("padding") ?? "").toContain("--pi-chat-top-inset");
    expect(stickyTop).toContain("--pi-chat-hidden-sticky-shift");
    expect(stickyTop).not.toContain("--pi-chat-top-inset");
  });

  // Every transcript header kind - group summaries and the message, ask-user and
  // extension-dialog cards - shares both the park offset and one effects switch, so a
  // new header cannot drift to its own offset and a reduced-effects transcript stops
  // all of them together.
  it("gives every transcript header the shared park offset and effects switch", () => {
    expect(declarationsOf(chatStyles, ".chat-wrap.plain").get("--pi-chat-sticky-header-position")).toBe("static");
    const headerKinds = [
      { styles: chatStyles, selector: ".msg.event-group>summary" },
      { styles: uiTranscriptCardStyles, selector: ".ui-transcript-card-header" },
    ];
    for (const header of headerKinds) {
      expect(declarationsOf(header.styles, header.selector).get("position")).toBe("var(--pi-chat-sticky-header-position, sticky)");
      expect(declarationsOf(header.styles, header.selector).get("top")).toBe("var(--pi-chat-sticky-top, 0px)");
    }
  });
});

function selectorsOf(style: { cssText: string }): string[] {
  const selectors: string[] = [];
  walk(parse(style.cssText), (node) => {
    if (node.type !== "Rule") return;
    selectors.push(generate(node.prelude).trim());
  });
  return selectors;
}

function declarationsOf(style: { cssText: string }, selector: string): Map<string, string> {
  const declarations = new Map<string, string>();
  walk(parse(style.cssText), (node) => {
    if (node.type !== "Rule") return;
    if (generate(node.prelude).trim() !== selector) return;
    node.block.children.forEach((child) => {
      if (child.type === "Declaration") declarations.set(child.property, generate(child.value).trim());
    });
  });
  return declarations;
}
