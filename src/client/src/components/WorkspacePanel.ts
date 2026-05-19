import { LitElement, html, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { FileContentResponse, FileTreeEntry, GitDiffResponse, GitStatusResponse, Workspace } from "../api";
import type { AppState } from "../appState";
import type { QualifiedContributionId, QualifiedWorkspacePanelContribution, WorkspaceLabelItem, WorkspacePanelContext } from "../plugins/types";
import { workspacePanelStyles } from "./shared";
import { renderWorkspaceLabel } from "./workspaceLabel";

@customElement("workspace-panel")
export class WorkspacePanel extends LitElement {
  @property({ attribute: false }) workspace: Workspace | undefined;
  @property({ attribute: false }) appState!: AppState;
  @property() tool: QualifiedContributionId = "core:workspace.files";
  @property({ attribute: false }) panels: QualifiedWorkspacePanelContribution[] = [];
  @property({ attribute: false }) workspaceLabelItems: WorkspaceLabelItem[] = [];
  @property({ type: Boolean }) hideToolTabs = false;
  @property({ attribute: false }) fileTree: FileTreeEntry[] = [];
  @property({ attribute: false }) expandedDirs: Record<string, FileTreeEntry[]> = {};
  @property({ attribute: false }) selectedFilePath: string | undefined;
  @property({ attribute: false }) selectedFileContent: FileContentResponse | undefined;
  @property({ type: Boolean }) fileTreeStale = false;
  @property({ attribute: false }) gitStatus: GitStatusResponse | undefined;
  @property({ attribute: false }) selectedDiffPath: string | undefined;
  @property({ attribute: false }) selectedDiff: GitDiffResponse | undefined;
  @property({ attribute: false }) selectedStagedDiff: GitDiffResponse | undefined;
  @property({ type: Boolean }) gitStale = false;
  @property({ attribute: false }) onSelectTool: (tool: QualifiedContributionId) => void = () => undefined;
  @property({ attribute: false }) onRefreshFiles: () => void = () => undefined;
  @property({ attribute: false }) onExpandDir: (path: string) => void = () => undefined;
  @property({ attribute: false }) onSelectFile: (path: string) => void = () => undefined;
  @property({ attribute: false }) onRefreshGit: () => void = () => undefined;
  @property({ attribute: false }) onSelectDiff: (path: string) => void = () => undefined;
  @property({ type: Number }) activeTerminalCount = 0;
  @property({ type: Boolean }) terminalAutoStart = false;

  override render() {
    const workspace = this.workspace;
    if (workspace === undefined) return html`<section class="empty">Select a workspace.</section>`;
    const visiblePanels = this.panels;
    const selectedPanel = visiblePanels.find((panel) => panel.id === this.tool) ?? visiblePanels[0];
    const context = this.createPanelContext(workspace);
    return html`
      <header>
        ${this.hideToolTabs ? null : html`
          <div class="tabs">
            ${visiblePanels.map((panel) => html`
              <button class=${selectedPanel?.id === panel.id ? "selected" : ""} @click=${() => { this.onSelectTool(panel.id); }}>${this.renderPanelTitle(panel, context)}</button>
            `)}
          </div>
        `}
        <small>${renderWorkspaceLabel(workspace.label, this.workspaceLabelItems, workspace.path)}</small>
      </header>
      ${selectedPanel === undefined ? html`<section class="empty">No workspace panels registered.</section>` : html`
        <div class="panel-content">
          ${selectedPanel.render(context)}
        </div>
      `}
    `;
  }

  private renderPanelTitle(panel: QualifiedWorkspacePanelContribution, context: WorkspacePanelContext): TemplateResult {
    const badge = panel.badge?.(context);
    if (badge === undefined || badge === "") return html`${panel.title}`;
    return html`${panel.title} <span class="tab-badge">${badge}</span>`;
  }

  private createPanelContext(workspace: Workspace): WorkspacePanelContext {
    return {
      workspace,
      state: this.appState,
      fileTree: this.fileTree,
      expandedDirs: this.expandedDirs,
      selectedFilePath: this.selectedFilePath,
      selectedFileContent: this.selectedFileContent,
      fileTreeStale: this.fileTreeStale,
      gitStatus: this.gitStatus,
      selectedDiffPath: this.selectedDiffPath,
      selectedDiff: this.selectedDiff,
      selectedStagedDiff: this.selectedStagedDiff,
      gitStale: this.gitStale,
      activeTerminalCount: this.activeTerminalCount,
      terminalAutoStart: this.terminalAutoStart,
      onRefreshFiles: this.onRefreshFiles,
      onExpandDir: this.onExpandDir,
      onSelectFile: this.onSelectFile,
      onRefreshGit: this.onRefreshGit,
      onSelectDiff: this.onSelectDiff,
    };
  }

  static override styles = workspacePanelStyles;
}
