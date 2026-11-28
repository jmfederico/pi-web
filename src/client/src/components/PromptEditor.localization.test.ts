// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { localization } from "../localization/browser";
import { promptEditorMessages as messages } from "../promptEditorMessages";
import { api } from "../api";
import { undo } from "@codemirror/commands";
import { PromptEditor } from "./PromptEditor";
import type { AutocompleteMenu } from "./AutocompleteMenu";
import { installPopoverFake } from "./anchoredPopup.testSupport";

installPopoverFake();

let release: (() => void) | undefined;
let stopStatusChurn: (() => void) | undefined;
afterEach(async () => {
  document.body.replaceChildren();
  release?.();
  release = undefined;
  stopStatusChurn?.();
  stopStatusChurn = undefined;
  vi.restoreAllMocks();
  await localization.setPreferences({ language: "en", formatLocale: "en" });
  localStorage.clear();
});
function required<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("Expected composer control");
  return value;
}
async function mount(): Promise<PromptEditor> {
  const editor = new PromptEditor();
  document.body.append(editor);
  await editor.updateComplete;
  return editor;
}
async function language(editor: PromptEditor, value: string): Promise<void> {
  await localization.setPreferences({ language: value, formatLocale: "ar-EG" });
  await editor.updateComplete;
  await editor.updateComplete;
}

it("updates CodeMirror hints and accessibility without replacing document, history, selection or focus", async () => {
  release = localization.registerCatalog({ id: "composer-test", namespace: "core.promptEditor", locale: "de", load: () => Promise.resolve({
    placeholder: "Schreibe / @ #", message: "Nachricht", attach: "Dateien anhängen",
  }) });
  const editor = await mount();
  editor.status = { sessionId: "test", isStreaming: true, isCompacting: false, isBashRunning: false, pendingMessageCount: 0, queuedMessages: [], tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 };
  await editor.updateComplete;
  stopStatusChurn = localization.subscribe(() => { if (editor.status) editor.status = { ...editor.status, cost: editor.status.cost + 1 }; });
  const view = required(editor.view);
  const content = view.contentDOM;
  await language(editor, "de");
  expect(content.getAttribute("aria-placeholder")).toBe("Schreibe / @ #");
  expect(content.getAttribute("data-placeholder")).toBe("Schreibe / @ #");
  expect(content.textContent).toBe("");
  editor.replaceText("Raw العربية / @ # <tag>");
  view.dispatch({ selection: { anchor: 4, head: 10 } });
  view.focus();
  const state = view.state;
  for (const locale of ["en-XA", "ar-XB", "en"]) {
    await language(editor, locale);
    expect(editor.view).toBe(view);
    expect(view.contentDOM).toBe(content);
    expect(view.state.doc).toBe(state.doc);
    expect(view.state.selection.eq(state.selection)).toBe(true);
    expect(editor.shadowRoot?.activeElement).toBe(content);
    expect(content.getAttribute("aria-label")).toBe(messages.t("message"));
    expect(content.getAttribute("aria-placeholder")).toBe(messages.t("placeholder"));
    expect(editor.shadowRoot?.querySelector(".editor-attach")?.getAttribute("aria-label")).toBe(messages.t("attach"));
  }
  stopStatusChurn();
  stopStatusChurn = undefined;
  expect(undo(view)).toBe(true);
  expect(view.state.doc.toString()).toBe("");
  expect(content.getAttribute("data-placeholder")).toBe(messages.t("placeholder"));
});

it("retains chips, draft and in-flight submission and localizes settled feedback", async () => {
  const editor = await mount();
  editor.promptChips = [{ id: "context", label: "Raw <chip>", text: "Raw plugin context", pluginId: "plugin", target: { machineId: "local", sessionId: "test" }, key: "context" }];
  editor.replaceText("Do not translate العربية");
  let finish: ((accepted: boolean) => void) | undefined;
  editor.onSend = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
  await editor.updateComplete;
  const root = required(editor.shadowRoot);
  const send = required(root.querySelector<HTMLButtonElement>(".send-button"));
  send.click();
  await editor.updateComplete;
  for (const locale of ["en-XA", "ar-XB"]) {
    await language(editor, locale);
    expect(root.querySelector(".send-button")).toBe(send);
    expect(send.disabled).toBe(true);
    expect(editor.view?.state.doc.toString()).toBe("Do not translate العربية");
    expect(root.querySelector(".prompt-chip span")?.textContent).toBe("Raw <chip>");
    expect(root.querySelector(".prompt-chip button")?.getAttribute("aria-label")).toBe(messages.t("remove", { name: "Raw <chip>" }));
  }
  required(finish)(false);
  await editor.updateComplete;
  await editor.updateComplete;
  expect(root.querySelector(".chip-error")?.textContent).toBe(messages.t("retry"));
  await language(editor, "en");
  expect(root.querySelector(".chip-error")?.textContent).toBe(messages.t("retry"));
  expect(editor.onSend).toHaveBeenCalledTimes(1);
});

it("keeps attachment capture failures live without freezing translated text", async () => {
  vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(function (this: FileReader, file: Blob) {
    if (file instanceof File && file.name === "keep.txt") {
      Object.defineProperty(this, "result", { value: "data:text/plain;base64,cmF3" });
      this.dispatchEvent(new Event("load"));
    } else this.dispatchEvent(new Event("error"));
  });
  const editor = await mount();
  const footer = required(editor.shadowRoot?.querySelector("footer"));
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { files: [new File(["raw"], "keep.txt"), new File(["bad"], "fail.txt")] } });
  footer.dispatchEvent(event);
  await editor.updateComplete;
  await editor.updateComplete;
  await vi.waitFor(() => { expect(editor.shadowRoot?.querySelector(".attachment-error")?.textContent).toBe(messages.t("readFailed")); });
  const root = required(editor.shadowRoot);
  const chip = required(root.querySelector(".attachment-chip"));
  const delivery = required(root.querySelector<HTMLSelectElement>(".attachment-delivery select"));
  delivery.focus();
  await language(editor, "ar-XB");
  expect(root.querySelector(".attachment-error")?.textContent).toBe(messages.t("readFailed"));
  expect(root.querySelector(".attachment-chip")).toBe(chip);
  expect(chip.textContent).toContain("keep.txt");
  expect(root.querySelector(".attachment-delivery select")).toBe(delivery);
  expect(root.activeElement).toBe(delivery);
  expect(delivery.value).toBe("folder");
  expect(delivery.querySelector('option[value="folder"]')?.textContent).toBe(messages.t("folder", { folder: editor.attachmentsFolder }));
});

it("localizes loaded file completion annotations without reloading or changing insertion values", async () => {
  const files = vi.spyOn(api, "files").mockResolvedValue([{ path: "raw/path.ts", kind: "tracked" }]);
  const editor = await mount();
  editor.projectId = "project";
  editor.workspaceId = "workspace";
  await editor.updateComplete;
  editor.view?.dispatch({ changes: { from: 0, insert: "@raw" }, selection: { anchor: 4 } });
  await editor.updateComplete;
  await editor.updateComplete;
  const menu = required(editor.shadowRoot?.querySelector<AutocompleteMenu>("autocomplete-menu"));
  await vi.waitFor(() => { expect(menu.items).toHaveLength(1); });
  await menu.updateComplete;
  const button = required(menu.shadowRoot?.querySelector<HTMLButtonElement>("button"));
  for (const locale of ["en-XA", "ar-XB"]) {
    await language(editor, locale);
    await menu.updateComplete;
    expect(menu.shadowRoot?.querySelector("button")).toBe(button);
    expect(button.querySelector("strong")?.textContent).toBe("@raw/path.ts");
    expect(button.querySelector(".detail")?.textContent).toBe(messages.t("fileKind", { kind: "tracked" }));
  }
  expect(files).toHaveBeenCalledTimes(1);
  button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  expect(editor.view?.state.doc.toString()).toBe("@raw/path.ts ");
});
