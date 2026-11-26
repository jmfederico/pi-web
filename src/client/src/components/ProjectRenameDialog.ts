import { LocalizationController } from "../localization/browser";
import { projectWorkspaceMessages as messages } from "../projectWorkspaceMessages";
import { stylesheetIntegrationCapability } from "../plugins/styles";
import { LitElement, css, html, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { Project } from "../api";
import "./ModalSurface";
import { uiDialogStyles, uiFormStyles } from "./ui/dialogStyles";

/** Edits a project's display name. The owner performs the rename and closes the dialog on success. */
@customElement("project-rename-dialog")
export class ProjectRenameDialog extends LitElement {
  constructor() {
    super();
    stylesheetIntegrationCapability.createController(this);
    new LocalizationController(this);
  }

  @property({ attribute: false }) project?: Project;
  /** Rejects to keep the dialog open with the failure shown. */
  @property({ attribute: false }) onSubmit?: (name: string) => Promise<void>;
  @property({ attribute: false }) onCancel?: () => void;

  @state() private name = "";
  @state() private submitting = false;
  @state() private error = "";

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("project")) {
      this.name = this.project?.name ?? "";
      this.error = "";
    }
  }

  private async submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!this.canSubmit()) return;
    this.submitting = true;
    this.error = "";
    try {
      await this.onSubmit?.(this.name.trim());
    } catch (error) {
      this.error = messages.t("renameFailed", { error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (this.isConnected) this.submitting = false;
    }
  }

  private canSubmit(): boolean {
    return this.project !== undefined && !this.submitting && this.name.trim() !== this.project.name;
  }

  override render() {
    const project = this.project;
    if (project === undefined) return null;
    const title = messages.t("renameTitle");
    return html`
      <modal-surface .onClose=${() => this.onCancel?.()} .initialFocus=${"input[name='name']"} .label=${title}>
        <form class="ui-form" aria-describedby=${this.error === "" ? "" : "project-rename-error"} @submit=${(event: SubmitEvent) => { void this.submit(event); }}>
          <header class="ui-dialog-header">
            <strong class="ui-dialog-title">${title}</strong>
            <button class="ui-button ui-button--icon" type="button" @click=${() => { this.onCancel?.(); }} aria-label=${messages.t("closeRename")}>×</button>
          </header>
          <div class="ui-dialog-body ui-form-body">
            ${this.error === "" ? null : html`<div id="project-rename-error" class="ui-form-error" role="alert">${this.error}</div>`}
            <label class="ui-form-field">
              <span>${messages.t("nameLabel")}</span>
              <input class="ui-input" name="name" type="text" dir="auto" maxlength="120" autocomplete="off" aria-describedby="project-rename-help" placeholder=${folderName(project.path)} .value=${this.name} @input=${(event: InputEvent) => { if (event.target instanceof HTMLInputElement) this.name = event.target.value; }} />
            </label>
            <small id="project-rename-help" class="hint">${messages.t("nameHelp")}</small>
            <p class="hint"><bdi dir="ltr">${project.path}</bdi></p>
          </div>
          <footer class="ui-dialog-footer">
            <button class="ui-button" type="button" @click=${() => { this.onCancel?.(); }}>${messages.t("cancel")}</button>
            <button class="ui-button ui-button--primary" type="submit" ?disabled=${!this.canSubmit()}>${this.submitting ? messages.t("renaming") : messages.t("rename")}</button>
          </footer>
        </form>
      </modal-surface>
    `;
  }

  static override styles = [uiDialogStyles, uiFormStyles, css`
    :host { --ui-dialog-width: 480px; }
    .hint { color: var(--pi-muted); margin: 0; overflow-wrap: anywhere; }
  `];
}

function folderName(path: string): string {
  return path.split("/").filter((part) => part !== "").at(-1) ?? path;
}
