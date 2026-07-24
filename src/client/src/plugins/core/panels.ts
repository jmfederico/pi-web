import { html, type TemplateResult } from "lit";
import type { GitDiffResponse, GitStatusResponse } from "../../api";
import { renderBuiltinTabIcon } from "../../components/tabIcons";
import "../../components/WorkspaceFilesPanel";
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
      title: "Changes",
      titleFor: ({ workspace }) => workspace.vcs === "jj" ? "Jujutsu" : "Git",
      icon: renderBuiltinTabIcon("git"),
      order: 20,
      visible: ({ workspace }) => workspace.isGitRepo || workspace.vcs === "jj",
      render: renderChanges,
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

function renderTerminal(context: WorkspacePanelContext): TemplateResult {
  loadTerminalPanel();
  return html`<terminal-panel .workspace=${context.workspace} .machineId=${context.machine.id} .selectedTerminalId=${context.selectedTerminalId} .autoStart=${context.terminalAutoStart} .onSelectTerminal=${context.onSelectTerminal}></terminal-panel>`;
}

function renderChanges(context: WorkspacePanelContext): TemplateResult {
  const status = context.gitStatus;
  const vcsLabel = context.workspace.vcs === "jj" ? "Jujutsu" : "Git";
  return html`
    <section class="toolbar">
      <strong>${vcsLabel}</strong>
      ${context.gitStale ? html`<span class="stale">stale</span>` : null}
      <button @click=${context.onRefreshGit}>Refresh</button>
    </section>
    <section class="split">
      <div class="list">
        ${status === undefined ? html`<p class="muted">No status loaded.</p>` : status.vcs !== "jj" && !status.isGitRepo ? html`<p class="muted">Not a Git repository.</p>` : html`
          <p class="summary">${changesSummary(status)}</p>
          ${status.files.length === 0 ? html`<p class="muted">No changes.</p>` : status.files.map((file) => html`
            <button class="row ${context.selectedDiffPath === file.path ? "selected" : ""}" @click=${() => { context.onSelectDiff(file.path); }}>
              <span>${stateLabel(file.index, file.workingTree)}</span>
              <span>${file.path}</span>
            </button>
          `)}
        `}
      </div>
      <div class="viewer">
        ${renderDiffViewer(context)}
      </div>
    </section>
  `;
}

function renderDiffViewer(context: WorkspacePanelContext): TemplateResult {
  if (context.selectedDiffPath === undefined || context.selectedDiffPath === "") return html`<p class="muted">Select a changed file.</p>`;
  const unstaged = context.selectedDiff;
  const staged = context.selectedStagedDiff;
  if (unstaged === undefined || staged === undefined) return html`<p class="muted">Loading diff…</p>`;
  const diffs = [staged, unstaged].filter((diff) => diff.diff !== "");
  if (diffs.length === 0) return html`<p class="muted">No staged or unstaged diff.</p>`;
  return html`
    <div class=${diffs.length === 1 ? "diffs single" : "diffs"}>
      ${diffs.map((diff) => renderDiffSection(diff))}
    </div>
  `;
}

function renderDiffSection(diff: GitDiffResponse): TemplateResult {
  loadUnifiedDiffViewer();
  return html`
    <section class="diff-section">
      <div class="viewer-header"><strong>${diff.path ?? "diff"}</strong><small>${diff.vcs === "jj" ? "working copy" : diff.staged ? "staged" : "unstaged"}${diff.truncated ? " · truncated" : ""}</small></div>
      <unified-diff-viewer .diff=${diff.diff}></unified-diff-viewer>
    </section>
  `;
}

function loadUnifiedDiffViewer(): void {
  void import("../../components/UnifiedDiffViewer");
}

function loadTerminalPanel(): void {
  void import("../../components/TerminalPanel");
}

function changesSummary(status: GitStatusResponse): string {
  const branch = status.branch ?? "detached";
  const ahead = status.ahead ?? 0;
  const behind = status.behind ?? 0;
  return ahead === 0 && behind === 0 ? branch : `${branch} · ↑${String(ahead)} ↓${String(behind)}`;
}

function stateLabel(index: string, workingTree: string): string {
  const label = workingTree !== "unmodified" ? workingTree : index;
  return label.slice(0, 1).toUpperCase();
}
