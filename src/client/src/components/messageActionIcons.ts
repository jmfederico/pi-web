import { html } from "lit";

export function renderCopyIcon() {
  return html`<span aria-hidden="true">⧉</span>`;
}

export function renderGoBackIcon() {
  return html`<svg aria-hidden="true" focusable="false" width="16" height="16" viewBox="-3 -3 30 30" fill="none" stroke="currentColor" stroke-width="0.85" stroke-linecap="round" stroke-linejoin="round"><path vector-effect="non-scaling-stroke" d="M4 5h11a6 6 0 0 1 0 12H4m5-5-5 5 5 5" /></svg>`;
}

export function renderTrashIcon() {
  return html`<svg aria-hidden="true" focusable="false" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M5 6l1 14a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1l1-14M10 10v7M14 10v7" /></svg>`;
}
