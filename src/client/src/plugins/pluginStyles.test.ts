// @vitest-environment happy-dom
import { beforeAll, describe, expect, it } from "vitest";
import { composePluginStyles, installPluginStyleSink, setPluginStyles } from "./pluginStyles";

function flushMicrotasks(): Promise<void> {
  // Resolve is queued after any adoption microtask scheduled by attachShadow,
  // so awaiting this guarantees those ran first.
  return new Promise<void>((resolve) => {
    queueMicrotask(resolve);
  });
}

function attachRoot(): ShadowRoot {
  return document.createElement("div").attachShadow({ mode: "open" });
}

function selectors(root: DocumentOrShadowRoot): string[] {
  const found: string[] = [];
  for (const sheet of root.adoptedStyleSheets) {
    for (const rule of Array.from(sheet.cssRules)) {
      if ("selectorText" in rule && typeof rule.selectorText === "string") found.push(rule.selectorText);
    }
  }
  return found;
}

describe("composePluginStyles", () => {
  it("tags each block with its plugin id and drops blank entries", () => {
    expect(composePluginStyles([
      { pluginId: "nav", css: "nav { color: red; }" },
      { pluginId: "blank", css: "   " },
      { pluginId: "header", css: "header { color: blue; }" },
    ])).toBe("/* plugin: nav */\nnav { color: red; }\n\n/* plugin: header */\nheader { color: blue; }");
  });

  it("returns an empty string when there is nothing to apply", () => {
    expect(composePluginStyles([])).toBe("");
  });
});

describe("plugin style sink", () => {
  beforeAll(() => {
    installPluginStyleSink();
  });

  it("adopts the shared sheet into the document", () => {
    expect(document.adoptedStyleSheets.length).toBeGreaterThanOrEqual(1);
  });

  it("adopts the shared sheet into shadow roots created after install", async () => {
    setPluginStyles("app-navigation-panel { color: red; }");
    const root = attachRoot();

    expect(selectors(root)).not.toContain("app-navigation-panel");
    await flushMicrotasks();

    expect(selectors(root)).toContain("app-navigation-panel");
  });

  it("propagates later style updates live into already-adopted roots", async () => {
    const root = attachRoot();
    await flushMicrotasks();

    setPluginStyles(".plugin-added-later { color: blue; }");

    expect(selectors(root)).toContain(".plugin-added-later");
    expect(selectors(document)).toContain(".plugin-added-later");
  });

  it("keeps the shared sheet when a component reassigns adoptedStyleSheets right after attachShadow", async () => {
    setPluginStyles(".survives-lit { color: green; }");
    // Emulate Lit's createRenderRoot: attachShadow then a synchronous
    // adoptedStyleSheets assignment that would clobber an eager append.
    const own = new CSSStyleSheet();
    own.replaceSync(".component-own { color: black; }");
    const root = attachRoot();
    root.adoptedStyleSheets = [own];

    await flushMicrotasks();

    expect(selectors(root)).toEqual(expect.arrayContaining([".component-own", ".survives-lit"]));
  });
});
