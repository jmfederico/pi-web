// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandOption, SessionModelCatalogEntry } from "../api";
import { deepActiveElement, dialogSurface, pressKey, requiredElement, settleRenderedDialog } from "./modalSurfaceTestSupport";
import { ModelPicker } from "./ModelPicker";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

describe("model-picker Enabled mode", () => {
  it("opens in Enabled mode with the search input focused and the current model preselected", async () => {
    const picker = await mountPicker({ selectedValue: "anthropic/claude-sonnet-4-5" });

    expect(deepActiveElement()).toBe(searchInput(picker));
    expect(scopeToggle(picker, "Enabled").getAttribute("aria-pressed")).toBe("true");
    expect(scopeToggle(picker, "All models").getAttribute("aria-pressed")).toBe("false");
    expect(enabledRows(picker).map((row) => rowLabel(row))).toEqual(["gpt-5", "claude-sonnet-4-5"]);
    expect(selectedRowText(picker)).toContain("claude-sonnet-4-5");
  });

  it("keeps arrow navigation, Enter picking, and search filtering on the enabled list", async () => {
    const onPick = vi.fn<(value: string) => void>();
    const picker = await mountPicker({ onPick });

    pressKey(dialogSurface(picker), "ArrowDown");
    await settleRenderedDialog(picker);
    expect(selectedRowText(picker)).toContain("claude-sonnet-4-5");

    pressKey(searchInput(picker), "ArrowUp");
    await settleRenderedDialog(picker);
    pressKey(searchInput(picker), "Enter");
    expect(onPick).toHaveBeenCalledWith("openai/gpt-5");

    typeSearch(picker, "claude");
    await settleRenderedDialog(picker);
    expect(enabledRows(picker).map((row) => rowLabel(row))).toEqual(["claude-sonnet-4-5"]);
  });

  it("cancels on Escape", async () => {
    const onCancel = vi.fn<() => void>();
    const picker = await mountPicker({ onCancel });

    pressKey(dialogSurface(picker), "Escape");

    expect(onCancel).toHaveBeenCalledOnce();
  });
});

describe("model-picker All models mode", () => {
  it("lists the catalog enabled-first with group headers and per-row membership checkboxes", async () => {
    const picker = await mountPicker();

    scopeToggle(picker, "All models").click();
    await settleRenderedDialog(picker);

    expect(catalogRows(picker).map((row) => rowValue(row))).toEqual([
      "openai/gpt-5",
      "anthropic/claude-sonnet-4-5",
      "openai/gpt-4o",
      "google/gemini-2.5-pro",
    ]);
    expect(catalogRows(picker).map((row) => rowCheckbox(row).checked)).toEqual([true, true, false, false]);
    expect(groupHeaders(picker)).toEqual(["Enabled", "Other models"]);
  });

  it("marks the current model and selects it when switching modes", async () => {
    const picker = await mountPicker({ selectedValue: "openai/gpt-4o" });

    scopeToggle(picker, "All models").click();
    await settleRenderedDialog(picker);

    const current = requiredElement(catalogRows(picker).find((row) => row.classList.contains("selected")), "selected catalog row");
    expect(rowValue(current)).toBe("openai/gpt-4o");
    expect(current.textContent).toContain("✓ current");
  });

  it("requests a membership toggle from a row checkbox without picking or closing", async () => {
    const onPick = vi.fn<(value: string) => void>();
    let toggleApplied: (() => void) | undefined;
    const onToggleEnabled = vi.fn(() => new Promise<void>((resolve) => { toggleApplied = () => { resolve(); }; }));
    const picker = await mountPicker({ onPick, onToggleEnabled });
    scopeToggle(picker, "All models").click();
    await settleRenderedDialog(picker);

    const gpt4oRow = catalogRow(picker, "openai/gpt-4o");
    const checkbox = rowCheckbox(gpt4oRow);
    checkbox.click();
    await settleRenderedDialog(picker);

    expect(onToggleEnabled).toHaveBeenCalledWith("openai", "gpt-4o", true);
    expect(onPick).not.toHaveBeenCalled();
    // The controlled checkbox keeps reflecting the catalog and waits for the host.
    expect(checkbox.checked).toBe(false);
    expect(checkbox.disabled).toBe(true);

    // The host applies the fresh catalog, then resolves the toggle.
    picker.catalog = [
      entry("openai", "gpt-5", true),
      entry("anthropic", "claude-sonnet-4-5", true),
      entry("openai", "gpt-4o", true),
      entry("google", "gemini-2.5-pro", false),
    ];
    toggleApplied?.();
    await settleRenderedDialog(picker);

    const updated = rowCheckbox(catalogRow(picker, "openai/gpt-4o"));
    expect(updated.checked).toBe(true);
    expect(updated.disabled).toBe(false);
  });

  it("keeps the checkbox state when the toggle fails", async () => {
    const onToggleEnabled = vi.fn<() => Promise<void>>(() => Promise.resolve());
    const picker = await mountPicker({ onToggleEnabled });
    scopeToggle(picker, "All models").click();
    await settleRenderedDialog(picker);

    const checkbox = rowCheckbox(catalogRow(picker, "openai/gpt-4o"));
    checkbox.click();
    expect(onToggleEnabled).toHaveBeenCalledOnce();

    // The host reported the failure and left the catalog unchanged; the row
    // becomes interactive again with its membership untouched.
    await vi.waitFor(() => {
      const settled = rowCheckbox(catalogRow(picker, "openai/gpt-4o"));
      expect(settled.disabled).toBe(false);
    });
    expect(rowCheckbox(catalogRow(picker, "openai/gpt-4o")).checked).toBe(false);
  });

  it("filters the catalog by search and hides group headers while searching", async () => {
    const picker = await mountPicker();
    scopeToggle(picker, "All models").click();
    await settleRenderedDialog(picker);

    typeSearch(picker, "GPT");
    await settleRenderedDialog(picker);

    expect(catalogRows(picker).map((row) => rowValue(row))).toEqual(["openai/gpt-5", "openai/gpt-4o"]);
    expect(groupHeaders(picker)).toEqual([]);
  });

  it("picks a model by row click and by Enter, leaving pick behavior unchanged", async () => {
    const onPick = vi.fn<(value: string) => void>();
    const picker = await mountPicker({ onPick });
    scopeToggle(picker, "All models").click();
    await settleRenderedDialog(picker);

    pickButton(catalogRow(picker, "google/gemini-2.5-pro")).click();
    expect(onPick).toHaveBeenCalledWith("google/gemini-2.5-pro");

    pressKey(searchInput(picker), "ArrowDown");
    pressKey(searchInput(picker), "ArrowDown");
    await settleRenderedDialog(picker);
    pressKey(searchInput(picker), "Enter");
    expect(onPick).toHaveBeenLastCalledWith("openai/gpt-4o");
  });

  it("toggles the selected row with Space, but lets the search input keep its spaces", async () => {
    const onToggleEnabled = vi.fn<() => Promise<void>>(() => Promise.resolve());
    const picker = await mountPicker({ onToggleEnabled });
    scopeToggle(picker, "All models").click();
    await settleRenderedDialog(picker);

    pressKey(searchInput(picker), " ");
    expect(onToggleEnabled).not.toHaveBeenCalled();

    pressKey(optionsList(picker), " ");
    expect(onToggleEnabled).toHaveBeenCalledWith("openai", "gpt-5", false);
  });

  it("keeps the selection anchored to the same row when a toggle regroups the catalog", async () => {
    const picker = await mountPicker();
    scopeToggle(picker, "All models").click();
    await settleRenderedDialog(picker);
    pressKey(optionsList(picker), "ArrowDown");
    pressKey(optionsList(picker), "ArrowDown");
    pressKey(optionsList(picker), "ArrowDown");
    await settleRenderedDialog(picker);
    expect(rowValue(requiredElement(catalogRows(picker).find((row) => row.classList.contains("selected")), "selected row"))).toBe("google/gemini-2.5-pro");

    picker.catalog = [
      entry("openai", "gpt-5", true),
      entry("anthropic", "claude-sonnet-4-5", true),
      entry("google", "gemini-2.5-pro", true),
      entry("openai", "gpt-4o", false),
    ];
    await settleRenderedDialog(picker);

    const selected = requiredElement(catalogRows(picker).find((row) => row.classList.contains("selected")), "selected row");
    expect(rowValue(selected)).toBe("google/gemini-2.5-pro");
  });
});

interface ModelPickerProps {
  title?: string;
  options?: CommandOption[];
  catalog?: SessionModelCatalogEntry[];
  selectedValue?: string;
  onPick?: (value: string) => void;
  onCancel?: () => void;
  onToggleEnabled?: (provider: string, modelId: string, enabled: boolean) => Promise<void>;
}

function entry(provider: string, id: string, enabled: boolean, name?: string): SessionModelCatalogEntry {
  return { provider, id, enabled, ...(name === undefined ? {} : { name }) };
}

function defaultCatalog(): SessionModelCatalogEntry[] {
  return [
    entry("openai", "gpt-5", true),
    entry("anthropic", "claude-sonnet-4-5", true),
    entry("openai", "gpt-4o", false),
    entry("google", "gemini-2.5-pro", false),
  ];
}

async function mountPicker(props: ModelPickerProps = {}): Promise<ModelPicker> {
  const picker = new ModelPicker();
  picker.options = props.options ?? [
    { value: "openai/gpt-5", label: "gpt-5", description: "openai" },
    { value: "anthropic/claude-sonnet-4-5", label: "claude-sonnet-4-5", description: "anthropic" },
  ];
  picker.catalog = props.catalog ?? defaultCatalog();
  if (props.selectedValue !== undefined) picker.selectedValue = props.selectedValue;
  if (props.onPick !== undefined) picker.onPick = props.onPick;
  if (props.onCancel !== undefined) picker.onCancel = props.onCancel;
  if (props.onToggleEnabled !== undefined) picker.onToggleEnabled = props.onToggleEnabled;
  document.body.append(picker);
  await settleRenderedDialog(picker);
  return picker;
}

function searchInput(picker: ModelPicker): HTMLInputElement {
  return requiredElement(picker.shadowRoot?.querySelector<HTMLInputElement>("input.search"), "model-picker search input");
}

function optionsList(picker: ModelPicker): HTMLElement {
  return requiredElement(picker.shadowRoot?.querySelector<HTMLElement>(".options"), "model-picker options list");
}

function scopeToggle(picker: ModelPicker, label: string): HTMLButtonElement {
  const button = [...(picker.shadowRoot?.querySelectorAll<HTMLButtonElement>(".scope-toggle button") ?? [])]
    .find((candidate) => candidate.textContent.trim() === label);
  return requiredElement(button, `model-picker ${label} scope toggle`);
}

function enabledRows(picker: ModelPicker): HTMLButtonElement[] {
  return [...(picker.shadowRoot?.querySelectorAll<HTMLButtonElement>(".options > button") ?? [])];
}

function catalogRows(picker: ModelPicker): HTMLElement[] {
  return [...(picker.shadowRoot?.querySelectorAll<HTMLElement>(".catalog-row") ?? [])];
}

function catalogRow(picker: ModelPicker, value: string): HTMLElement {
  const row = catalogRows(picker).find((candidate) => rowValue(candidate) === value);
  return requiredElement(row, `model-picker catalog row ${value}`);
}

function rowValue(row: HTMLElement): string {
  const label = requiredElement(row.querySelector<HTMLInputElement>("input[type='checkbox']"), "catalog row checkbox").getAttribute("aria-label") ?? "";
  return label.replace(/^(Enable|Disable) /, "");
}

function rowCheckbox(row: HTMLElement): HTMLInputElement {
  return requiredElement(row.querySelector<HTMLInputElement>("input[type='checkbox']"), "catalog row checkbox");
}

function pickButton(row: HTMLElement): HTMLButtonElement {
  return requiredElement(row.querySelector<HTMLButtonElement>("button.pick"), "catalog row pick button");
}

function groupHeaders(picker: ModelPicker): string[] {
  return [...(picker.shadowRoot?.querySelectorAll<HTMLElement>(".group-header") ?? [])].map((header) => header.textContent.trim());
}

function selectedRowText(picker: ModelPicker): string {
  const selected = picker.shadowRoot?.querySelector<HTMLElement>(".options > button.selected, .catalog-row.selected");
  return requiredElement(selected, "selected model row").textContent;
}

function rowLabel(row: HTMLElement): string {
  return requiredElement(row.querySelector<HTMLElement>("span"), "row label").textContent;
}

function typeSearch(picker: ModelPicker, query: string): void {
  const input = searchInput(picker);
  input.value = query;
  input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
}
