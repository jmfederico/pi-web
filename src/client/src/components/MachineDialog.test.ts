// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { MachineDialog, machineBaseUrlValidationMessage, suggestedMachineNameFromUrl } from "./MachineDialog";
import { deepActiveElement, pressKey, requiredElement, settleRenderedDialog } from "./modalSurfaceTestSupport";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

describe("machine-dialog modal surface", () => {
  it("focuses the base URL input when opened", async () => {
    const dialog = await mountDialog();

    expect(deepActiveElement()).toBe(urlInput(dialog));
  });

  it("cancels on Escape", async () => {
    const onCancel = vi.fn<() => void>();
    const dialog = await mountDialog({ onCancel });

    pressKey(urlInput(dialog), "Escape");

    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("moves focus to the machine name on Enter in a valid base URL", async () => {
    const dialog = await mountDialog();
    const url = urlInput(dialog);
    url.value = "http://devbox.local:8504";
    url.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    await settleRenderedDialog(dialog);

    pressKey(url, "Enter");
    await settleRenderedDialog(dialog);

    expect(deepActiveElement()).toBe(nameInput(dialog));
  });
});

async function mountDialog(props: { onCancel?: () => void } = {}): Promise<MachineDialog> {
  const dialog = new MachineDialog();
  if (props.onCancel !== undefined) dialog.onCancel = props.onCancel;
  document.body.append(dialog);
  await settleRenderedDialog(dialog);
  return dialog;
}

function urlInput(dialog: MachineDialog): HTMLInputElement {
  return requiredElement(dialog.shadowRoot?.querySelector<HTMLInputElement>("input[name='baseUrl']"), "machine-dialog base URL input");
}

function nameInput(dialog: MachineDialog): HTMLInputElement {
  return requiredElement(dialog.shadowRoot?.querySelector<HTMLInputElement>("input[name='name']"), "machine-dialog name input");
}

describe("suggestedMachineNameFromUrl", () => {
  it("suggests the host without protocol or port", () => {
    expect(suggestedMachineNameFromUrl("http://127.0.0.1:8504")).toBe("127.0.0.1");
    expect(suggestedMachineNameFromUrl("https://devbox.example.test:8504/pi-web")).toBe("devbox.example.test");
  });

  it("also suggests a host while the URL protocol is being typed", () => {
    expect(suggestedMachineNameFromUrl("devbox.local:8504")).toBe("devbox.local");
  });
});

describe("machineBaseUrlValidationMessage", () => {
  it("accepts http and https base URLs", () => {
    expect(machineBaseUrlValidationMessage("http://127.0.0.1:8504")).toBeUndefined();
    expect(machineBaseUrlValidationMessage("https://devbox.example.test/pi-web")).toBeUndefined();
  });

  it("explains invalid machine URLs", () => {
    expect(machineBaseUrlValidationMessage("")).toBe("Remote PI WEB URL is required.");
    expect(machineBaseUrlValidationMessage("devbox.local:8504")).toBe("Use an http:// or https:// URL.");
    expect(machineBaseUrlValidationMessage("ftp://devbox.example.test")).toBe("Use an http:// or https:// URL.");
    expect(machineBaseUrlValidationMessage("https://user@devbox.example.test")).toBe("Do not include credentials in the machine URL.");
    expect(machineBaseUrlValidationMessage("https://devbox.example.test?q=1")).toBe("Do not include a query string or fragment.");
  });
});
