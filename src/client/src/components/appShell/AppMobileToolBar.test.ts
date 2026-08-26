// @vitest-environment happy-dom

import { html } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import type { QualifiedContributionId, QualifiedWorkspacePanelContribution } from "../../plugins/types";
import { AppMobileToolBar } from "./AppMobileToolBar";

afterEach(() => {
  document.body.replaceChildren();
});

describe("app-mobile-tool-bar", () => {
  it("renders one button per pinned tool plus a more button", async () => {
    const bar = await mount({ panels: [panel("core:workspace.files", "Files"), panel("core:workspace.terminal", "Terminal")] });
    expect(toolLabels(bar)).toEqual(["Files", "Terminal"]);
    expect(bar.shadowRoot?.querySelector(".more")).not.toBeNull();
  });

  it("renders nothing when no tools are pinned", async () => {
    const bar = await mount({ panels: [] });
    expect(bar.shadowRoot?.querySelector(".tool-bar")).toBeNull();
  });

  it("marks the selected tool and reports selections", async () => {
    const selected: QualifiedContributionId[] = [];
    const bar = await mount({
      panels: [panel("core:workspace.files", "Files"), panel("core:workspace.terminal", "Terminal")],
      selected: "core:workspace.terminal",
      onSelect: (id) => selected.push(id),
    });
    const terminal = tool(bar, "Terminal");
    expect(terminal.classList.contains("selected")).toBe(true);
    expect(terminal.getAttribute("aria-pressed")).toBe("true");
    tool(bar, "Files").click();
    expect(selected).toEqual(["core:workspace.files"]);
  });

  it("opens the tools menu from the more button", async () => {
    let opened = 0;
    const bar = await mount({ panels: [panel("core:workspace.files", "Files")], onOpenMenu: () => { opened += 1; } });
    bar.shadowRoot?.querySelector<HTMLButtonElement>(".more")?.click();
    expect(opened).toBe(1);
  });
});

interface Props {
  panels: QualifiedWorkspacePanelContribution[];
  selected?: QualifiedContributionId;
  onSelect?: (id: QualifiedContributionId) => void;
  onOpenMenu?: () => void;
}

async function mount(props: Props): Promise<AppMobileToolBar> {
  const bar = new AppMobileToolBar();
  bar.panels = props.panels;
  if (props.selected !== undefined) bar.selected = props.selected;
  if (props.onSelect !== undefined) bar.onSelect = props.onSelect;
  if (props.onOpenMenu !== undefined) bar.onOpenMenu = props.onOpenMenu;
  document.body.append(bar);
  await bar.updateComplete;
  return bar;
}

function toolButtons(bar: AppMobileToolBar): HTMLButtonElement[] {
  return Array.from(bar.shadowRoot?.querySelectorAll<HTMLButtonElement>(".tool") ?? []);
}

function toolLabels(bar: AppMobileToolBar): string[] {
  return toolButtons(bar).map((button) => (button.querySelector(".tool-label")?.textContent ?? "").trim());
}

function tool(bar: AppMobileToolBar, label: string): HTMLButtonElement {
  const button = toolButtons(bar).find((candidate) => (candidate.querySelector(".tool-label")?.textContent ?? "").trim() === label);
  if (button === undefined) throw new Error(`Expected a "${label}" tool button`);
  return button;
}

function panel(id: QualifiedContributionId, title: string): QualifiedWorkspacePanelContribution {
  const [pluginId = "", localId = ""] = id.split(":");
  return { id, pluginId, localId, title, render: () => html`` };
}
