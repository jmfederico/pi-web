import { html, nothing, type ReactiveController, type ReactiveControllerHost } from "lit";
import { writeClipboardText } from "../clipboard";
import { projectWorkspaceMessages as messages } from "../projectWorkspaceMessages";

/** Shared copy feedback for entity menu details. */
export class DetailCopyController implements ReactiveController {
  private copiedKey: string | undefined;
  private failedKey: string | undefined;
  private resetTimer: ReturnType<typeof setTimeout> | undefined;
  private operation = 0;

  constructor(private readonly host: ReactiveControllerHost) {
    host.addController(this);
  }

  hostDisconnected(): void {
    this.operation += 1;
    clearTimeout(this.resetTimer);
    this.copiedKey = undefined;
    this.failedKey = undefined;
  }

  render(key: string, value: string, action: string, presentation: "icon" | "menu-item" = "icon") {
    const copied = this.copiedKey === key;
    const label = copied ? messages.t("copied") : action;
    return html`
      <button type="button" class=${presentation === "icon" ? "ui-button ui-button--compact ui-button--icon detail-copy" : "ui-button ui-menu-item"} title=${label} aria-label=${label} @click=${() => { void this.copy(key, value); }}>
        ${presentation === "icon" ? html`<span aria-hidden="true">${copied ? "✓" : "⧉"}</span>` : label}
      </button>
      ${this.failedKey === key ? html`<span class="action-menu-description action-menu-error" role="alert">${messages.t("copyDetailFailed")}</span>` : nothing}
    `;
  }

  private async copy(key: string, value: string): Promise<void> {
    const operation = ++this.operation;
    const copied = await writeClipboardText(value);
    if (operation !== this.operation) return;
    clearTimeout(this.resetTimer);
    this.copiedKey = copied ? key : undefined;
    this.failedKey = copied ? undefined : key;
    this.host.requestUpdate();
    if (copied) {
      this.resetTimer = setTimeout(() => {
        this.copiedKey = undefined;
        this.host.requestUpdate();
      }, 1200);
    }
  }
}
