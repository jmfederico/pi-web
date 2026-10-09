import { html, nothing, type TemplateResult } from "lit";
import type { SessionLabelItem } from "../plugins/types";

export function renderSessionLabelItems(items: SessionLabelItem[]): TemplateResult[] {
  return items.map((item, index) => html`${index === 0 ? null : html`<span class="session-label-separator" aria-hidden="true">·</span>`}${renderSessionLabelItem(item)}`);
}

function renderSessionLabelItem(item: SessionLabelItem): TemplateResult {
  if (item.type === "render") return html`<span class="session-label-render">${item.render()}</span>`;
  if (item.type === "link" && isSafeHref(item.href)) {
    const target = item.target ?? "_blank";
    return html`<a class="session-label-item" href=${item.href} title=${item.title ?? item.text} target=${target} rel=${target === "_blank" ? "noopener noreferrer" : nothing}>${item.text}</a>`;
  }
  return html`<span class="session-label-item" title=${item.title ?? item.text}>${item.text}</span>`;
}

function isSafeHref(href: string): boolean {
  if (href.trim() === "") return false;
  try {
    // Parse rather than prefix-match: URL parsing also strips embedded controls.
    return ["http:", "https:", "mailto:", "tel:"].includes(new URL(href, "https://pi-web.invalid/").protocol);
  } catch {
    return false;
  }
}
