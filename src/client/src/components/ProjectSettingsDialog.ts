import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { ProjectSettings, ProjectSettingsUpdate } from "../../../shared/apiTypes";
import { LocalizationController } from "../localization/browser";
import { stylesheetIntegrationCapability } from "../plugins/styles";
import { projectWorkspaceMessages as messages } from "../projectWorkspaceMessages";
import "./ModalSurface";
import { uiDialogStyles, uiFormStyles } from "./ui/dialogStyles";

/** One dialog instance edits one project on the machine captured when it opened. */
@customElement("project-settings-dialog")
export class ProjectSettingsDialog extends LitElement {
  constructor() {
    super();
    stylesheetIntegrationCapability.createController(this);
    new LocalizationController(this);
  }

  @property({ attribute: false }) loadSettings?: () => Promise<ProjectSettings>;
  /** Closes the dialog on success; rejects to show the failure and enable retry. */
  @property({ attribute: false }) onSubmit?: (update: ProjectSettingsUpdate) => Promise<void>;
  @property({ attribute: false }) onCancel?: () => void;

  @state() private settings?: ProjectSettings;
  @state() private name = "";
  @state() private folder = "";
  @state() private submitting = false;
  @state() private loadError: string | undefined;
  @state() private saveError: string | undefined;

  protected override firstUpdated(): void {
    void this.load();
  }

  private async load(): Promise<void> {
    this.loadError = undefined;
    try {
      const settings = await this.loadSettings?.();
      if (settings === undefined) return;
      this.name = settings.project.name;
      this.folder = settings.project.worktreeFolder ?? "";
      this.settings = settings;
    } catch (error) {
      this.loadError = error instanceof Error ? error.message : String(error);
    }
  }

  private settingsPatch(): ProjectSettingsUpdate | undefined {
    if (this.settings === undefined) return undefined;
    const { project, worktreeFolder } = this.settings;
    const name = this.name.trim();
    const folder = this.folder.trim();
    const nameChanged = name !== project.name;
    const folderChanged = worktreeFolder.source !== "environment" && folder !== (project.worktreeFolder ?? "");
    if (!nameChanged && !folderChanged) return undefined;
    const set = {
      ...(nameChanged ? { name } : {}),
      ...(folderChanged && folder !== "" ? { worktreeFolder: folder } : {}),
    };
    return {
      ...(nameChanged || (folderChanged && folder !== "") ? { set } : {}),
      ...(folderChanged && folder === "" ? { unset: ["/worktreeFolder"] } : {}),
    };
  }

  private async submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const update = this.settingsPatch();
    if (this.submitting || update === undefined || this.onSubmit === undefined) return;
    this.submitting = true;
    this.saveError = undefined;
    try {
      await this.onSubmit(update);
    } catch (error) {
      this.saveError = error instanceof Error ? error.message : String(error);
    } finally {
      this.submitting = false;
    }
  }

  private readonly retryLoad = (): void => {
    this.renderRoot.querySelector<HTMLElement>(".close-dialog")?.focus();
    void this.load();
  };

  private readonly cancel = (): void => {
    if (!this.submitting) this.onCancel?.();
  };

  override render() {
    const title = messages.t("projectSettingsTitle");
    const settings = this.settings;
    return html`
      <modal-surface .onClose=${this.cancel} .busy=${this.submitting} .initialFocus=${".close-dialog"} .label=${title}>
        <form class="ui-form" @submit=${(event: SubmitEvent) => { void this.submit(event); }}>
          <header class="ui-dialog-header">
            <strong class="ui-dialog-title">${title}</strong>
            <button class="ui-button ui-button--icon close-dialog" type="button" ?disabled=${this.submitting} @click=${this.cancel} aria-label=${messages.t("closeProjectSettings")}>×</button>
          </header>
          <div class="ui-dialog-body ui-form-body">
            ${settings === undefined ? this.renderLoading() : this.renderFields(settings)}
          </div>
          <footer class="ui-dialog-footer">
            <button class="ui-button" type="button" ?disabled=${this.submitting} @click=${this.cancel}>${messages.t("cancel")}</button>
            <button class="ui-button ui-button--primary" type="submit" ?disabled=${this.submitting || this.settingsPatch() === undefined || this.onSubmit === undefined}>${this.submitting ? messages.t("savingProjectSettings") : messages.t("saveProjectSettings")}</button>
          </footer>
        </form>
      </modal-surface>
    `;
  }

  private renderLoading() {
    return this.loadError === undefined
      ? html`<p class="hint" role="status">${messages.t("loadProjectSettings")}</p>`
      : html`
          <div class="ui-form-error" role="alert">${messages.t("loadProjectSettingsFailed", { error: this.loadError })}</div>
          <div><button class="ui-button" type="button" @click=${this.retryLoad}>${messages.t("retryProjectSettings")}</button></div>
        `;
  }

  private renderFields({ project, worktreeFolder }: ProjectSettings) {
    const folderLocked = worktreeFolder.source === "environment";
    return html`
      <p class="hint"><bdi dir="ltr">${project.path}</bdi><br />${messages.t("projectSettingsScope")}</p>
      ${this.saveError === undefined ? null : html`<div class="ui-form-error" role="alert">${messages.t("saveProjectSettingsFailed", { error: this.saveError })}</div>`}
      <div class="ui-form-field">
        <label for="project-name">${messages.t("nameLabel")}</label>
        <input class="ui-input" id="project-name" name="name" type="text" dir="auto" maxlength="120" autocomplete="off" aria-describedby="project-name-help" ?readonly=${this.submitting} .value=${this.name} @input=${(event: InputEvent) => { if (event.target instanceof HTMLInputElement) this.name = event.target.value; }} />
        <small id="project-name-help" class="hint">${messages.t("nameHelp")}</small>
      </div>
      <div class="ui-form-field">
        <label for="project-worktree-folder">${messages.t("projectWorktreeFolder")}</label>
        <input class="ui-input" id="project-worktree-folder" name="worktree-folder" type="text" dir="ltr" autocomplete="off" spellcheck="false" aria-describedby="project-worktree-help" ?readonly=${this.submitting || folderLocked} .value=${this.folder} @input=${(event: InputEvent) => { if (event.target instanceof HTMLInputElement) this.folder = event.target.value; }} />
        <small id="project-worktree-help" class="hint">${messages.t(folderLocked ? "projectWorktreeLocked" : "projectWorktreeHelp")}</small>
      </div>
      <dl class="effective-folder">
        <dt>${messages.t("savedWorktreeFolder")}</dt>
        <dd><bdi dir="ltr">${worktreeFolder.path}</bdi></dd>
        <dd class="hint">${folderSource(worktreeFolder)}</dd>
      </dl>
    `;
  }

  static override styles = [uiDialogStyles, uiFormStyles, css`
    :host { --ui-dialog-width: 480px; }
    .hint { color: var(--pi-muted); margin: 0; overflow-wrap: anywhere; }
    .effective-folder { margin: 0; overflow-wrap: anywhere; }
    .effective-folder dt { font-weight: 600; }
    .effective-folder dd { margin-inline-start: 0; }
  `];
}

function folderSource(folder: ProjectSettings["worktreeFolder"]): string {
  switch (folder.source) {
    case "project": return messages.t("folderSourceProject");
    case "machine": return messages.t("folderSourceMachine");
    case "deployment": return messages.t("folderSourceDeployment");
    case "environment": return folder.enforcedBy === undefined
      ? messages.t("folderSourceMachine") : messages.t("folderSourceEnvironment", { variable: folder.enforcedBy });
    case "suggested": return messages.t("folderSourceSuggested");
  }
}
