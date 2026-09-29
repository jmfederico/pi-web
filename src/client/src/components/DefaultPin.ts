import { css, html } from "lit";

/** Shared native control, rendered in the picker's DOM beside (never inside) its row button. */
export function defaultPin(label: string, active: boolean, disabled: boolean, onClick: () => void) {
  const help = `Use ${label} as default for new sessions`;
  return html`<button type="button" class="default-pin" aria-label=${help} title=${help}
    aria-pressed=${String(active)} ?disabled=${disabled} @click=${onClick}>
    <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill=${active ? "currentColor" : "none"} stroke="currentColor" stroke-width="1.8">
      <path stroke-linejoin="round" d="m12 3 2.78 5.63L21 9.54l-4.5 4.39 1.06 6.2L12 17.2l-5.56 2.93 1.06-6.2L3 9.54l6.22-.91Z" />
    </svg>
  </button>`;
}

export const defaultPinHelp = html`<div class="default-help"><strong>New session default</strong></div>`;

export const defaultPinStyles = css`
  .default-help { display: flex; justify-content: space-between; gap: 12px; padding: 8px 12px; color: var(--pi-muted); }
  .default-row { display: flex; align-items: center; border-bottom: 1px solid var(--pi-border-muted); }
  .options .default-row > button:not(.default-pin) { flex: 1; min-width: 0; width: auto; display: block; padding: 10px 12px; text-align: left; border-bottom: 0; }
  .options .default-row > button.selected { background: var(--pi-selection-bg); }
  .options button.default-pin { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px; padding: 0; margin: 0 6px; border: 0; border-radius: 6px; }
  .default-pin[aria-pressed="true"] { color: var(--pi-accent); }
  .default-pin:disabled { opacity: 0.45; cursor: default; }
  .default-pin:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: -2px; }
`;
