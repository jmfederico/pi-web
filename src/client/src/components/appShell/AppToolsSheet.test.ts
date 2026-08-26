// @vitest-environment happy-dom

import { html } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import type { QualifiedContributionId, QualifiedWorkspacePanelContribution } from "../../plugins/types";
import { AppToolsSheet } from "./AppToolsSheet";

afterEach(() => {
  document.body.replaceChildren();
});

describe("app-tools-sheet", () => {
  it("groups pinned tools first and lists the rest", async () => {
    const sheet = await mount({
      panels: [panel("core:workspace.files", "Files"), panel("core:workspace.terminal", "Terminal"), panel("relays:workspace.relays", "Relays")],
      pinnedIds: ["core:workspace.terminal"],
    });
    expect(groupTitles(sheet)).toEqual(["Pinned · one tap", "More tools"]);
    expect(rowTitles(sheet)).toEqual(["Terminal", "Files", "Relays"]);
  });

  it("opens a tool when its row is tapped", async () => {
    const selected: QualifiedContributionId[] = [];
    const sheet = await mount({ panels: [panel("core:workspace.files", "Files")], pinnedIds: [], onSelect: (id) => selected.push(id) });
    row(sheet, "Files").querySelector<HTMLButtonElement>(".open")?.click();
    expect(selected).toEqual(["core:workspace.files"]);
  });

  it("toggles a pin from the row's pin button", async () => {
    const toggled: QualifiedContributionId[] = [];
    const sheet = await mount({
      panels: [panel("core:workspace.files", "Files"), panel("core:workspace.terminal", "Terminal")],
      pinnedIds: ["core:workspace.files"],
      onTogglePin: (id) => toggled.push(id),
    });
    const filesPin = row(sheet, "Files").querySelector<HTMLButtonElement>(".pin");
    expect(filesPin?.getAttribute("aria-pressed")).toBe("true");
    filesPin?.click();
    row(sheet, "Terminal").querySelector<HTMLButtonElement>(".pin")?.click();
    expect(toggled).toEqual(["core:workspace.files", "core:workspace.terminal"]);
  });

  it("closes from the close button", async () => {
    let closed = 0;
    const sheet = await mount({ panels: [panel("core:workspace.files", "Files")], pinnedIds: [], onClose: () => { closed += 1; } });
    sheet.shadowRoot?.querySelector<HTMLButtonElement>(".close")?.click();
    expect(closed).toBe(1);
  });
});

interface Props {
  panels: QualifiedWorkspacePanelContribution[];
  pinnedIds: QualifiedContributionId[];
  selected?: QualifiedContributionId;
  onSelect?: (id: QualifiedContributionId) => void;
  onTogglePin?: (id: QualifiedContributionId) => void;
  onClose?: () => void;
}

async function mount(props: Props): Promise<AppToolsSheet> {
  const sheet = new AppToolsSheet();
  sheet.panels = props.panels;
  sheet.pinnedIds = props.pinnedIds;
  if (props.selected !== undefined) sheet.selected = props.selected;
  if (props.onSelect !== undefined) sheet.onSelect = props.onSelect;
  if (props.onTogglePin !== undefined) sheet.onTogglePin = props.onTogglePin;
  if (props.onClose !== undefined) sheet.onClose = props.onClose;
  document.body.append(sheet);
  await sheet.updateComplete;
  return sheet;
}

function groupTitles(sheet: AppToolsSheet): string[] {
  return Array.from(sheet.shadowRoot?.querySelectorAll(".group") ?? []).map((element) => element.textContent.trim());
}

function rows(sheet: AppToolsSheet): HTMLElement[] {
  return Array.from(sheet.shadowRoot?.querySelectorAll<HTMLElement>(".row") ?? []);
}

function rowTitles(sheet: AppToolsSheet): string[] {
  return rows(sheet).map((element) => (element.querySelector(".row-title")?.textContent ?? "").trim());
}

function row(sheet: AppToolsSheet, title: string): HTMLElement {
  const found = rows(sheet).find((element) => (element.querySelector(".row-title")?.textContent ?? "").trim() === title);
  if (found === undefined) throw new Error(`Expected a "${title}" row`);
  return found;
}

function panel(id: QualifiedContributionId, title: string): QualifiedWorkspacePanelContribution {
  const [pluginId = "", localId = ""] = id.split(":");
  return { id, pluginId, localId, title, render: () => html`` };
}
