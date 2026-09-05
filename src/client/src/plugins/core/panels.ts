import { html, type TemplateResult } from "lit";
import { renderBuiltinTabIcon } from "../../components/tabIcons";
import type { WorkspacePanelContribution, WorkspacePanelContext } from "../types";

export function createCoreWorkspacePanels(): WorkspacePanelContribution[] {
  return [{
    id: "workspace.terminal",
    title: "Terminal",
    icon: renderBuiltinTabIcon("terminal"),
    order: 30,
    badge: (context) => context.activeTerminalCount > 0 ? context.activeTerminalCount : undefined,
    render: renderTerminal,
  }];
}

function renderTerminal(context: WorkspacePanelContext): TemplateResult {
  loadTerminalPanel();
  return html`<terminal-panel .workspace=${context.workspace} .machineId=${context.machine.id} .selectedTerminalId=${context.selectedTerminalId} .autoStart=${context.terminalAutoStart} .onSelectTerminal=${context.onSelectTerminal}></terminal-panel>`;
}

function loadTerminalPanel(): void {
  void import("../../components/TerminalPanel");
}
