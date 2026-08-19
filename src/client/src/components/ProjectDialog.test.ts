// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { api, trustApi } from "../api";
import type { ProjectTrustChoice } from "../controllers/projectController";
import { ProjectDialog } from "./ProjectDialog";
import { deepActiveElement, pressKey, requiredElement, settleRenderedDialog } from "./modalSurfaceTestSupport";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
  localStorage.clear();
});

describe("project-dialog modal surface", () => {
  it("focuses the project path input when opened", async () => {
    const dialog = await mountDialog();

    expect(deepActiveElement()).toBe(pathInput(dialog));
  });

  // Regression proof for the pre-surface latent bug: the keydown listener lived
  // on the path input, so Escape with any other control focused did nothing.
  it("cancels on Escape from a control other than the path input", async () => {
    const onCancel = vi.fn<() => void>();
    const dialog = await mountDialog({ onCancel });
    const checkbox = createCheckbox(dialog);
    checkbox.focus();

    pressKey(checkbox, "Escape");

    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("submits the typed path on Enter in the path input", async () => {
    const onSubmit = vi.fn<(path: string, create: boolean, trust: ProjectTrustChoice | undefined) => void>();
    const dialog = await mountDialog({ onSubmit });
    const input = pathInput(dialog);
    input.value = "/work/new-project";
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    await settleRenderedDialog(dialog);
    await waitForTrustRead(dialog);

    pressKey(input, "Enter");

    expect(onSubmit).toHaveBeenCalledWith("/work/new-project", true, { trusted: false, changed: false });
  });

  it("disables the trust choice until a path is entered", async () => {
    const dialog = await mountDialog();

    expect(trustCheckbox(dialog).disabled).toBe(true);
  });

  it("prefills the trust choice with the existing decision for the entered path", async () => {
    const dialog = await mountDialog();
    vi.mocked(trustApi.projectTrust).mockResolvedValue({ path: "/work/proj", decision: true, trusted: true });
    const input = pathInput(dialog);
    input.value = "/work/proj";
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));

    await waitForTrustRead(dialog);

    expect(trustCheckbox(dialog).checked).toBe(true);
  });

  it("keeps an explicitly untrusted existing decision unchecked", async () => {
    const dialog = await mountDialog();
    vi.mocked(trustApi.projectTrust).mockResolvedValue({ path: "/work/proj", decision: false, trusted: false });
    const input = pathInput(dialog);
    input.value = "/work/proj";
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));

    await waitForTrustRead(dialog);

    expect(trustCheckbox(dialog).checked).toBe(false);
  });

  it("submits a flipped trust choice as a changed decision", async () => {
    const onSubmit = vi.fn<(path: string, create: boolean, trust: ProjectTrustChoice | undefined) => void>();
    const dialog = await mountDialog({ onSubmit });
    const input = pathInput(dialog);
    input.value = "/work/new-project";
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    await waitForTrustRead(dialog);
    const checkbox = trustCheckbox(dialog);
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    await settleRenderedDialog(dialog);

    pressKey(input, "Enter");

    expect(onSubmit).toHaveBeenCalledWith("/work/new-project", true, { trusted: true, changed: true });
  });

  // Regression: the suggestions and trust loaders used to share one staleness
  // counter, so the trust read fired on every keystroke discarded the in-flight
  // suggestions request and the loading hint never cleared.
  it("renders folder suggestions and clears the loading hint after typing a path", async () => {
    const dialog = await mountDialog();
    vi.mocked(api.projectDirectories).mockResolvedValue([{ path: "/work/proj/", kind: "other" }]);
    const input = pathInput(dialog);
    input.value = "/work/proj";
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));

    await vi.waitFor(() => {
      expect(dialog.shadowRoot?.querySelectorAll(".suggestions button").length).toBe(1);
    });
    await settleRenderedDialog(dialog);

    expect(dialog.shadowRoot?.querySelector(".suggestions button")?.textContent).toContain("/work/proj/");
    expect(dialog.shadowRoot?.textContent).not.toContain("Loading folders…");
  });

  it("keeps showing folder suggestions while a slower trust read is still in flight", async () => {
    const dialog = await mountDialog();
    vi.mocked(api.projectDirectories).mockResolvedValue([{ path: "/work/proj/", kind: "other" }]);
    let resolveTrust: ((value: { path: string; decision: boolean | null; trusted: boolean }) => void) | undefined;
    vi.mocked(trustApi.projectTrust).mockReturnValue(new Promise((resolve) => { resolveTrust = resolve; }));
    const input = pathInput(dialog);
    input.value = "/work/proj";
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));

    await vi.waitFor(() => {
      expect(dialog.shadowRoot?.querySelectorAll(".suggestions button").length).toBe(1);
    });
    resolveTrust?.({ path: "/work/proj", decision: null, trusted: false });
    await settleRenderedDialog(dialog);

    expect(dialog.shadowRoot?.textContent).not.toContain("Loading folders…");
  });

  it("explains what trusting a project means and links to the project-trust documentation", async () => {
    const dialog = await mountDialog();

    const hint = dialog.shadowRoot?.querySelector<HTMLElement>(".trust-hint");
    expect(hint).not.toBeNull();
    expect(hint?.textContent).toContain(".pi settings");
    expect(hint?.textContent).toContain("extensions");
    expect(hint?.textContent).toContain("skills");
    expect(hint?.textContent).toContain("packages");
    // The explanation stays short and links to the docs instead of being verbose.
    const link = hint?.querySelector<HTMLAnchorElement>("a");
    expect(link?.getAttribute("href")).toBe("https://pi.dev/docs/latest/security");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noreferrer");
    expect(link?.textContent).toBe("Learn about project trust");
  });
});

interface ProjectDialogProps {
  onSubmit?: (path: string, create: boolean, trust: ProjectTrustChoice | undefined) => void;
  onCancel?: () => void;
}

async function mountDialog(props: ProjectDialogProps = {}): Promise<ProjectDialog> {
  vi.spyOn(api, "projectDirectories").mockResolvedValue([]);
  vi.spyOn(trustApi, "projectTrust").mockResolvedValue({ path: "", decision: null, trusted: false });
  const dialog = new ProjectDialog();
  if (props.onSubmit !== undefined) dialog.onSubmit = props.onSubmit;
  if (props.onCancel !== undefined) dialog.onCancel = props.onCancel;
  document.body.append(dialog);
  await settleRenderedDialog(dialog);
  return dialog;
}

/** Waits until the trust read for the current path has resolved and rendered. */
async function waitForTrustRead(dialog: ProjectDialog): Promise<void> {
  await vi.waitFor(() => { expect(trustCheckbox(dialog).disabled).toBe(false); });
  await settleRenderedDialog(dialog);
}

function pathInput(dialog: ProjectDialog): HTMLInputElement {
  return requiredElement(dialog.shadowRoot?.querySelector<HTMLInputElement>("label input"), "project-dialog path input");
}

function createCheckbox(dialog: ProjectDialog): HTMLInputElement {
  return requiredElement(dialog.shadowRoot?.querySelector<HTMLInputElement>("input[type='checkbox']"), "project-dialog create checkbox");
}

/** The trust choice checkbox: the second of the two checkboxes the dialog renders. */
function trustCheckbox(dialog: ProjectDialog): HTMLInputElement {
  const checkbox = dialog.shadowRoot?.querySelectorAll<HTMLInputElement>("input[type='checkbox']")[1];
  return requiredElement(checkbox, "project-dialog trust checkbox");
}
