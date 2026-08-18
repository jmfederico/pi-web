import { html, type TemplateResult } from "lit";

/**
 * The shared error banner. It stays until the user dismisses it, another
 * message replaces it, or the owning action clears it, so a background refresh
 * cannot hide a failure the user has not read yet.
 */
export function errorBanner(error: string, onDismiss: () => void): TemplateResult | null {
  if (error === "") return null;
  return html`<div class="error" role="alert">
    <span class="error-text">${error}</span>
    <button type="button" class="error-dismiss" aria-label="Dismiss error" title="Dismiss error" @click=${() => { onDismiss(); }}>✕</button>
  </div>`;
}
