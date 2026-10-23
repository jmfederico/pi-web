import { stylesheetIntegrationCapability } from "../plugins/styles";
import { LitElement, css, html, type PropertyValues, type TemplateResult } from "lit";
import { VisibleContentController } from "../formatting/deferredContent";
import type { ChatContentRendering } from "../formatting/contentRendering";
import { customElement, property } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { writeClipboardText } from "../clipboard";
import { toSafeMarkdownHtml } from "../formatting/markdown";
import { DEFAULT_CODE_BLOCK_POLICY, type CodeBlockPolicy } from "../formatting/codeBlockPolicy";
import { rememberExternalMarkdownImageDimensions, restoreExternalMarkdownImageDimensions } from "../formatting/externalMarkdownImages";
import type { MarkdownWorkspaceContext, WorkspaceFileOpenRequest } from "../formatting/workspaceLinks";
import { formattedTextStyles } from "./formattedTextStyles";
import { codeBlockFrameStyles } from "./codeBlockFrameStyles";

@customElement("formatted-text")
export class FormattedText extends LitElement {
  constructor() {
    super();
    stylesheetIntegrationCapability.createController(this);
  }

  @property() text = "";
  @property() intentKey: string | undefined;
  @property({ type: Boolean }) imagesEnabled = true;
  @property({ attribute: false }) codeBlocks: CodeBlockPolicy = DEFAULT_CODE_BLOCK_POLICY;
  @property({ attribute: false }) contentRendering: ChatContentRendering | undefined;
  @property() machineId = "local";
  @property({ attribute: false }) workspaceContext: MarkdownWorkspaceContext | undefined;

  private readonly enhancement = new VisibleContentController(this);
  private phase: "markdown" | "preview" | "done" = "markdown";
  private scheduled = false;
  private markup: string | undefined;
  private content: TemplateResult | undefined;
  private displayedText = "";
  private replacing = false;
  private layoutChanged = false;

  protected override willUpdate(changes: PropertyValues<this>): void {
    const inputs = ["text", "intentKey", "imagesEnabled", "codeBlocks", "contentRendering", "machineId", "workspaceContext"] as const;
    if (!inputs.some((key) => changes.has(key))) return;
    this.enhancement.cancel();
    this.scheduled = false;
    this.phase = "markdown";
    this.markup = undefined;
    // Retain stable source controls and completed previews while prose streams.
    // New identities/replacements must never show the previous content.
    this.replacing = !this.text.startsWith(this.displayedText) || changes.has("intentKey") || changes.has("machineId") || changes.has("workspaceContext");
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.requestUpdate();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.scheduled = false;
  }

  override render() {
    const className = this.codeBlocks.overflow === "scroll" ? "formatted code-blocks-scroll" : "formatted";
    // Source is ordinary escaped Lit text. Neither Markdown nor plugin code is
    // called by this render or by the session-loading flow. Once formatted, keep
    // that view until its update is ready: a raw tail after a Markdown block adds
    // a temporary line on every streaming chunk.
    const showSource = this.replacing || this.content === undefined;
    return html`<div class=${className} dir="auto" @load=${this.onImageLoad} @click=${this.onFormattedClick}><div class="enhanced-content" ?hidden=${this.replacing}>${this.content}</div><span class="pending-source" ?hidden=${!showSource}>${showSource ? this.text : ""}</span></div>`;
  }

  override updated(): void {
    if (this.phase !== "done" && !this.scheduled) {
      this.scheduled = true;
      this.enhancement.request(() => {
        this.scheduled = false;
        if (this.phase === "markdown") this.formatMarkdown();
        else if (this.phase === "preview") this.enhanceMarkdown();
        this.requestUpdate();
      });
    }
    // HTML is memoized independently of geometry; apply hints on every DOM mount,
    // in this update's microtask before paint or the chat's position-restoration frame.
    restoreExternalMarkdownImageDimensions(this.renderRoot);
    if (this.layoutChanged) {
      this.layoutChanged = false;
      this.dispatchEvent(new CustomEvent("content-layout-changed", { bubbles: true, composed: true }));
    }
  }

  private formatMarkdown(): void {
    try {
      this.markup = toSafeMarkdownHtml(this.text, this.workspaceContext, this.intentKey, this.imagesEnabled, this.codeBlocks);
      if (this.codeBlocks.previews && this.contentRendering !== undefined) {
        this.phase = "preview";
        if (this.content === undefined) this.showMarkdown();
      } else {
        this.showMarkdown();
        this.phase = "done";
      }
    } catch (error) {
      console.warn("Chat Markdown formatting failed; source remains available", error);
      this.replacing = true;
      this.phase = "done";
    }
  }

  private showMarkdown(): void {
    this.layoutChanged = true;
    this.content = html`${unsafeHTML(this.markup)}`;
    this.displayedText = this.text;
    this.replacing = false;
  }

  private enhanceMarkdown(): void {
    try {
      this.layoutChanged = true;
      this.content = this.contentRendering?.renderMarkdown({
        text: this.text,
        machineId: this.workspaceContext?.machineId ?? this.machineId,
        toSafeHtml: (text) => text === this.text && this.markup !== undefined ? this.markup
          : toSafeMarkdownHtml(text, this.workspaceContext, this.intentKey, this.imagesEnabled, this.codeBlocks),
      }, this.intentKey, this.codeBlocks);
      this.displayedText = this.text;
      this.replacing = false;
    } catch (error) {
      console.warn("Chat content enhancement failed; Markdown remains available", error);
      this.showMarkdown();
    }
    this.phase = "done";
  }

  private readonly onImageLoad = {
    // Native image loads do not bubble. Capture only inside this formatting root.
    capture: true,
    handleEvent: (event: Event): void => {
      if (event.target instanceof HTMLImageElement) rememberExternalMarkdownImageDimensions(event.target);
    },
  };

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
    const code = wrapper.querySelector("pre code, .plain-code-block");
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

  static override styles = [formattedTextStyles, codeBlockFrameStyles, css`
    .pending-source { white-space: pre-wrap; overflow-wrap: anywhere; }
    .enhanced-content { display: contents; }
    .enhanced-content[hidden] { display: none; }
  `];
}
