import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { toSafeMarkdownHtml } from "../formatting/markdown";
import { formattedTextStyles } from "./shared";

@customElement("formatted-text")
export class FormattedText extends LitElement {
  @property() text = "";

  override render() {
    return html`<div class="formatted" @click=${this.onFormattedClick}>${unsafeHTML(toSafeMarkdownHtml(this.text))}</div>`;
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
      button.textContent = "Copy";
      button.setAttribute("aria-label", "Copy code block");
      element.before(wrapper);
      wrapper.append(element, button);
    });
  }

  private readonly onFormattedClick = (event: MouseEvent): void => {
    if (!(event.target instanceof HTMLButtonElement) || !event.target.classList.contains("code-copy-button")) return;
    const wrapper = event.target.closest(".code-block-wrapper");
    if (!(wrapper instanceof HTMLElement)) return;
    const code = wrapper.querySelector("pre code");
    if (!(code instanceof HTMLElement)) return;
    void this.copyCode(code.textContent, event.target);
  };

  private async copyCode(text: string, button: HTMLButtonElement): Promise<void> {
    const ok = await writeClipboard(text);
    button.textContent = ok ? "Copied" : "Failed";
    window.setTimeout(() => {
      button.textContent = "Copy";
    }, 1200);
  }

  static override styles = formattedTextStyles;
}

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
