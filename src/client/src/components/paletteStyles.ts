import { css } from "lit";

/** Searchable modal chrome shared by Actions and Navigation. */
export const paletteStyles = css`
  :host { position: fixed; inset: 0; z-index: 20; color: var(--pi-text); font: 14px system-ui, sans-serif; }
  modal-surface { --palette-top: min(12dvh, 90px); --palette-bottom: max(20px, env(safe-area-inset-bottom)); --modal-surface-place-items: start center; --modal-surface-backdrop-padding: var(--palette-top) 20px var(--palette-bottom); --modal-surface-max-height: min(640px, calc(100dvh - var(--palette-top) - var(--palette-bottom))); }
  header { display: grid; grid-template-columns: 1fr auto; gap: 8px; padding: 10px; border-bottom: 1px solid var(--pi-border); }
  input { min-width: 0; border: 0; outline: none; background: transparent; color: var(--pi-text); font: var(--pi-control-font-size, 16px) var(--pi-control-font-family, system-ui, sans-serif); padding: 8px; }
  input::placeholder { color: var(--pi-dim); }
  button { border: 0; background: transparent; color: var(--pi-text); cursor: pointer; }
  header button { color: var(--pi-muted); font-size: 22px; padding: 2px 8px; }
  .options { flex: 1 1 auto; min-height: 0; overflow: auto; }
  .empty { padding: 24px; color: var(--pi-muted); text-align: center; }
`;
