import type { TemplateResult } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { secureInputApi } from "../api";
import { SecureInputDialog } from "./SecureInputDialog";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("secure-input-dialog", () => {
  it("renders a native password field without binding its value into component state", () => {
    const dialog = new SecureInputDialog();
    dialog.label = "Vault Secret";
    dialog.maxBytes = 1024;

    const markup = flattenTemplate(dialog.render());

    expect(markup).toContain("password");
    expect(markup).toContain('autocomplete="off"');
    expect(markup).toContain('name="secure-input-value"');
    expect(markup).toContain("Show Vault Secret");
    expect(markup).toContain("false");
    expect(markup).not.toContain(".value=");
    expect(markup).toContain("will not be added to the chat or session transcript");
    expect(markup).not.toContain("prompt-editor");
  });

  it("reveals and hides the existing DOM value without copying it into component state", () => {
    const dialog = new SecureInputDialog();
    const input = { value: "still-only-in-the-dom", focus: vi.fn() };
    Object.defineProperty(dialog, "input", { value: input, configurable: true });

    callToggleReveal(dialog);
    expect(flattenTemplate(dialog.render())).toContain("text");
    expect(flattenTemplate(dialog.render())).toContain("Hide Secret");
    expect(flattenTemplate(dialog.render())).not.toContain(input.value);

    callToggleReveal(dialog);
    expect(flattenTemplate(dialog.render())).toContain("password");
    expect(flattenTemplate(dialog.render())).toContain("Show Secret");
    expect(flattenTemplate(dialog.render())).not.toContain(input.value);
  });

  it("closes from the receipt state after the input has left the DOM", () => {
    const dialog = new SecureInputDialog();
    const onClose = vi.fn();
    dialog.onClose = onClose;
    Object.defineProperty(dialog, "input", { value: null, configurable: true });

    callClose(dialog);

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("clears the password field before transport and zeroes transport bytes afterward", async () => {
    const dialog = new SecureInputDialog();
    const input = { value: "thư bí mật 🔒", focus: vi.fn() };
    Object.defineProperty(dialog, "input", { value: input, configurable: true });
    let submittedBytes: Uint8Array<ArrayBuffer> | undefined;
    vi.spyOn(secureInputApi, "submit").mockImplementation((bytes) => {
      submittedBytes = bytes;
      expect(input.value).toBe("");
      expect(new TextDecoder().decode(bytes)).toBe("thư bí mật 🔒");
      return Promise.resolve({ accepted: true, receiptId: "receipt-1", acceptedAt: "2026-07-14T00:00:00.000Z" });
    });

    await callSubmit(dialog);

    expect(submittedBytes).toBeDefined();
    expect(submittedBytes?.every((byte) => byte === 0)).toBe(true);
    expect(flattenTemplate(dialog.render())).not.toContain("thư bí mật");
  });
});

function callToggleReveal(dialog: SecureInputDialog): void {
  const toggle: unknown = Reflect.get(dialog, "toggleRevealInput");
  if (typeof toggle !== "function") throw new Error("SecureInputDialog.toggleRevealInput was unavailable");
  Reflect.apply(toggle, dialog, []);
}

function callClose(dialog: SecureInputDialog): void {
  const close: unknown = Reflect.get(dialog, "close");
  if (typeof close !== "function") throw new Error("SecureInputDialog.close was unavailable");
  Reflect.apply(close, dialog, []);
}

async function callSubmit(dialog: SecureInputDialog): Promise<void> {
  const submit: unknown = Reflect.get(dialog, "submit");
  if (typeof submit !== "function") throw new Error("SecureInputDialog.submit was unavailable");
  await Reflect.apply(submit, dialog, []);
}

function flattenTemplate(template: TemplateResult): string {
  let output = templateStrings(template).join("");
  for (const value of templateValues(template)) {
    if (isTemplateResult(value)) output += flattenTemplate(value);
    else if (Array.isArray(value)) {
      for (const item of value) if (isTemplateResult(item)) output += flattenTemplate(item);
    } else if (typeof value === "string" || typeof value === "number") output += String(value);
  }
  return output;
}

function templateStrings(template: TemplateResult): readonly string[] {
  const strings = Reflect.get(template, "strings");
  if (!isStringArray(strings)) throw new Error("TemplateResult strings were unavailable");
  return strings;
}

function templateValues(template: TemplateResult): readonly unknown[] {
  const values = Reflect.get(template, "values");
  if (!Array.isArray(values)) throw new Error("TemplateResult values were unavailable");
  return values;
}

function isTemplateResult(value: unknown): value is TemplateResult {
  return typeof value === "object" && value !== null && Array.isArray(Reflect.get(value, "strings"));
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
