// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { html } from "lit";
import { PromptEditor } from "./PromptEditor";
import { clearStagedAttachments, saveStagedAttachments } from "../promptAttachmentStaging";
import { installPopoverFake } from "./anchoredPopup.testSupport";

installPopoverFake();

beforeEach(() => {
  stubAttachSourceMedia(false);
  // CodeMirror measurement is a browser concern; keep this test on the control's native interaction.
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
});

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  clearStagedAttachments("local:appearance-controls");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("renders supplied chat navigation inside the input alongside the attachment control", async () => {
  const editor = new PromptEditor();
  const jump = vi.fn();
  editor.chatNavigation = html`<nav aria-label="Chat navigation"><button @click=${jump}>Jump to end</button></nav>`;
  document.body.append(editor);
  await editor.updateComplete;
  const navigation = editor.renderRoot.querySelector(".editor-chat-navigation");
  const attachment = editor.renderRoot.querySelector(".editor-attach");
  expect(navigation?.parentElement).toBe(attachment?.parentElement);
  const button = navigation?.querySelector("button");
  if (!button) throw new Error("Expected supplied chat navigation");
  button.click();
  expect(jump).toHaveBeenCalledOnce();
});

function stubAttachSourceMedia(matches: boolean): void {
  const media = window.matchMedia("(pointer: coarse)");
  Object.defineProperty(media, "matches", { value: matches, configurable: true });
  vi.spyOn(window, "matchMedia").mockReturnValue(media);
}

async function mountAttachmentControls() {
  const editor = new PromptEditor();
  document.body.append(editor);
  await editor.updateComplete;
  const attach = editor.renderRoot.querySelector<HTMLButtonElement>(".editor-attach");
  const panel = editor.renderRoot.querySelector<HTMLDivElement>(".attach-source-panel");
  const files = editor.renderRoot.querySelector<HTMLInputElement>(".attachment-input");
  const photos = editor.renderRoot.querySelector<HTMLInputElement>(".attachment-image-input");
  const camera = editor.renderRoot.querySelector<HTMLInputElement>(".attachment-camera-input");
  if (!attach || !panel || !files || !photos || !camera) throw new Error("Expected attachment controls");
  return { editor, attach, panel, files, photos, camera };
}

it("keeps library selection separate from the rear-camera capture preference", async () => {
  const { photos, camera, files } = await mountAttachmentControls();
  // accept and capture are native chooser hints, not guarantees of OS UI.
  expect(photos.accept).toBe("image/*");
  expect(photos.hasAttribute("capture")).toBe(false);
  expect(photos.multiple).toBe(true);
  expect(camera.accept).toBe("image/*");
  expect(camera.getAttribute("capture")).toBe("environment");
  expect(camera.multiple).toBe(false);
  expect(files.hasAttribute("accept")).toBe(false);
  expect(files.multiple).toBe(true);
});

it("opens the file dialog directly on fine-pointer devices without announcing a menu", async () => {
  const { attach, panel, files } = await mountAttachmentControls();
  const shown = vi.spyOn(panel, "showPopover");
  const open = vi.spyOn(files, "click").mockImplementation(() => undefined);
  attach.click();
  expect(open).toHaveBeenCalledOnce();
  expect(shown).not.toHaveBeenCalled();
  expect(attach.hasAttribute("aria-haspopup")).toBe(false);
  expect(attach.hasAttribute("aria-expanded")).toBe(false);
  expect(attach.hasAttribute("aria-controls")).toBe(false);
});

it("opens the touch source group and synchronously activates each native picker", async () => {
  stubAttachSourceMedia(true);
  const { editor, attach, panel, photos, camera, files } = await mountAttachmentControls();
  const items = [...panel.querySelectorAll<HTMLButtonElement>(".ui-menu-item")];
  expect(items.map((item) => item.textContent.trim())).toEqual(["Photos", "Camera", "Files"]);
  expect(panel.getAttribute("role")).toBe("group");
  expect(attach.hasAttribute("aria-haspopup")).toBe(false);
  expect(attach.getAttribute("aria-controls")).toBe(panel.id);
  const shown = vi.spyOn(panel, "showPopover");
  const hidden = vi.spyOn(panel, "hidePopover");
  for (const [index, input] of [photos, camera, files].entries()) {
    attach.click();
    await editor.updateComplete;
    expect(attach.getAttribute("aria-expanded")).toBe("true");
    expect(shown).toHaveBeenLastCalledWith({ source: attach });
    const pick = vi.spyOn(input, "click").mockImplementation(() => undefined);
    const item = items[index];
    if (!item) throw new Error("Missing source item");
    item.click();
    // Activation stays inside the click handler to preserve user activation.
    expect(pick).toHaveBeenCalledOnce();
    expect(hidden).toHaveBeenCalledTimes(index + 1);
    expect(editor.shadowRoot?.activeElement).toBe(attach);
    await editor.updateComplete;
    expect(attach.getAttribute("aria-expanded")).toBe("false");
  }
});

it("reconciles native dismissal and Escape, and can reopen", async () => {
  stubAttachSourceMedia(true);
  const { editor, attach, panel } = await mountAttachmentControls();
  attach.click(); await editor.updateComplete;
  panel.hidePopover(); await editor.updateComplete;
  expect(attach.getAttribute("aria-expanded")).toBe("false");
  attach.click(); await editor.updateComplete;
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  await editor.updateComplete;
  expect(attach.getAttribute("aria-expanded")).toBe("false");
  expect(editor.shadowRoot?.activeElement).toBe(attach);
  attach.click(); await editor.updateComplete;
  expect(attach.getAttribute("aria-expanded")).toBe("true");
});

it.each(["disabled", "sending"] as const)("closes the touch picker and disables its items when %s changes", async (property) => {
  stubAttachSourceMedia(true);
  const { editor, attach, panel, photos } = await mountAttachmentControls();
  attach.click(); await editor.updateComplete;
  const hide = vi.spyOn(panel, "hidePopover");
  const pick = vi.spyOn(photos, "click").mockImplementation(() => undefined);
  editor[property] = true;
  // Guard the event boundary even before Lit renders disabled attributes.
  panel.querySelector<HTMLButtonElement>("button")?.click();
  expect(pick).not.toHaveBeenCalled();
  await editor.updateComplete;
  expect(hide).toHaveBeenCalledOnce();
  expect(attach.getAttribute("aria-expanded")).toBe("false");
  for (const item of panel.querySelectorAll<HTMLButtonElement>("button")) {
    expect(item.disabled).toBe(true);
    item.click();
  }
  expect(pick).not.toHaveBeenCalled();
  editor[property] = false;
  await editor.updateComplete;
  expect(attach.getAttribute("aria-expanded")).toBe("false");
});

it("closes the source popup when switching sessions or removing the composer", async () => {
  stubAttachSourceMedia(true);
  const { editor, attach, panel } = await mountAttachmentControls();
  attach.click(); await editor.updateComplete;
  const hide = vi.spyOn(panel, "hidePopover");
  editor.sessionId = "another-session";
  await editor.updateComplete;
  expect(hide).toHaveBeenCalledOnce();
  expect(attach.getAttribute("aria-expanded")).toBe("false");
  attach.click(); await editor.updateComplete;
  editor.remove();
  expect(hide).toHaveBeenCalledTimes(2);
});

it.each(["photos", "camera"] as const)("stages %s selections through the existing attachment pipeline and resets the input", async (source) => {
  const controls = await mountAttachmentControls();
  const input = controls[source];
  Object.defineProperty(input, "files", { configurable: true, value: [new File(["image"], "photo.png", { type: "image/png" })] });
  input.dispatchEvent(new Event("change"));
  await vi.waitFor(() => {
    expect(controls.editor.renderRoot.querySelector(".attachment-chip")).not.toBeNull();
  });
  expect(input.value).toBe("");
});

it("keeps attachment delivery and removal wired through native shared controls", async () => {
  const key = "local:appearance-controls";
  saveStagedAttachments(key, [{ id: "image-1", kind: "image", name: "screenshot.png", mimeType: "image/png", data: "QUJD", size: 3 }]);
  const editor = new PromptEditor();
  editor.sessionId = "appearance-controls";
  document.body.append(editor);
  await editor.updateComplete;
  const delivery = editor.renderRoot.querySelector<HTMLSelectElement>('select[aria-label="Attachment delivery"]');
  const remove = editor.renderRoot.querySelector<HTMLButtonElement>('button[aria-label="Remove screenshot.png"]');
  if (delivery === null || remove === null) throw new Error("Expected pending attachment controls");
  expect(delivery.classList.contains("ui-select")).toBe(true);
  expect(remove.classList.contains("ui-button--icon")).toBe(true);
  expect(remove.type).toBe("button");
  delivery.value = "folder";
  delivery.dispatchEvent(new Event("change", { bubbles: true }));
  await editor.updateComplete;
  expect(delivery.value).toBe("folder");
  expect(localStorage.getItem("pi-web:attachment-delivery")).toBe("folder");
  remove.focus();
  expect(editor.shadowRoot?.activeElement).toBe(remove);
  remove.click();
  await editor.updateComplete;
  expect(editor.renderRoot.querySelector(".attachment-chip")).toBeNull();
});

it("removes plugin context by identity and retains the disabled contract", async () => {
  const editor = new PromptEditor();
  const chip = { id: "context", key: "context-key", pluginId: "test", target: { machineId: "local", sessionId: "appearance-controls" }, label: "Context", text: "Context content" };
  editor.promptChips = [chip];
  editor.onRemoveChip = vi.fn();
  document.body.append(editor);
  await editor.updateComplete;
  const remove = editor.renderRoot.querySelector<HTMLButtonElement>('button[aria-label="Remove Context"]');
  if (remove === null) throw new Error("Expected context removal control");
  expect(remove.classList.contains("ui-button--icon")).toBe(true);
  remove.click();
  expect(editor.onRemoveChip).toHaveBeenCalledWith(chip);
  editor.disabled = true;
  await editor.updateComplete;
  expect(remove.disabled).toBe(true);
  remove.click();
  expect(editor.onRemoveChip).toHaveBeenCalledOnce();
});

it.each(["disabled", "sending"] as const)("opens the file picker and respects the composer's %s state", async (busyProperty) => {
  const editor = new PromptEditor();
  document.body.append(editor);
  await editor.updateComplete;
  const button = editor.renderRoot.querySelector<HTMLButtonElement>('button[aria-label="Attach files"]');
  const input = editor.renderRoot.querySelector<HTMLInputElement>('input[type="file"]');
  if (button === null || input === null) throw new Error("Expected attachment controls");
  const open = vi.spyOn(input, "click").mockImplementation(() => undefined);
  expect(button.type).toBe("button");
  expect(input.multiple).toBe(true);
  button.focus();
  expect(editor.shadowRoot?.activeElement).toBe(button);
  button.click();
  expect(open).toHaveBeenCalledOnce();

  editor[busyProperty] = true;
  await editor.updateComplete;
  expect(button.disabled).toBe(true);
  button.click();
  expect(open).toHaveBeenCalledOnce();
});
