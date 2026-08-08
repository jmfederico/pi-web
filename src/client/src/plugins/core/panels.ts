import { html, type TemplateResult } from "lit";
import { PI_WEB_CAPABILITIES } from "../../../../shared/capabilities";
import { renderBuiltinTabIcon } from "../../components/tabIcons";
import "../../components/WorkspaceFilesPanel";
import "../../components/WorkspaceGitPanel";
import type { WorkspacePanelContribution, WorkspacePanelContext } from "../types";

export function createCoreWorkspacePanels(): WorkspacePanelContribution[] {
  return [
    {
      id: "workspace.files",
      title: "Files",
      icon: renderBuiltinTabIcon("files"),
      order: 10,
      render: renderFiles,
    },
    {
      id: "workspace.git",
      title: "Git",
      icon: renderBuiltinTabIcon("git"),
      order: 20,
      visible: ({ workspace }) => workspace.isGitRepo,
      render: renderGit,
    },
    {
      id: "workspace.automations",
      title: "Automations",
      icon: html`<span aria-hidden="true">⏱</span>`,
      order: 25,
      visible: ({ machine, state }) => state.machineRuntimes[machine.id]?.capabilities?.includes(PI_WEB_CAPABILITIES.automations) === true,
      render: renderAutomations,
    },
    {
      id: "workspace.terminal",
      title: "Terminal",
      icon: renderBuiltinTabIcon("terminal"),
      order: 30,
      badge: (context) => context.activeTerminalCount > 0 ? context.activeTerminalCount : undefined,
      render: renderTerminal,
    },
  ];
}

function renderFiles(context: WorkspacePanelContext): TemplateResult {
  return html`<workspace-files-panel .context=${context}></workspace-files-panel>`;
}

function renderAutomations(context: WorkspacePanelContext): TemplateResult {
  loadAutomationsPanel();
  return html`<automations-panel .context=${context}></automations-panel>`;
}

function renderTerminal(context: WorkspacePanelContext): TemplateResult {
  loadTerminalPanel();
  return html`<terminal-panel .workspace=${context.workspace} .machineId=${context.machine.id} .selectedTerminalId=${context.selectedTerminalId} .autoStart=${context.terminalAutoStart} .onSelectTerminal=${context.onSelectTerminal}></terminal-panel>`;
}

function renderGit(context: WorkspacePanelContext): TemplateResult {
  return html`<workspace-git-panel .context=${context}></workspace-git-panel>`;
}

function loadAutomationsPanel(): void {
  void import("../../components/AutomationsPanel");
}

function loadTerminalPanel(): void {
  void import("../../components/TerminalPanel");
}
