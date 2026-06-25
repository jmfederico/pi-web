import { html, type TemplateResult } from "lit";
import type { FileContentResponse, FileTreeEntry, GitDiffResponse, GitStatusResponse } from "../../api";
import { workspaceImagePreviewUrl } from "../../api/urls";
import { MAX_IMAGE_PREVIEW_BYTES, MAX_IMAGE_PREVIEW_LABEL } from "../../../../shared/workspaceFiles";
import { renderBuiltinTabIcon } from "../../components/tabIcons";
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
  return html`
    <section class="toolbar">
      <strong>Files</strong>
      ${context.fileTreeStale ? html`<span class="stale">stale</span>` : null}
      <button @click=${context.onRefreshFiles}>Refresh</button>
    </section>
    <section class="split">
      <div class="list tree">
        ${context.fileTree.length === 0 ? html`<p class="muted">No files loaded.</p>` : context.fileTree.map((entry) => renderTreeEntry(context, entry, 0))}
      </div>
      <div class="viewer">
        ${renderFileViewer(context)}
      </div>
    </section>
  `;
}

function renderTreeEntry(context: WorkspacePanelContext, entry: FileTreeEntry, depth: number): TemplateResult {
  const children = context.expandedDirs[entry.path];
  const hasChildren = children !== undefined;
  const selected = entry.type !== "directory" && context.selectedFilePath === entry.path;
  return html`
    <button class=${selected ? "row selected" : "row"} style=${`--depth:${String(depth)}`} @click=${() => { selectTreeEntry(context, entry); }}>
      <span>${entry.type === "directory" ? (hasChildren ? "▾" : "▸") : "·"}</span>
      <span>${entry.name}</span>
    </button>
    ${hasChildren ? children.map((child) => renderTreeEntry(context, child, depth + 1)) : null}
  `;
}

function selectTreeEntry(context: WorkspacePanelContext, entry: FileTreeEntry): void {
  if (entry.type === "directory") context.onExpandDir(entry.path);
  else context.onSelectFile(entry.path);
}

function renderFileViewer(context: WorkspacePanelContext): TemplateResult {
  const file = context.selectedFileContent;
  if (context.selectedFilePath === undefined || context.selectedFilePath === "") return html`<p class="muted">Select a file.</p>`;
  if (file === undefined) return html`<p class="muted">Loading ${context.selectedFilePath}…</p>`;
  if (file.mediaType === "image") return renderImageViewer(context, file);
  if (file.binary) return html`<p class="muted">Binary file: ${file.path} · ${formatFileSize(file.size)}</p>`;
  loadCodeViewer();
  return html`
    <div class="viewer-header"><strong>${file.path}</strong><small>${file.language ?? "text"}${file.truncated ? " · truncated" : ""}</small></div>
    <code-viewer .content=${file.content} .language=${file.language}></code-viewer>
  `;
}

function renderImageViewer(context: WorkspacePanelContext, file: FileContentResponse): TemplateResult {
  const metadata = `${file.mimeType ?? "image"} · ${formatFileSize(file.size)}`;
  if (file.size > MAX_IMAGE_PREVIEW_BYTES) {
    return html`
      <div class="viewer-header"><strong>${file.path}</strong><small>${metadata}</small></div>
      <p class="muted">Image too large to preview: ${formatFileSize(file.size)} · limit ${MAX_IMAGE_PREVIEW_LABEL}</p>
    `;
  }
  const src = workspaceImagePreviewUrl(context.workspace.projectId, context.workspace.id, file.path, { modifiedAt: file.modifiedAt, machineId: context.machine.id });
  return html`
    <div class="viewer-header"><strong>${file.path}</strong><small>${metadata}</small></div>
    <div class="image-preview">
      <img src=${src} alt=${file.path} decoding="async" />
    </div>
  `;
}

function renderTerminal(context: WorkspacePanelContext): TemplateResult {
  loadTerminalPanel();
  return html`<terminal-panel .workspace=${context.workspace} .machineId=${context.machine.id} .selectedTerminalId=${context.selectedTerminalId} .autoStart=${context.terminalAutoStart} .onSelectTerminal=${context.onSelectTerminal}></terminal-panel>`;
}

function renderGit(context: WorkspacePanelContext): TemplateResult {
  const status = context.gitStatus;
  return html`
    <section class="toolbar">
      <strong>Git</strong>
      ${context.gitStale ? html`<span class="stale">stale</span>` : null}
      <button @click=${context.onRefreshGit}>Refresh</button>
    </section>
    <section class="split">
      <div class="list">
        ${status === undefined ? html`<p class="muted">No status loaded.</p>` : !status.isGitRepo ? html`<p class="muted">Not a git repository.</p>` : html`
          <p class="summary">${gitSummary(status)}</p>
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
      <div class="viewer-header"><strong>${diff.path ?? "diff"}</strong><small>${diff.staged ? "staged" : "unstaged"}${diff.truncated ? " · truncated" : ""}</small></div>
      <unified-diff-viewer .diff=${diff.diff}></unified-diff-viewer>
    </section>
  `;
}

function loadCodeViewer(): void {
  void import("../../components/CodeViewer");
}

function loadUnifiedDiffViewer(): void {
  void import("../../components/UnifiedDiffViewer");
}

function loadTerminalPanel(): void {
  void import("../../components/TerminalPanel");
}

function gitSummary(status: GitStatusResponse): string {
  const branch = status.branch ?? "detached";
  const ahead = status.ahead ?? 0;
  const behind = status.behind ?? 0;
  return ahead === 0 && behind === 0 ? branch : `${branch} · ↑${String(ahead)} ↓${String(behind)}`;
}

function stateLabel(index: string, workingTree: string): string {
  const label = workingTree !== "unmodified" ? workingTree : index;
  return label.slice(0, 1).toUpperCase();
}

function formatFileSize(size: number): string {
  if (!Number.isFinite(size) || size < 0) return "0 B";
  if (size < 1024) return `${String(size)} B`;
  const kib = size / 1024;
  if (kib < 1024) return `${formatScaledFileSize(kib)} KB`;
  const mib = kib / 1024;
  if (mib < 1024) return `${formatScaledFileSize(mib)} MB`;
  return `${formatScaledFileSize(mib / 1024)} GB`;
}

function formatScaledFileSize(value: number): string {
  return value >= 10 ? String(Math.round(value)) : value.toFixed(1);
}
