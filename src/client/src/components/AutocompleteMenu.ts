import { LocalizationController } from "../localization/browser";
import { promptEditorMessages as messages } from "../promptEditorMessages";
import { stylesheetIntegrationCapability } from "../plugins/styles";
import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { AnchoredPopupController } from "./anchoredPopup";
import { scrollWhenSelected } from "./scrollWhenSelected";
import { autocompleteStyles, type CompletionItem } from "./shared";

@customElement("autocomplete-menu")
export class AutocompleteMenu extends LitElement {
  constructor() {
    super();
    stylesheetIntegrationCapability.createController(this);
    new LocalizationController(this);
  }

  @property({ attribute: false }) anchor?: HTMLElement;
  @property({ attribute: false }) onClose?: () => void;
  readonly popup: AnchoredPopupController = new AnchoredPopupController(this, () => {
    const panel = this.renderRoot.querySelector<HTMLElement>(".menu");
    return panel ? {
      anchor: this.anchor ?? this.parentElement ?? this, panel,
      onClose: () => { this.items = []; this.onClose?.(); },
      options: { placement: "above-start", gap: 6, width: "anchor", maxHeight: 260, preserveFocus: true },
    } : undefined;
  });

  @property({ attribute: false }) items: CompletionItem[] = [];
  @property({ type: Number }) selectedIndex = 0;
  @property({ attribute: false }) onPick?: (item: CompletionItem) => void;

  override render() {
    if (!this.items.length) return null;
    return html`
      <div class="menu ui-popup-panel" data-ui-context="completions" popover="auto">
        ${this.items.map((item, index) => html`
          <button class=${index === this.selectedIndex ? "ui-choice selected" : "ui-choice"} data-selected=${index === this.selectedIndex} ${scrollWhenSelected(index === this.selectedIndex, item)} @mousedown=${(event: MouseEvent) => { event.preventDefault(); this.onPick?.(item); }}>
            <span class="label" dir="auto"><strong>${item.insertText}</strong>${item.argumentHint === undefined || item.argumentHint === "" ? null : html` <span class="argument-hint">${item.argumentHint}</span>`}</span>
            <span class="detail">${item.kind === "file" ? messages.t("fileKind", { kind: item.detail }) : item.detail}</span>
            ${item.description !== undefined && item.description !== "" ? html`<small>${item.description}</small>` : null}
          </button>
        `)}
      </div>
    `;
  }

  static override styles = autocompleteStyles;
}
