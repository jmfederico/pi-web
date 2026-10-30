import { css } from "lit";
import { uiButtonStyles, uiMenuStyles, uiToolbarStyles, uiTabStyles } from "./controlStyles";
import { chatNavigationStyles } from "./chatNavigationStyles";
import { promptEditorIntegrationStyles } from "./promptEditorIntegrationStyles";

// The base theme owns default shell layout and presentation; components retain behaviour.

/** Directional navigation shadow that avoids a halo above the fixed heading edge. */
export const scrollBoundaryShadow = css`0 8px 18px -8px var(--pi-shadow-soft)`;

export const appStyles = css`
  @layer pi-web-base {
  /* Mobile browsers already subtract browser controls from 100dvh; reserve bottom safe area only in standalone PWA modes. */
  :host { --pi-app-safe-area-bottom: 0px; position: fixed; top: 0; right: 0; left: 0; display: block; height: 100dvh; box-sizing: border-box; overflow: hidden; padding: env(safe-area-inset-top) env(safe-area-inset-right) var(--pi-app-safe-area-bottom) env(safe-area-inset-left); color: var(--pi-text); background: var(--pi-bg); font: 14px var(--pi-font, system-ui, sans-serif); }
  :host([pwa-display-mode]) { --pi-app-safe-area-bottom: env(safe-area-inset-bottom); }
  @media (display-mode: standalone), (display-mode: fullscreen), (display-mode: minimal-ui) {
    :host { --pi-app-safe-area-bottom: env(safe-area-inset-bottom); }
  }
  .shell { --navigation-panel-size: 340px; --workspace-panel-size: minmax(360px, 42vw); --navigation-panel-width: var(--navigation-panel-size); --workspace-panel-width: var(--workspace-panel-size); display: grid; grid-template-columns: var(--navigation-panel-width) 1px minmax(320px, 1fr) 1px var(--workspace-panel-width); height: 100%; min-height: 0; }
  aside { grid-column: 1; display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
  aside app-navigation-panel { flex: 1 1 auto; min-height: 0; }
  header { flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 12px; border-bottom: 1px solid var(--pi-border); }
  .header-actions { display: flex; align-items: center; gap: 8px; }
  main { grid-column: 3; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
  .context-bar { position: relative; flex: 0 0 auto; min-width: 0; display: none; align-items: center; gap: 0; padding: 6px 0; border-bottom: 1px solid var(--pi-border-muted); background: var(--pi-bg); }
  .context-bar::before, .context-bar::after { content: ""; position: absolute; top: 0; bottom: 0; z-index: 2; width: 20px; opacity: 0; pointer-events: none; transition: opacity .15s ease; }
  .context-bar::before { left: 0; background: linear-gradient(90deg, color-mix(in srgb, var(--pi-shadow-strong) 55%, transparent) 0%, transparent 100%); }
  .context-bar::after { right: 0; background: linear-gradient(270deg, color-mix(in srgb, var(--pi-shadow-strong) 55%, transparent) 0%, transparent 100%); }
  .context-bar.can-scroll-left::before, .context-bar.can-scroll-right::after { opacity: 1; }
  .context-bar-label { display: none; }
  .context-items { flex: 1 1 auto; min-width: 0; display: flex; align-items: stretch; gap: 5px; margin: 0; padding: 0 8px; list-style: none; overflow-x: auto; overflow-y: hidden; overscroll-behavior-x: contain; scroll-padding-inline: 8px; scrollbar-width: thin; }
  .context-bar.has-context-actions .context-items { padding-right: 52px; scroll-padding-inline: 8px 52px; }
  .context-item { flex: 0 0 auto; min-width: 0; display: flex; }
  .context-actions { position: absolute; top: 6px; right: 0; bottom: 6px; z-index: 3; display: flex; align-items: center; padding: 0 8px 0 0; pointer-events: none; }
  .context-actions::after { content: ""; position: absolute; top: 0; right: 0; bottom: 0; z-index: 0; width: 26px; background: var(--pi-bg); pointer-events: none; }
  .context-chip { flex: 0 0 auto; min-width: 0; display: inline-flex; align-items: baseline; gap: 5px; border: 1px solid var(--pi-border-muted); border-radius: 999px; background: var(--pi-surface); color: var(--pi-text); padding: 4px 8px; font: inherit; text-align: left; }
  .context-chip:hover { background: var(--pi-surface-hover); }
  .context-chip:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 2px; }
  .context-chip.empty { border-style: dashed; color: var(--pi-muted); }
  .context-kind { display: none; }
  .context-value { min-width: 0; overflow: visible; text-overflow: clip; white-space: nowrap; }
  app-mobile-main-tabs { display: none; }
  app-mobile-main-tabs[panel-controls] { display: block; }
  .mobile-tabs-frame { position: relative; display: none; flex: 0 0 auto; min-width: 0; border-bottom: 1px solid var(--pi-border); background: var(--pi-bg); }
  .mobile-tabs-frame::before, .mobile-tabs-frame::after { content: ""; position: absolute; top: 0; bottom: 0; z-index: 2; width: 20px; opacity: 0; pointer-events: none; transition: opacity .15s ease; }
  .mobile-tabs-frame::before { left: 0; background: linear-gradient(90deg, color-mix(in srgb, var(--pi-shadow-strong) 55%, transparent) 0%, transparent 100%); }
  .mobile-tabs-frame::after { right: 0; background: linear-gradient(270deg, color-mix(in srgb, var(--pi-shadow-strong) 55%, transparent) 0%, transparent 100%); }
  .mobile-tabs-frame.can-scroll-left::before, .mobile-tabs-frame.can-scroll-right::after { opacity: 1; }
  .mobile-tabs { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 6px; padding: 8px; overflow-x: auto; overflow-y: hidden; overscroll-behavior-x: contain; scrollbar-width: thin; }
  .mobile-tabs button { flex: 0 0 auto; white-space: nowrap; }
  .mobile-navigation-tab, .mobile-navigation-panel { display: none; }
  .mobile-tabs button.selected { border-color: var(--pi-accent); background: var(--pi-selection-bg); }
  .tab-badge { display: inline-block; min-width: 14px; margin-left: 4px; border: 1px solid var(--pi-success-border); border-radius: 999px; background: var(--pi-success-surface); color: var(--pi-success); padding: 0 5px; font-size: 11px; line-height: 16px; text-align: center; }
  workspace-panel { grid-column: 5; min-width: 0; min-height: 0; overflow: hidden; }
  @media (min-width: 1181px) {
    .shell.navigation-panel-collapsed { --navigation-panel-width: 0px; }
    .shell.navigation-panel-collapsed > aside { display: none; }
    .shell.two-column-layout.workspace-panel-collapsed { grid-template-columns: var(--navigation-panel-width) 1px minmax(0, 1fr) 1px; }
    .shell.workspace-panel-collapsed > app-panel-edge-control[side="workspace"] { grid-row: 1 / 3; }
  }
  .shell.two-column-layout { grid-template-columns: var(--navigation-panel-width) 1px minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); }
  .shell.two-column-layout.navigation-panel-collapsed { --navigation-panel-width: 0px; }
  .shell.two-column-layout.navigation-panel-collapsed > aside { display: none; }
  .two-column-layout > aside, .two-column-layout > app-panel-edge-control[side="navigation"] { grid-row: 1 / 3; }
  .two-column-layout main { grid-column: 3; grid-row: 1 / 3; }
  .two-column-layout app-mobile-main-tabs { display: block; flex: 0 0 auto; min-width: 0; }
  .two-column-layout .mobile-tabs-frame { display: flex; }
  .shell.two-column-layout.workspace-view main { grid-row: 1; min-height: auto; }
  .shell.two-column-layout.workspace-view > workspace-panel { grid-column: 3; grid-row: 2; display: flex; border-left: 0; }
  .shell.two-column-layout:not(.workspace-view) > workspace-panel { display: none; }
  .two-column-layout main.workspace-view conversation-layout,
  .two-column-layout main.workspace-view .empty { display: none; }
  .two-column-layout main.workspace-view { overflow: hidden; }
  @media (max-width: 760px) {
    .shell.two-column-layout { grid-template-columns: minmax(0, 1fr); }
    aside { display: none; }
    .two-column-layout main, .shell.two-column-layout.workspace-view > workspace-panel { grid-column: 1; }
    .context-bar { display: flex; }
    .mobile-navigation-tab { display: block; }
    main.navigation-view conversation-layout,
    main.navigation-view .empty { display: none; }
    main.navigation-view .mobile-navigation-panel { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
    main.navigation-view .mobile-navigation-panel app-navigation-panel { flex: 1 1 auto; min-height: 0; }
  }
  status-bar { flex: 0 0 auto; }
  conversation-layout { flex: 1 1 auto; min-width: 0; min-height: 0; }
  .composer-area { display: grid; min-width: 0; background: var(--pi-bg); }
  /* Share a grid cell instead of adding banner height; allow long notices to grow the area rather than clip their controls. */
  .composer-area > prompt-editor, .composer-activity-notice { grid-area: 1 / 1; min-width: 0; }
  .composer-area > prompt-editor[inert] { visibility: hidden; }
  .composer-activity-notice { z-index: 6; display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 12px 16px; border-top: 1px solid var(--pi-warning-border); background: var(--pi-warning-surface); color: var(--pi-warning); }
  .composer-activity-notice-text { flex: 1 1 240px; min-width: 0; overflow-wrap: anywhere; }
  .composer-activity-notice p { margin: 0; }
  .composer-activity-notice button { flex: 0 0 auto; }
  button { border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); color: var(--pi-text); padding: 7px 9px; cursor: pointer; }
  .empty { margin: auto; color: var(--pi-muted); }
  .error { display: flex; gap: 8px; align-items: flex-start; padding: 10px 16px; border-bottom: 1px solid var(--pi-border); color: var(--pi-danger); }
  .error.warning { border-bottom-color: var(--pi-warning-border); color: var(--pi-warning); background: var(--pi-warning-surface); }
  .error.info { border-bottom-color: var(--pi-accent-border); color: var(--pi-text); background: var(--pi-selection-bg); }
  .error .error-text { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
  .error .error-dismiss { flex: 0 0 auto; padding: 0 6px; border: 0; background: none; color: inherit; line-height: 1.4; }
  .deprecation-notice { padding: 10px 16px; border-bottom: 1px solid var(--pi-border); color: var(--pi-warning); }
  .deprecation-notice .deprecation-notice-text { margin: 0; overflow-wrap: anywhere; }
  .deprecation-notice .deprecation-notice-text + .deprecation-notice-text { margin-top: 4px; }
  }
`;

export const workspacePanelStyles = css`
  ${uiButtonStyles}
  ${uiToolbarStyles}
  ${uiTabStyles}
  @layer pi-web-base {
  :host { display: flex; flex-direction: column; min-height: 0; color: var(--pi-text); background: var(--pi-bg); font: 13px var(--pi-font, system-ui, sans-serif); container-type: inline-size; }
  header { display: flex; align-items: stretch; flex: 0 0 auto; min-width: 0; border-bottom: 1px solid var(--pi-border); }
  .navigation-menu-button { flex: 0 0 auto; justify-content: center; min-width: 44px; margin: 0; }
  .panel-toggle { margin-inline-start: auto; border-inline-start: 1px solid var(--pi-border-muted); }
  .workspace-header-scroll-frame { flex: 1 1 auto; display: flex; position: relative; min-width: 0; background: var(--pi-bg); }
  .workspace-header-scroll-frame::before, .workspace-header-scroll-frame::after { content: ""; position: absolute; top: 0; bottom: 0; z-index: 2; width: 18px; opacity: 0; pointer-events: none; transition: opacity .15s ease; }
  .workspace-header-scroll-frame::before { left: 0; background: linear-gradient(90deg, color-mix(in srgb, var(--pi-shadow-strong) 55%, transparent) 0%, transparent 100%); }
  .workspace-header-scroll-frame::after { right: 0; background: linear-gradient(270deg, color-mix(in srgb, var(--pi-shadow-strong) 55%, transparent) 0%, transparent 100%); }
  .workspace-header-scroll-frame.can-scroll-left::before, .workspace-header-scroll-frame.can-scroll-right::after { opacity: 1; }
  .workspace-header-strip { flex: 1 1 auto; display: flex; justify-content: space-between; align-items: stretch; gap: 0; min-width: 0; padding: 0; overflow-x: auto; overflow-y: hidden; overscroll-behavior-x: contain; scrollbar-width: thin; }
  .tabs button.icon-tab { min-width: 44px; }
  .tab-icon { flex: 0 0 auto; width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; pointer-events: none; }
  .tab-custom-icon { flex: 0 0 auto; width: 16px; height: 16px; display: inline-grid; place-items: center; color: currentColor; pointer-events: none; }
  .tab-custom-icon svg { width: 16px; height: 16px; pointer-events: none; }
  .tab-label { min-width: 0; }
  .tab-badge { flex: 0 0 auto; display: inline-block; min-width: 14px; border: 1px solid var(--pi-success-border); border-radius: 999px; background: var(--pi-success-surface); color: var(--pi-success); padding: 0 5px; font-size: 11px; line-height: 16px; text-align: center; }
  @container (max-width: 430px) {
    .tabs button.icon-tab { justify-content: center; padding-inline: 10px; }
  }
  .panel-content { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; overflow: auto; }
  .empty-state { box-sizing: border-box; width: min(100%, 380px); margin: auto; padding: 24px; display: grid; gap: 8px; color: var(--pi-muted); text-align: center; }
  .empty-state h2 { margin: 0; color: var(--pi-text); font-size: 15px; line-height: 1.3; }
  .empty-state p { margin: 0; line-height: 1.45; }
  small, .muted { color: var(--pi-muted); }
  @media (max-width: 1180px) { header { display: none; } }
  .workspace-label { min-width: 0; display: inline-flex; align-items: baseline; gap: 5px; max-width: 100%; overflow: hidden; white-space: nowrap; }
  .workspace-label-base, .workspace-label-item, .workspace-label-render { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .workspace-label-item, .workspace-label-render, .workspace-label-separator { color: var(--pi-muted); }
  .workspace-label-link { color: var(--pi-accent); text-decoration: none; }
  .workspace-label-link:hover, .workspace-label-link:focus { text-decoration: underline; }
  }
`;

export const listStyles = css`
  ${uiButtonStyles}
  ${uiToolbarStyles}
  ${uiMenuStyles}
  @layer pi-web-base {
  :host { display: flex; flex-direction: column; min-height: 0; overflow: hidden; color: var(--pi-text); font: 14px var(--pi-font, system-ui, sans-serif); }
  :host([collapsed]) { flex: 0 0 auto; min-height: auto; overflow: hidden; }
  section { box-sizing: border-box; flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; padding: 0; }
  h2 { flex: 0 0 auto; margin: 0; color: var(--pi-muted); font-size: 12px; text-transform: uppercase; }
  section > h2 { position: relative; z-index: 3; background: var(--pi-bg); box-shadow: ${scrollBoundaryShadow}; }
  .list-body { flex: 1 1 auto; min-height: 0; overflow: auto; }
  .list-status { padding: 10px; color: var(--pi-muted); }
  .subheading { margin-top: 14px; }
  .section-toggle { width: 100%; gap: 8px; }
  .section-toggle span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .section-title { display: grid; gap: 2px; min-width: 0; }
  .section-toggle .section-selected { display: block; color: var(--pi-text); font-size: 12px; font-weight: 600; line-height: 1.25; text-transform: none; }
  .section-toggle .section-count { flex: 0 0 auto; display: inline; color: var(--pi-muted); font-size: inherit; }
  .section-toggle small { display: inline; color: inherit; font-size: inherit; }
  .action-row { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) auto; margin: 6px 0; cursor: pointer; }
  .action-row:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 2px; border-radius: 8px; }
  .action-row.selected .action-main { border-color: var(--pi-accent); background: var(--pi-selection-bg); }
  .action-row.archived .action-main { color: var(--pi-muted); }
  .action-main { position: relative; box-sizing: border-box; min-width: 0; width: 100%; border: 1px solid var(--pi-border); border-top-right-radius: 0; border-bottom-right-radius: 0; border-top-left-radius: 8px; border-bottom-left-radius: 8px; background: var(--pi-surface); color: var(--pi-text); padding: 7px 22px 7px calc(9px + var(--depth, 0) * 16px); text-align: left; }
  .action-name { display: -webkit-box; max-height: 2.5em; overflow: hidden; overflow-wrap: anywhere; line-height: 1.25; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
  .action-row:not(.selected):hover .action-main { background: var(--pi-surface-hover); }
  .workspace-row .action-main { border-radius: 8px 0 0 8px; }
  .workspace-primary { min-width: 0; display: flex; align-items: baseline; gap: 6px; }
  .workspace-primary-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .workspace-status { flex: 0 0 auto; color: var(--pi-warning); font-size: 12px; }
  .workspace-secondary { margin-top: 3px; }
  .workspace-menu-actions { margin: 0 0 8px; padding-bottom: 8px; border-bottom: 1px solid var(--pi-border-muted); }
  .workspace-menu-details { display: grid; gap: 6px; margin: 0; padding: 0 9px 5px; }
  .workspace-detail-row { display: grid; grid-template-columns: minmax(58px, max-content) minmax(0, 1fr); gap: 8px; align-items: baseline; }
  .workspace-detail-row dt { color: var(--pi-muted); font-size: 12px; white-space: normal; }
  .workspace-detail-row dd { min-width: 0; margin: 0; overflow-wrap: anywhere; white-space: normal; }
  .detail-copy { margin-left: 6px; vertical-align: middle; }
  .tree-marker { color: var(--pi-dim); margin-right: 5px; }
  .badge { display: inline-block; margin-left: 5px; border: 1px solid var(--pi-border); border-radius: 999px; color: var(--pi-muted); padding: 0 5px; font-size: 11px; font-weight: 400; }
  .action-activity { position: absolute; top: 50%; inset-inline-start: calc(6px + var(--depth, 0) * 16px + var(--agent-offset, 0px)); transform: translateY(-50%); z-index: 1; display: grid; place-items: center; width: 10px; height: 10px; }
  .action-activity .activity-indicator { margin: 0; vertical-align: 0; }
  .activity-indicator { flex: 0 0 auto; display: inline-block; width: 7px; height: 7px; margin-right: 6px; background: var(--pi-success); animation: pulse 1s ease-in-out infinite; vertical-align: 1px; }
  .activity-indicator.session { border-radius: 50%; background: var(--pi-success); }
  .activity-indicator.terminal { border-radius: 2px; background: var(--pi-accent); }
  /* Client-side sending (upload in flight); distinct from server activity, which propagates to workspace/machine rows. */
  .activity-indicator.sending { border-radius: 50%; background: var(--pi-warning); }
  /* Blocked on the user: a static hollow ring, so it reads as neither work nor unread. */
  .activity-indicator.question { border-radius: 50%; background: transparent; box-shadow: inset 0 0 0 2px var(--pi-accent); animation: none; }
  /* Unread is a stable state, not ongoing work: keep it static and accent-colored. */
  .activity-indicator.unread { border-radius: 50%; background: var(--pi-accent); animation: none; box-shadow: 0 0 0 2px color-mix(in srgb, var(--pi-accent) 20%, transparent); }
  /* Unread + ongoing work: a static accent ring wraps the still-pulsing work dot. */
  .unread-ring { flex: 0 0 auto; box-sizing: border-box; display: inline-grid; place-items: center; width: 9px; height: 9px; margin-right: 6px; border: 1.5px solid var(--pi-accent); border-radius: 50%; vertical-align: 1px; }
  .unread-ring .activity-indicator { width: 5px; height: 5px; margin: 0; vertical-align: 0; }
  .action-activity .unread-ring { margin: 0; vertical-align: 0; }
  .action-menu { position: relative; align-self: stretch; }
  .action-menu-toggle { height: 100%; }
  .action-menu-panel { min-width: min(120px, calc(100vw - 16px)); overflow-wrap: anywhere; }
  .action-menu-description { display: block; padding: 0 9px 7px; color: var(--pi-muted); font-size: 12px; line-height: 1.4; white-space: normal; overflow-wrap: anywhere; }
  .action-menu-description a { color: var(--pi-accent); text-decoration: none; }
  .action-menu-description a:hover, .action-menu-description a:focus-visible { text-decoration: underline; }
  .action-menu-error { color: var(--pi-danger, #c0392b); }
  small { display: block; color: var(--pi-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .workspace-label { min-width: 0; display: inline-flex; align-items: baseline; gap: 5px; max-width: 100%; overflow: hidden; white-space: nowrap; }
  .workspace-label-base, .workspace-label-item, .workspace-label-render { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .workspace-label-item, .workspace-label-render, .workspace-label-separator { color: var(--pi-muted); }
  .workspace-label-link { color: var(--pi-accent); text-decoration: none; }
  .workspace-label-link:hover, .workspace-label-link:focus { text-decoration: underline; }
  .workspace-detail-row .workspace-label { overflow: visible; white-space: normal; flex-wrap: wrap; }
  .workspace-detail-row .workspace-label-base, .workspace-detail-row .workspace-label-item, .workspace-detail-row .workspace-label-render { overflow: visible; text-overflow: clip; overflow-wrap: anywhere; white-space: normal; }
  @keyframes pulse { 0%, 100% { transform: scale(.75); opacity: .55; } 50% { transform: scale(1.2); opacity: 1; } }
  }
`;

export const statusBarStyles = css`
  @layer pi-web-base {
  /* Only this non-interactive footer consumes the shell's reserved bottom inset. */
  :host { display: block; margin-block-end: calc(0px - var(--pi-app-safe-area-bottom, 0px)); color: var(--pi-muted); font: 12px var(--pi-font, system-ui, sans-serif); }
  .bar { box-sizing: border-box; display: flex; justify-content: flex-end; gap: 12px; align-items: center; min-width: 0; min-height: max(32px, var(--pi-app-safe-area-bottom, 0px)); padding: 7px 12px; border-top: 1px solid var(--pi-border); background: var(--pi-bg); white-space: nowrap; overflow: hidden; }
  span { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .activity { display: inline-flex; align-items: center; gap: 6px; color: var(--pi-muted); }
  .activity.active { color: var(--pi-success); }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; opacity: .45; flex: 0 0 auto; }
  .activity.active .dot { animation: pulse 1s ease-in-out infinite; opacity: 1; }
  .muted { color: var(--pi-dim); }
  @keyframes pulse { 0%, 100% { transform: scale(.75); opacity: .55; } 50% { transform: scale(1.2); opacity: 1; } }
  }
`;

export const autocompleteStyles = css`
  @layer pi-web-base {
  :host { display: block; }
  .menu { overflow: auto; padding: 0; color: var(--pi-text); border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); box-shadow: 0 10px 30px var(--pi-shadow); }
  button { display: grid; grid-template-columns: minmax(120px, 1fr) auto; gap: 4px 10px; width: 100%; border: 0; border-bottom: 1px solid var(--pi-border); border-radius: 0; background: transparent; color: var(--pi-text); padding: 8px 10px; text-align: start; cursor: pointer; }
  button:last-child { border-bottom: 0; }
  button.selected, button:hover { background: var(--pi-selection-bg); }
  .label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .argument-hint { color: var(--pi-muted); font-size: 12px; }
  .detail { color: var(--pi-muted); font-size: 12px; }
  small { grid-column: 1 / -1; color: var(--pi-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  }
`;

export const promptEditorLayoutStyles = css`
  ${uiButtonStyles}
  ${uiMenuStyles}
  ${uiToolbarStyles}
  ${chatNavigationStyles}
  @layer pi-web-base {
  :host { position: relative; display: block; color: var(--pi-text); font: 14px var(--pi-font, system-ui, sans-serif); }
  footer { display: grid; grid-template-columns: minmax(0, 1fr); gap: 0; padding: 0; border-top: 1px solid var(--pi-border); }
  footer.shell-mode { border-top-color: var(--pi-success); background: var(--pi-success-bg); }
  .editor-wrap, .editor-input { position: relative; min-width: 0; }
  .actions { justify-content: flex-end; flex-wrap: nowrap; white-space: nowrap; border-top: 1px solid var(--pi-border-muted); }
  .compact-status { display: flex; min-width: 0; align-items: stretch; flex: 1 1 0; }
  .compact-status > .ui-toolbar-group { flex: 0 1 auto; }
  .select-model { display: block; flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; text-align: start; }
  .icon-button { flex: 0 0 auto; display: inline-grid; place-items: center; }
  .icon-button .prompt-action-icon, .icon-button .prompt-thinking-gauge { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; pointer-events: none; }
  .icon-button .prompt-action-icon-filled { fill: currentColor; stroke: none; }
  .default-send-action:not(:disabled), .default-send-action:hover:not(:disabled) { color: var(--pi-accent, var(--pi-text)); }
  .stop-button:not(:disabled), .stop-button:hover:not(:disabled) { color: var(--pi-danger); }
  .select-thinking .prompt-thinking-gauge .gauge-bar { fill: currentColor; stroke: none; opacity: .28; }
  .select-thinking .prompt-thinking-gauge .gauge-bar-active { opacity: 1; }
  .editor-chat-navigation { position: absolute; inset-inline-end: 0; top: 0; z-index: 2; box-sizing: border-box; width: 58px; border: 1px solid var(--pi-border-muted); }
  .editor-chat-navigation .chat-jumps button + button { border-inline-start: 1px solid var(--pi-border-muted); }
  .editor-attach { position: absolute; inset-inline-end: 0; bottom: 0; z-index: 2; box-sizing: border-box; width: 28px; height: 28px; min-width: 28px; min-height: 28px; padding: 0; border: 1px solid var(--pi-border-muted); }
  .editor-attach .prompt-action-icon { width: 14px; height: 14px; }
  .attach-source-panel .attach-source-label { display: inline-flex; align-items: center; min-width: 0; }
  .attach-source-panel .attach-source-icon { display: inline-grid; place-items: center; flex: 0 0 auto; width: 16px; height: 16px; margin-inline-end: 9px; color: var(--pi-muted); }
  .attach-source-panel .attach-source-icon .prompt-action-icon { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; pointer-events: none; }
  textarea { box-sizing: border-box; width: 100%; min-height: 54px; max-height: 220px; resize: none; overflow: hidden; border-radius: 0; border: 0; background: var(--pi-bg); color: var(--pi-text); font: var(--pi-control-font-size, 16px)/1.4 var(--pi-control-font-family, var(--pi-font, system-ui, sans-serif)); }
  textarea { overflow-y: auto; padding: 12px 16px; }
  textarea:focus-visible, .markdown-editor:focus-within { outline: 2px solid var(--pi-accent); outline-offset: -2px; }
  .shell-mode textarea { background: var(--pi-success-bg); }
  .shell-mode textarea:focus-visible, .shell-mode .markdown-editor:focus-within { outline-color: var(--pi-success); }
  .mode-hint { position: absolute; inset-inline-end: 46px; bottom: 8px; box-sizing: border-box; max-width: calc(100% - 54px); overflow-wrap: anywhere; border: 1px solid var(--pi-success-border); border-radius: 999px; background: var(--pi-success-surface); color: var(--pi-success); padding: 2px 8px; font-size: 12px; pointer-events: none; }
  .prompt-chips, .attachments { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 8px 12px; }
  .prompt-chip { display: flex; align-items: center; gap: 6px; min-width: 0; max-width: 100%; border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-bg); padding-inline-start: 6px; }
  .prompt-chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chip-error { overflow-wrap: anywhere; min-width: 0; flex-basis: 100%; color: var(--pi-danger); font-size: 12px; }
  .attachment-chip { --attachment-remove-width: 32px; position: relative; width: 56px; height: 56px; padding-inline-end: var(--attachment-remove-width); border: 1px solid var(--pi-border); border-radius: 8px; overflow: hidden; background: var(--pi-bg); }
  .attachment-chip img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .attachment-chip-file { display: grid; place-items: center; }
  .attachment-file-preview { display: grid; place-items: center; width: 34px; height: 26px; border: 1px solid var(--pi-border-muted); border-radius: 4px; background: var(--pi-surface); color: var(--pi-muted); font: 700 10px/1 var(--pi-font, system-ui, sans-serif); letter-spacing: .03em; }
  .attachment-file-name { position: absolute; inset-inline-end: calc(var(--attachment-remove-width) + 4px); bottom: 3px; inset-inline-start: 4px; overflow: hidden; color: var(--pi-muted); font-size: 10px; line-height: 1.2; text-align: center; text-overflow: ellipsis; white-space: nowrap; }
  .attachment-remove { position: absolute; top: 0; inset-inline-end: 0; width: var(--attachment-remove-width); height: 100%; border-inline-start: 1px solid var(--pi-border-muted); background: var(--pi-surface); }
  .attachment-delivery { min-width: 0; max-width: 100%; }
  .attachment-delivery .ui-select { width: 100%; }
  .attachment-error { overflow-wrap: anywhere; min-width: 0; flex-basis: 100%; color: var(--pi-danger); font-size: 12px; }
  textarea:disabled { opacity: .5; cursor: not-allowed; }
  }
`;

export const promptEditorStyles = css`${promptEditorLayoutStyles}${promptEditorIntegrationStyles}`;
