import { LitElement, html } from "lit";
import type { ChatContentRendering } from "../formatting/contentRendering";
import { customElement, property } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { writeClipboardText } from "../clipboard";
import { toSafeMarkdownHtml } from "../formatting/markdown";
import type { MarkdownWorkspaceContext, WorkspaceFileOpenRequest } from "../formatting/workspaceLinks";
import { formattedTextStyles } from "./shared";

@customElement("formatted-text")
export class FormattedText extends LitElement {
  @property() text = "";
  @property() intentKey: string | undefined;
  @property({ attribute: false }) contentRendering: ChatContentRendering | undefined;
  @property() machineId = "local";
  @property({ attribute: false }) workspaceContext: MarkdownWorkspaceContext | undefined;

  override render() {
    const content = this.contentRendering?.renderMarkdown({
      text: this.text,
      machineId: this.workspaceContext?.machineId ?? this.machineId,
      toSafeHtml: (text) => toSafeMarkdownHtml(text, this.workspaceContext, this.intentKey),
    }, this.intentKey) ?? unsafeHTML(toSafeMarkdownHtml(this.text, this.workspaceContext, this.intentKey));
    return html`<div class="formatted" dir="auto" @click=${this.onFormattedClick}>${content}</div>`;
  }

  override updated(): void {
    this.enhanceCodeBlocks();
  }

  private enhanceCodeBlocks(): void {
    this.renderRoot.querySelectorAll("pre").forEach((element) => {
      if (!(element instanceof HTMLPreElement) || element.parentElement?.classList.contains("code-block-wrapper") === true) return;
      const code = element.querySelector("code");
      if (!(code instanceof HTMLElement)) return;
      const wrapper = document.createElement("div");
      wrapper.className = "code-block-wrapper";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "code-copy-button";
      button.title = "Copy code block";
      button.setAttribute("aria-label", "Copy code block");
      const icon = document.createElement("span");
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = "⧉";
      button.append(icon);
      element.before(wrapper);
      wrapper.append(element, button);
    });
  }

  private readonly onFormattedClick = (event: MouseEvent): void => {
    if (!(event.target instanceof Element)) return;
    const anchor = event.target.closest("a[data-workspace-file]");
    if (anchor instanceof HTMLAnchorElement && this.workspaceContext !== undefined
      && !event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey
      && (!anchor.target || anchor.target === "_self")) {
      const path = anchor.getAttribute("data-workspace-file");
      if (path !== null) {
        const request = new CustomEvent<WorkspaceFileOpenRequest>("workspace-file-open", {
          detail: { ...this.workspaceContext, path }, bubbles: true, composed: true, cancelable: true,
        });
        if (!this.dispatchEvent(request)) event.preventDefault();
      }
      return;
    }
    const button = event.target.closest(".code-copy-button");
    if (!(button instanceof HTMLButtonElement)) return;
    const wrapper = button.closest(".code-block-wrapper");
    if (!(wrapper instanceof HTMLElement)) return;
    const code = wrapper.querySelector("pre code");
    if (!(code instanceof HTMLElement)) return;
    void this.copyCode(code.textContent, button);
  };

  private async copyCode(text: string, button: HTMLButtonElement): Promise<void> {
    const copied = await writeClipboardText(text);
    this.setCopyButtonState(button, copied ? "copied" : "failed");
    window.setTimeout(() => {
      this.setCopyButtonState(button, "idle");
    }, 1200);
  }

  private setCopyButtonState(button: HTMLButtonElement, state: "idle" | "copied" | "failed"): void {
    const icon = button.querySelector("span");
    if (icon !== null) icon.textContent = state === "copied" ? "✓" : "⧉";
    const label = state === "copied" ? "Copied code block" : state === "failed" ? "Failed to copy code block" : "Copy code block";
    button.title = label;
    button.setAttribute("aria-label", label);
  }

  static override styles = formattedTextStyles;
}
