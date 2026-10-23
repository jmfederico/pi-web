// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { ChatView } from "./ChatView";
import { settleDeferredContent, useDeferredContent } from "../formatting/deferredContent.testSupport";

useDeferredContent();
import type { FormattedText } from "./FormattedText";
import { normalizeMessages } from "../chatMessages";
import { createContentRenderingService } from "../formatting/contentRendering";
import { corePlugin } from "../plugins/core";
import { PluginRegistry } from "../plugins/registry";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([false, true].flatMap((previews) => ["```text\ndisplayed\n```", "", undefined].map((displayText) => ({ previews, displayText }))))("renders display text while copying original text ($displayText, previews: $previews)", async ({ displayText, previews }) => {
  const writeText = vi.fn(() => Promise.resolve());
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  vi.stubGlobal("isSecureContext", true);
  const select = vi.fn(() => []);
  const registry = new PluginRegistry();
  await registry.register({ id: "core", plugin: corePlugin });
  const view = new ChatView();
  view.behaviors = { ...view.behaviors, codeBlocks: { ...view.behaviors.codeBlocks, previews } };
  view.contentRendering = createContentRenderingService(select);
  view.messageActions = registry.getMessageActions("local");
  view.messageActionContext = {
    machine: { id: "local", name: "Local", kind: "local" },
    session: { id: "s", cwd: "/repo", archived: false, pending: false, busy: false },
  };
  view.onDisplayedMessageAction = (input, id) => registry.runDisplayedMessageAction(id, input, () => ({
    ...input, prompt: { insertText: vi.fn(), getText: () => "", getSelection: () => null },
    navigate: vi.fn(), projects: { machineId: "local", listProjects: vi.fn(), suggestDirectories: vi.fn() },
  }));
  view.messages = normalizeMessages([{ role: "assistant", content: [
    { type: "text", text: "original", displayText },
    { type: "thinking", thinking: "original reasoning", displayText },
  ] }]);
  document.body.append(view);
  await view.updateComplete;
  const group = view.renderRoot.querySelector<HTMLDetailsElement>("details.msg");
  if (group !== null) {
    group.open = true;
    group.dispatchEvent(new Event("toggle"));
    await view.updateComplete;
  }
  const formatted = [...view.renderRoot.querySelectorAll<FormattedText>("formatted-text")];
  await settleDeferredContent(view);
  if (displayText === "") {
    expect(formatted).toHaveLength(0);
    expect(view.renderRoot.querySelector("details.part")).toBeNull();
    expect(select).not.toHaveBeenCalled();
  } else {
    expect(formatted.map((element) => element.text)).toEqual(displayText === undefined
      ? ["original reasoning", "original"] : [displayText, displayText]);
    expect(formatted.map((element) => element.renderRoot.textContent)).toEqual(displayText === undefined
      ? [expect.stringContaining("original reasoning"), expect.stringContaining("original")]
      : [expect.stringContaining("displayed"), expect.stringContaining("displayed")]);
    if (displayText !== undefined) {
      if (previews) expect(select).toHaveBeenCalledWith(expect.objectContaining({ text: "displayed" }));
      else expect(select).not.toHaveBeenCalled();
      expect(formatted.every((element) => !element.renderRoot.textContent.includes("original"))).toBe(true);
    }
  }
  expect(view.messages[0]?.parts).toEqual([
    { type: "text", text: "original", ...(displayText === undefined ? {} : { displayText }) },
    { type: "thinking", text: "original reasoning", ...(displayText === undefined ? {} : { displayText }) },
  ]);
  const copy = view.renderRoot.querySelector<HTMLButtonElement>('[aria-label="Copy assistant message"]');
  expect(copy).not.toBeNull();
  copy?.click();
  await view.updateComplete;
  expect(writeText).toHaveBeenCalledWith("original");
  await registry.dispose();
});
