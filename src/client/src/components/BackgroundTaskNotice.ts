import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { backgroundTaskTone, type BackgroundTaskPresentation } from "../backgroundTaskNotification";
import { chatTranscriptMessages as messages } from "../chatTranscriptMessages";
import { LocalizationController } from "../localization/browser";
import { stylesheetIntegrationCapability } from "../plugins/styles";

@customElement("background-task-notice")
export class BackgroundTaskNotice extends LitElement {
  constructor() {
    super();
    stylesheetIntegrationCapability.createController(this);
    new LocalizationController(this);
  }

  @property({ attribute: false }) task: BackgroundTaskPresentation | undefined;
  @property() raw = "";

  override render() {
    const task = this.task;
    if (task === undefined) return null;
    const tone = backgroundTaskTone(task);
    const icon = tone === "success" ? "✓" : tone === "danger" ? "✖" : "●";
    return html`
      <section class=${`notice ${tone}`} aria-label=${messages.t("backgroundTaskStatus", { status: task.status })}>
        <header><span class="status"><span aria-hidden="true">${icon}</span> ${messages.t("backgroundTaskStatus", { status: task.status })}</span>
          <strong dir="auto">${task.name}</strong> <code>${task.id}</code>
        </header>
        ${typeof task.exitCode === "number" ? html`<div>${messages.t("shellExit", { code: String(task.exitCode) })}</div>` : null}
        ${task.error === undefined ? null : html`<pre class="error">${task.error}</pre>`}
        ${task.outputPath === undefined ? null : html`<div class="output">${messages.t("backgroundTaskOutput")}: <code dir="auto">${task.outputPath}</code></div>`}
        <details><summary>${messages.t("backgroundTaskDetails")}</summary><pre class="raw">${this.raw}</pre></details>
      </section>
    `;
  }

  static override styles = css`
    :host { display: block; }
    .notice { --tone: var(--pi-warning); border: 1px solid color-mix(in srgb, var(--tone) 50%, transparent); border-inline-start: 3px solid var(--tone); background: color-mix(in srgb, var(--tone) 8%, var(--pi-surface)); border-radius: 6px; padding: 10px 12px; overflow-wrap: anywhere; }
    .success { --tone: var(--pi-success); }
    .danger { --tone: var(--pi-danger); }
    header { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
    .status { color: var(--tone); font-weight: 600; }
    code, pre { font-family: var(--pi-mono, ui-monospace, monospace); font-size: 12px; }
    header code, .output { color: var(--pi-muted); }
    .output, details { margin-block-start: 6px; }
    summary { cursor: pointer; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; }
    .error { max-height: 8em; overflow: auto; color: var(--pi-danger); }
    .raw { max-height: 24em; overflow: auto; }
  `;
}
