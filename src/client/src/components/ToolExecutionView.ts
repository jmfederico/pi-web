import { localizedArgumentSummary } from "../localizedChatPresentation";
import { LocalizationController, localization } from "../localization/browser";
import { toolExecutionMessages as messages } from "../toolExecutionMessages";
import { stylesheetIntegrationCapability } from "../plugins/styles";
import { LitElement, css, html, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { writeClipboardText } from "../clipboard";
import type { ToolExecutionPart } from "../chatTypes";
import { uiButtonStyles } from "./ui/controlStyles";
import { uiTranscriptStyles } from "./ui/transcriptStyles";

const MAX_COLLAPSED_DIFF_LINES = 180;

interface ToolTarget {
  kind: "command" | "file" | "input";
  text: string;
  generated?: boolean;
}

@customElement("tool-execution-view")
export class ToolExecutionView extends LitElement {
  constructor() {
    super();
    stylesheetIntegrationCapability.createController(this);
    new LocalizationController(this);
  }

  @property({ attribute: false }) execution: ToolExecutionPart | undefined;
  @state() private showFullDiff = false;
  @state() private copied = false;
  @state() private diffOpen = true;
  @state() private textOpen: boolean | undefined;
  private countedDiff: string | undefined;
  private diffStats: { added: number; removed: number; lines: number } | undefined;

  protected override willUpdate(changed: PropertyValues<ToolExecutionView>): void {
    const previous = changed.get("execution");
    if (changed.has("execution") && this.execution?.status === "error" && previous?.status !== "error") this.textOpen = true;
  }

  override render() {
    const execution = this.execution;
    if (execution === undefined) return null;

    const path = pathFromArgs(execution.args);
    const actualDiff = diffFromDetails(execution.details);
    const preview = execution.preview;
    const visibleDiff = actualDiff ?? preview?.diff;
    if (visibleDiff !== this.countedDiff) {
      this.countedDiff = visibleDiff;
      this.diffStats = visibleDiff === undefined ? undefined : countDiffLines(visibleDiff);
    }
    const diffStats = this.diffStats;
    const previewMismatch = actualDiff !== undefined && preview?.diff !== undefined && actualDiff !== preview.diff;
    const errorText = execution.status === "error" ? execution.resultText : preview?.error;
    const bodyText = visibleDiff === undefined ? localizedResultText(execution) : undefined;
    const target = toolTarget(execution, path);
    const edits = editCount(execution);

    return html`
      <section class=${`tool-card ui-transcript-surface ui-transcript-activity ui-transcript-tool ${execution.status}`}>
        <div class="tool-header ui-transcript-heading">
          <div class="tool-title">
            <span class="status-icon" aria-hidden="true">${statusIcon(execution.status)}</span>
            <strong>${execution.toolName}</strong>
            ${this.renderHeaderTarget(target)}
          </div>
          <div class="tool-meta">
            ${edits === undefined ? null : html`<span>${messages.t("edits", { count: edits })}</span>`}
            ${diffStats === undefined ? null : html`<span class="diff-stats"><b class="added">${localization.number(diffStats.added, { signDisplay: "always" })}</b><span>/</span><b class="removed">${localization.number(-diffStats.removed, { signDisplay: "always" })}</b></span>`}
            <span class="status-label">${messages.t("status", { status: execution.status })}</span>
          </div>
        </div>

        ${previewMismatch ? html`<p class="notice">${messages.t("mismatch")}</p>` : null}
        ${errorText === undefined || errorText === "" ? null : html`<pre class="error-text">${errorText}</pre>`}
        ${visibleDiff === undefined ? this.renderTextBody(bodyText, execution.status === "error", target) : this.renderDiffBody(visibleDiff, messages.t(actualDiff === undefined ? "previewDiff" : "appliedDiff"), target)}
      </section>
    `;
  }

  private renderHeaderTarget(target: ToolTarget | undefined) {
    if (target === undefined) return null;
    const className = target.kind === "file" ? "path" : target.generated === true ? "summary generated-summary" : "summary";
    return html`<span class=${className} title=${target.text} aria-label=${messages.t("targetDescription", { kind: target.kind, text: target.text })}>${target.text}</span>`;
  }

  private renderExpandedTarget(target: ToolTarget | undefined) {
    if (target === undefined) return null;
    return html`
      <div class="detail-target">
        <span class="detail-label">${messages.t("targetLabel", { kind: target.kind })}</span>
        <pre class=${target.generated === true ? "detail-target-value generated-summary" : "detail-target-value"}>${target.text}</pre>
      </div>
    `;
  }

  private renderTextBody(text: string | undefined, open: boolean, target: ToolTarget | undefined) {
    if ((text === undefined || text === "") && target === undefined) return null;
    const expanded = this.textOpen ?? open;
    return html`
      <details class="text-body" ?open=${expanded} @toggle=${(event: Event) => {
        if (event.currentTarget instanceof HTMLDetailsElement) this.textOpen = event.currentTarget.open;
      }}>
        <summary class="ui-transcript-disclosure">${messages.t("details")}</summary>
        ${expanded ? html`${this.renderExpandedTarget(target)}
        ${text === undefined || text === "" ? null : html`
          <div class="detail-result">
            <span class="detail-label">${messages.t("result")}</span>
            <pre>${text}</pre>
          </div>
        `}` : null}
      </details>
    `;
  }

  private renderDiffBody(diff: string, label: string, target: ToolTarget | undefined) {
    const lineCount = this.diffStats?.lines ?? 0;
    return html`
      <details class="diff-details" ?open=${this.diffOpen} @toggle=${(event: Event) => { this.onDiffToggle(event); }}>
        <summary class="ui-transcript-disclosure">
          <span>${label}</span>
          <small>${messages.t("lines", { count: lineCount })}</small>
        </summary>
        ${this.diffOpen ? this.renderDiffContent(diff, label, target) : null}
      </details>
    `;
  }

  private renderDiffContent(diff: string, label: string, target: ToolTarget | undefined) {
    const lines = diff.split("\n");
    const truncated = !this.showFullDiff && lines.length > MAX_COLLAPSED_DIFF_LINES;
    const visibleLines = truncated ? lines.slice(0, MAX_COLLAPSED_DIFF_LINES) : lines;
    return html`
        ${this.renderExpandedTarget(target)}
        <div class="diff-toolbar">
          <span>${truncated ? messages.t("showing", { visible: visibleLines.length, total: lines.length }) : messages.t("fullDiff")}</span>
          <button class="ui-button ui-button--compact" type="button" @click=${() => { void this.copyDiff(diff); }}>${messages.t(this.copied ? "copied" : "copyDiff")}</button>
        </div>
        <pre class="diff" dir="ltr" aria-label=${label}><code class="diff-content">${visibleLines.map((line) => html`<span class=${diffLineClass(line)}>${line}</span>`)}</code></pre>
        ${truncated ? html`
          <button class="show-more ui-button ui-button--compact" type="button" @click=${() => { this.showFullDiff = true; }}>
            ${messages.t("showAll", { count: lines.length })}
          </button>
        ` : null}
    `;
  }

  private onDiffToggle(event: Event): void {
    const details = event.currentTarget;
    if (details instanceof HTMLDetailsElement) this.diffOpen = details.open;
  }

  private async copyDiff(diff: string): Promise<void> {
    const copied = await writeClipboardText(diff);
    if (!copied) {
      this.copied = false;
      return;
    }
    this.copied = true;
    window.setTimeout(() => { this.copied = false; }, 1200);
  }

  static override styles = [uiButtonStyles, uiTranscriptStyles, css`
    :host { display: block; width: 100%; max-width: 100%; min-width: 0; color: var(--pi-text); }
    .tool-card { display: grid; width: 100%; max-width: 100%; min-width: 0; overflow: hidden; padding: 0; color: var(--pi-text); }
    .tool-card.running, .tool-card.pending { --ui-activity-tone: var(--pi-warning); }
    .tool-card.error { --ui-activity-tone: var(--pi-danger); }
    .success .status-icon { color: var(--pi-success); }
    .running .status-icon, .pending .status-icon { color: var(--pi-warning); }
    .error .status-icon { color: var(--pi-danger); }
    .tool-header { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 4px 12px; min-width: 0; }
    .tool-title { flex: 1 1 auto; display: inline-flex; align-items: baseline; gap: 7px; min-width: 0; }
    .status-icon { flex: 0 0 auto; color: var(--pi-muted); }
    strong { flex: 0 0 auto; color: var(--pi-text); }
    .path, .summary { display: block; flex: 1 1 auto; min-width: 0; max-width: 100%; overflow-x: auto; overflow-y: hidden; overscroll-behavior-x: contain; scrollbar-width: thin; white-space: pre; color: var(--pi-text); font: 13px var(--pi-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); direction: ltr; text-align: left; unicode-bidi: isolate; }
    .summary { color: var(--pi-text-secondary); }
    .summary.generated-summary, .detail-target-value.generated-summary { direction: inherit; text-align: start; white-space: pre-wrap; overflow-wrap: anywhere; }
    .tool-meta { flex: 0 1 auto; min-width: 0; overflow-wrap: anywhere; display: inline-flex; flex-wrap: wrap; align-items: baseline; gap: 8px; color: var(--pi-text-secondary); font-size: 12px; }
    .diff-stats { display: inline-flex; gap: 3px; direction: ltr; unicode-bidi: isolate; font-variant-numeric: tabular-nums; }
    .added, .diff .added { color: color-mix(in srgb, var(--pi-success) 65%, var(--pi-text) 35%); }
    .removed, .diff .removed { color: color-mix(in srgb, var(--pi-danger) 65%, var(--pi-text) 35%); }
    .status-label { color: var(--pi-text-secondary); }
    .notice { margin: 0; padding: 8px 12px; color: var(--pi-warning); }
    .muted { margin: 0; color: var(--pi-muted); }
    .error-text { margin: 0; color: var(--pi-danger); padding: 8px; white-space: pre-wrap; overflow-wrap: anywhere; font: 12px var(--pi-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); }
    .text-body { min-width: 0; }
    .text-body[open], .diff-details[open] { padding-bottom: 12px; }
    .text-body > summary { color: var(--pi-muted); }
    .detail-target, .detail-result { display: grid; gap: 4px; margin: 8px 12px 0; min-width: 0; }
    .detail-label { color: var(--pi-muted); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
    .text-body pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: 12px var(--pi-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); color: var(--pi-text); }
    .detail-result pre { box-sizing: border-box; max-width: 100%; overflow-x: auto; overflow-y: hidden; overscroll-behavior-x: contain; scrollbar-width: thin; border: 1px solid var(--pi-border-muted); border-radius: 0; background: var(--pi-bg); padding: 8px; white-space: pre; overflow-wrap: normal; direction: ltr; text-align: left; unicode-bidi: isolate; }
    .detail-target-value { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--pi-text-secondary); font: 12px var(--pi-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); direction: ltr; text-align: left; unicode-bidi: isolate; }
    .diff-details { min-width: 0; max-width: 100%; }
    .diff-details > summary { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; color: var(--pi-muted); }
    .diff-details > summary span { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .diff-details > summary small { flex: 0 1 auto; min-width: 0; overflow-wrap: anywhere; color: var(--pi-dim); }
    .diff-toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; margin-top: 8px; color: var(--pi-muted); font-size: 12px; padding-inline: 12px; }
    .diff-toolbar span { min-width: 0; overflow-wrap: anywhere; }
    .diff { box-sizing: border-box; width: calc(100% - 24px); max-width: 100%; min-width: 0; margin: 0 12px; overflow-x: auto; overflow-y: hidden; overscroll-behavior-x: contain; border: 1px solid var(--pi-border-muted); border-radius: 0; background: var(--pi-bg); padding: 8px 0; color: var(--pi-muted); font: 12px var(--pi-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); line-height: 1.45; }
    .diff-content { display: block; width: max-content; min-width: 100%; }
    .diff span { display: block; min-height: 1.45em; padding: 0 8px; white-space: pre; }
    .diff .context { color: var(--pi-muted); }
    .diff .hunk { color: var(--pi-accent); }
    .diff .file { color: var(--pi-dim); }
    .diff .meta { color: var(--pi-dim); }
    .diff .added { background: color-mix(in srgb, var(--pi-success) 12%, transparent); }
    .diff .removed { background: color-mix(in srgb, var(--pi-danger) 12%, transparent); }
    .show-more { justify-self: start; margin-inline: 12px; }
  `];
}

function localizedResultText(execution: ToolExecutionPart): string | undefined {
  // Only the owned transient update is presentation; final and legacy tool output stays verbatim.
  const presentation = getProperty(execution.details, "presentation");
  if (execution.toolName === "edit" && execution.status === "running" && getString(presentation, "kind") === "editPreviewComputed") {
    return messages.t("previewComputed");
  }
  return execution.resultText;
}

function toolTarget(execution: ToolExecutionPart, path: string | undefined): ToolTarget | undefined {
  if (path !== undefined && path !== "") return { kind: "file", text: path };
  const command = getString(execution.args, "command");
  if (command !== undefined && command !== "") return { kind: "command", text: command };
  const summary = execution.summaryPresentation === undefined ? execution.summary : localizedArgumentSummary(execution.summaryPresentation);
  if (summary !== "") return { kind: "input", text: summary, ...(execution.summaryPresentation === undefined ? {} : { generated: true }) };
  return undefined;
}

function pathFromArgs(args: unknown): string | undefined {
  return getString(args, "path") ?? getString(args, "file_path");
}

function editCount(execution: ToolExecutionPart): number | undefined {
  if (execution.toolName !== "edit") return undefined;
  const edits = getProperty(execution.args, "edits");
  if (Array.isArray(edits)) return edits.length;
  if (typeof getProperty(execution.args, "oldText") === "string" && typeof getProperty(execution.args, "newText") === "string") return 1;
  return undefined;
}

function diffFromDetails(details: unknown): string | undefined {
  return getString(details, "diff");
}

function countDiffLines(diff: string): { added: number; removed: number; lines: number } {
  let added = 0;
  let removed = 0;
  const lines = diff.split("\n");
  for (const line of lines) {
    if (isAddedDiffLine(line)) added++;
    else if (isRemovedDiffLine(line)) removed++;
  }
  return { added, removed, lines: lines.length };
}

function diffLineClass(line: string): string {
  if (isAddedDiffLine(line)) return "added";
  if (isRemovedDiffLine(line)) return "removed";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+++") || line.startsWith("---")) return "file";
  if (line.startsWith("diff ") || line.startsWith("index ")) return "meta";
  return "context";
}

function isAddedDiffLine(line: string): boolean {
  return line.startsWith("+") && !line.startsWith("+++");
}

function isRemovedDiffLine(line: string): boolean {
  return line.startsWith("-") && !line.startsWith("---");
}

function statusIcon(status: ToolExecutionPart["status"]): string {
  if (status === "success") return "✓";
  if (status === "error") return "✖";
  if (status === "running") return "●";
  return "○";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getProperty(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function getString(value: unknown, key: string): string | undefined {
  const property = getProperty(value, key);
  return typeof property === "string" ? property : undefined;
}
