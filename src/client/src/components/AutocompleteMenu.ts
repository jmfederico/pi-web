import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { scrollWhenSelected } from "./scrollWhenSelected";
import { autocompleteStyles, type CompletionItem } from "./shared";

@customElement("autocomplete-menu")
export class AutocompleteMenu extends LitElement {
  @property({ attribute: false }) items: CompletionItem[] = [];
  @property({ type: Number }) selectedIndex = 0;
  @property({ attribute: false }) onPick?: (item: CompletionItem) => void;

  override render() {
    if (!this.items.length) return null;
    return html`
      <div class="menu">
        ${this.items.map((item, index) => html`
          <button class=${index === this.selectedIndex ? "selected" : ""} ${scrollWhenSelected(index === this.selectedIndex, item)} @mousedown=${(event: MouseEvent) => { event.preventDefault(); this.onPick?.(item); }}>
            <span class="label"><strong>${item.insertText}</strong>${item.argumentHint === undefined || item.argumentHint === "" ? null : html` <span class="argument-hint">${item.argumentHint}</span>`}</span>
            <span class="detail">${item.detail}</span>
            ${item.description !== undefined && item.description !== "" ? html`<small>${item.description}</small>` : null}
          </button>
        `)}
      </div>
    `;
  }

  static override styles = autocompleteStyles;
}
