import { html, type TemplateResult } from "lit";

export type ActivityIndicatorKind = "session" | "terminal" | "sending" | "unread";

export function renderActivityIndicator(kind: ActivityIndicatorKind | undefined, label = "Active"): TemplateResult | undefined {
  if (kind === undefined) return undefined;
  return html`<span class=${`activity-indicator ${kind}`} role="img" aria-label=${label} title=${label}></span>`;
}

export function renderActionActivityIndicator(kind: ActivityIndicatorKind | undefined, label = "Active"): TemplateResult | undefined {
  const indicator = renderActivityIndicator(kind, label);
  if (indicator === undefined) return undefined;
  return html`<span class="action-activity">${indicator}</span>`;
}
