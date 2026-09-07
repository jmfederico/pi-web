import { html, type TemplateResult } from "lit";
import type { ServerNoticeSeverity } from "../../../shared/apiTypes";

/**
 * The shared application banner. Browser-local failures use the default error
 * severity; server-owned notices reuse the same presentation with their own
 * severity and dismissal callback.
 */
export function errorBanner(error: string, onDismiss: () => void, severity: ServerNoticeSeverity = "error"): TemplateResult | null {
  if (error === "") return null;
  const severityLabel = bannerSeverityLabel(severity);
  const dismissLabel = `Dismiss ${severityLabel.toLowerCase()}`;
  return html`<div class=${`error ${severity}`} role="alert">
    <span class="error-text">${error}</span>
    <button type="button" class="error-dismiss" aria-label=${dismissLabel} title=${dismissLabel} @click=${() => { onDismiss(); }}>✕</button>
  </div>`;
}

function bannerSeverityLabel(severity: ServerNoticeSeverity): "Info" | "Warning" | "Error" {
  if (severity === "error") return "Error";
  if (severity === "warning") return "Warning";
  return "Info";
}
