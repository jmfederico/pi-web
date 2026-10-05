import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";

@customElement("extension-status-strip")
export class ExtensionStatusStrip extends LitElement {
  static override styles = css`
    :host { display: block; min-width: 0; color: var(--pi-text); font: 12px var(--pi-ui-font, system-ui, sans-serif); }
    .strip { min-width: 0; }
    ul { display: flex; flex-wrap: wrap; gap: 4px 12px; margin: 0; padding: 0; list-style: none; }
    .status { display: inline-flex; gap: 5px; min-width: 0; }
    .key { color: var(--pi-muted); font-weight: 600; }
    .value { min-width: 0; overflow-wrap: anywhere; }
    .empty { color: var(--pi-muted); }
  `;

  @property({ attribute: false }) statuses: Record<string, string> = {};

  override render() {
    const statuses = Object.entries(this.statuses)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .sort(([left], [right]) => left.localeCompare(right));
    if (statuses.length === 0) {
      return html`<div class="empty" role="status" aria-label="Extension status">No extension status reported</div>`;
    }
    return html`
      <section class="strip" aria-label="Extension status">
        <ul>
          ${statuses.map(([key, value]) => html`
            <li class="status"><span class="key">${key}:</span> <span class="value">${value}</span></li>
          `)}
        </ul>
      </section>
    `;
  }
}
