import { css } from "lit";

export interface ToolPreview {
  diff?: string;
  firstChangedLine?: number;
  error?: string;
}

export interface ToolExecutionPart {
  type: "toolExecution";
  toolCallId?: string;
  toolName: string;
  summary: string;
  args?: unknown;
  status: "pending" | "running" | "success" | "error";
  resultText?: string;
  content?: unknown;
  details?: unknown;
  preview?: ToolPreview;
}

export type ChatPart =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "skillInvocation"; name: string; location: string; content: string }
  | { type: "skillRead"; name: string; path: string }
  | { type: "toolCall"; toolCallId?: string; toolName: string; summary: string; args?: unknown }
  | ToolExecutionPart
  | { type: "toolResult"; toolCallId?: string; toolName: string; text: string; isError: boolean; content?: unknown; details?: unknown }
  | { type: "empty" };

export interface ChatLine {
  role: "user" | "assistant" | "tool" | "system" | "bash" | "skill";
  parts: ChatPart[];
  source?: "compaction" | "branch_summary";
  meta?: {
    timestamp?: string;
    model?: { provider?: string; id?: string; responseId?: string };
  };
}

export interface CompletionItem {
  kind: "command" | "file";
  replaceFrom: number;
  replaceTo: number;
  insertText: string;
  detail: string;
  description?: string;
  cursorOffset?: number;
}

export const appStyles = css`
  :host { display: block; height: 100dvh; box-sizing: border-box; padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); color: var(--pi-text); background: var(--pi-bg); font: 14px system-ui, sans-serif; }
  .shell { display: grid; grid-template-columns: 340px minmax(420px, 1fr) minmax(360px, 42vw); height: 100%; min-height: 0; }
  aside { display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--pi-border); overflow: hidden; }
  header { flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 12px; border-bottom: 1px solid var(--pi-border); }
  project-list, workspace-list { flex: 0 0 auto; max-height: 26%; overflow: auto; border-bottom: 1px solid var(--pi-border-muted); }
  session-list { flex: 1 1 auto; min-height: 0; overflow: auto; }
  main { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
  .context-bar { position: relative; flex: 0 0 auto; min-width: 0; display: none; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--pi-border-muted); background: var(--pi-bg); }
  .context-bar::before, .context-bar::after { content: ""; position: absolute; top: 0; bottom: 0; z-index: 2; width: 20px; opacity: 0; pointer-events: none; transition: opacity .15s ease; }
  .context-bar::before { left: 0; background: linear-gradient(90deg, color-mix(in srgb, var(--pi-shadow-strong) 55%, transparent) 0%, transparent 100%); }
  .context-bar::after { right: 0; background: linear-gradient(270deg, color-mix(in srgb, var(--pi-shadow-strong) 55%, transparent) 0%, transparent 100%); }
  .context-bar.can-scroll-left::before, .context-bar.can-scroll-right::after { opacity: 1; }
  .context-bar-label { display: none; }
  .context-items { flex: 1 1 auto; min-width: 0; display: flex; align-items: stretch; gap: 5px; margin: 0; padding: 0 8px; list-style: none; overflow-x: auto; overflow-y: hidden; overscroll-behavior-x: contain; scroll-padding-inline: 8px; scrollbar-width: thin; -webkit-overflow-scrolling: touch; }
  .context-chip { flex: 0 0 auto; min-width: 0; display: inline-flex; align-items: baseline; gap: 5px; border: 1px solid var(--pi-border-muted); border-radius: 999px; background: var(--pi-surface); color: var(--pi-text); padding: 4px 8px; }
  .context-chip.empty { border-style: dashed; color: var(--pi-muted); }
  .context-kind { display: none; }
  .context-value { min-width: 0; overflow: visible; text-overflow: clip; white-space: nowrap; }
  .mobile-tabs-frame { position: relative; display: none; flex: 0 0 auto; min-width: 0; border-bottom: 1px solid var(--pi-border); background: var(--pi-bg); }
  .mobile-tabs-frame::before, .mobile-tabs-frame::after { content: ""; position: absolute; top: 0; bottom: 0; z-index: 2; width: 20px; opacity: 0; pointer-events: none; transition: opacity .15s ease; }
  .mobile-tabs-frame::before { left: 0; background: linear-gradient(90deg, color-mix(in srgb, var(--pi-shadow-strong) 55%, transparent) 0%, transparent 100%); }
  .mobile-tabs-frame::after { right: 0; background: linear-gradient(270deg, color-mix(in srgb, var(--pi-shadow-strong) 55%, transparent) 0%, transparent 100%); }
  .mobile-tabs-frame.can-scroll-left::before, .mobile-tabs-frame.can-scroll-right::after { opacity: 1; }
  .mobile-tabs { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 6px; padding: 8px; overflow-x: auto; overflow-y: hidden; overscroll-behavior-x: contain; scrollbar-width: thin; -webkit-overflow-scrolling: touch; }
  .mobile-tabs button { flex: 0 0 auto; white-space: nowrap; }
  .mobile-navigation-tab, .mobile-navigation-panel { display: none; }
  .mobile-tabs button.selected { border-color: var(--pi-accent); background: var(--pi-selection-bg); }
  .tab-badge { display: inline-block; min-width: 14px; margin-left: 4px; border: 1px solid var(--pi-success-border); border-radius: 999px; background: var(--pi-success-surface); color: var(--pi-success); padding: 0 5px; font-size: 11px; line-height: 16px; text-align: center; }
  workspace-panel { min-width: 0; min-height: 0; border-left: 1px solid var(--pi-border); overflow: hidden; }
  @media (max-width: 1180px) {
    .shell { grid-template-columns: 340px minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); }
    aside { grid-row: 1 / 3; }
    main { grid-column: 2; grid-row: 1 / 3; }
    .mobile-tabs-frame { display: flex; }
    .shell.workspace-view main { grid-row: 1; min-height: auto; }
    .shell.workspace-view > workspace-panel { grid-column: 2; grid-row: 2; display: flex; border-left: 0; }
    .shell:not(.workspace-view) > workspace-panel { display: none; }
    main.workspace-view chat-view, main.workspace-view prompt-editor, main.workspace-view status-bar,
    main.workspace-view .empty { display: none; }
    main.workspace-view { overflow: hidden; }
  }
  @media (max-width: 760px) {
    .shell { grid-template-columns: minmax(0, 1fr); }
    aside { display: none; }
    main, .shell.workspace-view > workspace-panel { grid-column: 1; }
    .context-bar { display: flex; }
    .mobile-navigation-tab { display: block; }
    main.navigation-view chat-view, main.navigation-view prompt-editor, main.navigation-view status-bar,
    main.navigation-view .empty { display: none; }
    main.navigation-view .mobile-navigation-panel { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
    main.navigation-view .mobile-navigation-panel project-list,
    main.navigation-view .mobile-navigation-panel workspace-list,
    main.navigation-view .mobile-navigation-panel session-list { flex: 1 1 auto; max-height: none; min-height: 0; overflow: auto; }
    main.navigation-view .mobile-navigation-panel project-list[collapsed],
    main.navigation-view .mobile-navigation-panel workspace-list[collapsed],
    main.navigation-view .mobile-navigation-panel session-list[collapsed] { flex: 0 0 auto; min-height: auto; overflow: hidden; }
  }
  status-bar { flex: 0 0 auto; }
  chat-view { flex: 1 1 auto; min-height: 0; overflow: hidden; }
  prompt-editor, chat-composer { flex: 0 0 auto; }
  button { border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); color: var(--pi-text); padding: 7px 9px; cursor: pointer; }
  .empty { margin: auto; color: var(--pi-muted); }
  .error { padding: 10px 16px; border-bottom: 1px solid var(--pi-border); color: var(--pi-danger); }
`;

export const workspacePanelStyles = css`
  :host { display: flex; flex-direction: column; min-height: 0; color: var(--pi-text); background: var(--pi-bg); font: 13px system-ui, sans-serif; }
  header { flex: 0 0 auto; min-width: 0; border-bottom: 1px solid var(--pi-border); }
  .workspace-header-scroll-frame { position: relative; min-width: 0; background: var(--pi-bg); }
  .workspace-header-scroll-frame::before, .workspace-header-scroll-frame::after { content: ""; position: absolute; top: 0; bottom: 0; z-index: 2; width: 18px; opacity: 0; pointer-events: none; transition: opacity .15s ease; }
  .workspace-header-scroll-frame::before { left: 0; background: linear-gradient(90deg, color-mix(in srgb, var(--pi-shadow-strong) 55%, transparent) 0%, transparent 100%); }
  .workspace-header-scroll-frame::after { right: 0; background: linear-gradient(270deg, color-mix(in srgb, var(--pi-shadow-strong) 55%, transparent) 0%, transparent 100%); }
  .workspace-header-scroll-frame.can-scroll-left::before, .workspace-header-scroll-frame.can-scroll-right::after { opacity: 1; }
  .workspace-header-strip { display: flex; justify-content: space-between; align-items: center; gap: 8px; min-width: 0; padding: 8px; overflow-x: auto; overflow-y: hidden; overscroll-behavior-x: contain; scrollbar-width: thin; -webkit-overflow-scrolling: touch; }
  .tabs { flex: 0 0 auto; display: flex; gap: 6px; }
  .tabs button { flex: 0 0 auto; white-space: nowrap; }
  button { display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--pi-border); border-radius: 7px; background: var(--pi-surface); color: var(--pi-text); padding: 5px 7px; cursor: pointer; }
  button.selected { border-color: var(--pi-accent); background: var(--pi-selection-bg); }
  .tab-badge { display: inline-block; min-width: 14px; border: 1px solid var(--pi-success-border); border-radius: 999px; background: var(--pi-success-surface); color: var(--pi-success); padding: 0 5px; font-size: 11px; line-height: 16px; text-align: center; }
  .panel-content { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
  small, .muted { color: var(--pi-muted); }
  header small { flex: 0 0 auto; min-width: max-content; overflow: visible; text-overflow: clip; white-space: nowrap; }
  header .workspace-label { width: max-content; max-width: none; overflow: visible; }
  header .workspace-label-base, header .workspace-label-item, header .workspace-label-render { overflow: visible; text-overflow: clip; }
  @media (max-width: 1180px) { .tabs { display: none; } }
  .workspace-label { min-width: 0; display: inline-flex; align-items: baseline; gap: 5px; max-width: 100%; overflow: hidden; white-space: nowrap; }
  .workspace-label-base, .workspace-label-item, .workspace-label-render { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .workspace-label-item, .workspace-label-render, .workspace-label-separator { color: var(--pi-muted); }
  .workspace-label-link { color: var(--pi-accent); text-decoration: none; }
  .workspace-label-link:hover, .workspace-label-link:focus { text-decoration: underline; }
  .toolbar { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 8px; border-bottom: 1px solid var(--pi-border-muted); }
  .toolbar button { margin-left: auto; }
  .stale { border: 1px solid var(--pi-warning-border); border-radius: 999px; color: var(--pi-warning); padding: 1px 6px; font-size: 12px; }
  .split { flex: 1 1 auto; min-height: 0; display: grid; grid-template-rows: minmax(160px, 34%) minmax(0, 1fr); }
  .list { min-height: 0; overflow: auto; border-bottom: 1px solid var(--pi-border); padding: 6px; }
  .row { display: grid; grid-template-columns: 18px minmax(0, 1fr); gap: 4px; width: 100%; border: 0; border-radius: 5px; background: transparent; text-align: left; padding: 4px 6px 4px calc(6px + var(--depth, 0) * 14px); }
  .row:hover, .row.selected { background: var(--pi-selection-bg); }
  .row span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .summary { margin: 4px 6px 8px; color: var(--pi-muted); }
  .viewer { min-height: 0; overflow: hidden; display: flex; flex-direction: column; }
  .diffs { flex: 1 1 auto; min-height: 0; overflow: auto; display: grid; grid-template-rows: minmax(120px, 1fr) minmax(120px, 1fr); }
  .diffs.single { grid-template-rows: minmax(0, 1fr); }
  .diff-section { min-height: 0; display: flex; flex-direction: column; border-bottom: 1px solid var(--pi-border); }
  .diff-section:last-child { border-bottom: 0; }
  .viewer-header { position: sticky; top: 0; display: flex; justify-content: space-between; gap: 8px; padding: 8px; border-bottom: 1px solid var(--pi-border-muted); background: var(--pi-bg); }
  .viewer-header strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  code-viewer { flex: 1 1 auto; min-height: 0; }
  pre { margin: 0; padding: 10px; overflow: auto; font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; }
  p { margin: 10px; }
`;

export const listStyles = css`
  :host { display: block; color: var(--pi-text); font: 14px system-ui, sans-serif; }
  :host([collapsed]) { flex: 0 0 auto; min-height: auto; overflow: hidden; }
  section { padding: 10px; }
  h2 { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin: 0 0 8px; color: var(--pi-muted); font-size: 12px; text-transform: uppercase; }
  button { border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); color: var(--pi-text); padding: 7px 9px; cursor: pointer; }
  section > button { display: block; width: 100%; text-align: left; margin: 6px 0; }
  .subheading { margin-top: 14px; }
  .section-toggle { display: flex; flex: 1 1 auto; min-width: 0; align-items: center; justify-content: space-between; gap: 8px; width: 100%; border: 0; background: transparent; color: inherit; padding: 0; font: inherit; text-align: left; text-transform: inherit; }
  .section-toggle span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .section-title { display: grid; gap: 2px; min-width: 0; }
  .section-toggle .section-selected { display: block; color: var(--pi-text); font-size: 12px; font-weight: 600; line-height: 1.25; text-transform: none; }
  .section-toggle .section-count { flex: 0 0 auto; display: inline; color: var(--pi-muted); font-size: inherit; }
  .section-toggle small { display: inline; color: inherit; font-size: inherit; }
  .action-row { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) auto; margin: 6px 0; cursor: pointer; }
  .action-row:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 2px; border-radius: 8px; }
  .action-row.selected .action-main, .action-row.selected .action-menu-toggle { border-color: var(--pi-accent); background: var(--pi-selection-bg); }
  .action-row.archived .action-main { color: var(--pi-muted); }
  .action-main { box-sizing: border-box; min-width: 0; width: 100%; border: 1px solid var(--pi-border); border-top-right-radius: 0; border-bottom-right-radius: 0; border-top-left-radius: 8px; border-bottom-left-radius: 8px; background: var(--pi-surface); color: var(--pi-text); padding: 7px 9px 7px calc(9px + var(--depth, 0) * 16px); text-align: left; }
  .action-row:not(.selected):hover .action-main { background: var(--pi-surface-hover); }
  .workspace-row .action-main { border-radius: 8px; }
  .tree-marker { color: var(--pi-dim); margin-right: 5px; }
  .badge { display: inline-block; margin-left: 5px; border: 1px solid var(--pi-border); border-radius: 999px; color: var(--pi-muted); padding: 0 5px; font-size: 11px; font-weight: 400; }
  .activity-indicator { display: inline-block; width: 7px; height: 7px; margin-right: 6px; background: var(--pi-success); animation: pulse 1s ease-in-out infinite; vertical-align: 1px; }
  .activity-indicator.session { border-radius: 50%; background: var(--pi-success); }
  .activity-indicator.terminal { border-radius: 2px; background: var(--pi-accent); }
  .action-menu { position: relative; align-self: stretch; }
  .action-menu-toggle { display: grid; place-items: center; height: 100%; min-width: 32px; padding: 0; color: var(--pi-muted); border-left: 0; border-top-left-radius: 0; border-bottom-left-radius: 0; }
  .action-menu-toggle:hover { color: var(--pi-text); background: var(--pi-surface-hover); }
  .action-menu-panel { position: fixed; z-index: 50; min-width: 120px; padding: 4px; border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); box-shadow: 0 8px 24px var(--pi-shadow); }
  .action-menu-panel button { display: block; width: 100%; text-align: left; border: 0; background: transparent; color: var(--pi-text); }
  .action-menu-panel button:hover { background: var(--pi-selection-bg); }
  button.selected { border-color: var(--pi-accent); background: var(--pi-selection-bg); }
  button:disabled { opacity: .5; cursor: not-allowed; }
  small { display: block; color: var(--pi-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .workspace-label { min-width: 0; display: inline-flex; align-items: baseline; gap: 5px; max-width: 100%; overflow: hidden; white-space: nowrap; }
  .workspace-label-base, .workspace-label-item, .workspace-label-render { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .workspace-label-item, .workspace-label-render, .workspace-label-separator { color: var(--pi-muted); }
  .workspace-label-link { color: var(--pi-accent); text-decoration: none; }
  .workspace-label-link:hover, .workspace-label-link:focus { text-decoration: underline; }
  @keyframes pulse { 0%, 100% { transform: scale(.75); opacity: .55; } 50% { transform: scale(1.2); opacity: 1; } }
`;

export const chatStyles = css`
  :host { display: flex; flex-direction: column; min-height: 0; overflow: hidden; color: var(--pi-text); font: 14px system-ui, sans-serif; }
  .chat-wrap { position: relative; flex: 1 1 auto; min-height: 0; overflow: hidden; }
  .chat { height: 100%; min-height: 0; overflow: auto; overflow-anchor: none; padding: 26px 16px 64px; box-sizing: border-box; }
  .scroll-marker { display: block; height: 0; overflow: hidden; pointer-events: none; }
  .activity-dock { position: absolute; left: 16px; right: 16px; bottom: 12px; z-index: 3; display: flex; align-items: center; gap: 8px; min-width: 0; box-sizing: border-box; border: 1px solid var(--pi-border); border-radius: 999px; background: var(--pi-bg-overlay); color: var(--pi-muted); padding: 8px 12px; font-size: 13px; pointer-events: none; box-shadow: 0 8px 28px var(--pi-shadow); backdrop-filter: blur(6px); }
  .activity-dock.active { border-color: var(--pi-success-border); color: var(--pi-success); background: var(--pi-success-bg-overlay); }
  .activity-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; opacity: .45; flex: 0 0 auto; }
  .activity-dock.active .dot { animation: pulse 1s ease-in-out infinite; opacity: 1; }
  .msg { max-width: 100%; min-width: 0; box-sizing: border-box; margin: 0 0 14px; padding: 12px; border: 1px solid var(--pi-border); border-radius: 10px; background: var(--pi-surface); overflow: visible; }
  .msg.user { border-color: var(--pi-accent-border); background: var(--pi-selection-bg); }
  .msg.tool { border-color: var(--pi-warning-border); background: var(--pi-warning-surface); color: var(--pi-warning); }
  .msg.tool-execution-shell { padding: 0; border: 0; background: transparent; color: var(--pi-text); }
  .msg.system { color: var(--pi-danger); }
  .msg.bash { border-color: var(--pi-success); background: var(--pi-success-bg); }
  .msg.skill { border-color: var(--pi-purple-border); background: var(--pi-purple-surface); }
  .msg.event-group { padding: 0; border-color: var(--pi-border); background: var(--pi-bg); color: var(--pi-muted); }
  .msg.event-group.live { border-color: var(--pi-success-border); background: var(--pi-success-bg); }
  .msg.event-group > summary { position: sticky; top: -26px; z-index: 5; display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: 9px 9px 0 0; border-bottom: 1px solid var(--pi-border-muted); background: var(--pi-bg); color: var(--pi-muted); }
  .msg.event-group.live > summary { border-bottom-color: var(--pi-success-border); background: var(--pi-success-bg); color: var(--pi-success); }
  .msg.event-group > summary .label { margin: 0; }
  .group-body { padding: 0 12px 12px; }
  .group-msg { max-width: 100%; min-width: 0; box-sizing: border-box; padding: 10px 0; border-top: 1px solid var(--pi-border-muted); color: var(--pi-text); overflow: visible; }
  .group-msg.tool { color: var(--pi-warning); }
  .group-msg.tool-execution-shell { color: var(--pi-text); }
  .group-msg.system { color: var(--pi-danger); }
  .group-msg.bash { color: var(--pi-success); }
  .history-boundary { position: relative; z-index: 5; display: grid; gap: 3px; justify-items: center; margin: 0 0 14px; color: var(--pi-muted); font-size: 12px; text-align: center; }
  .history-load-button { border: 1px solid var(--pi-border); border-radius: 999px; background: var(--pi-surface); color: var(--pi-text-secondary); padding: 5px 12px; font: 12px system-ui, sans-serif; cursor: pointer; }
  .history-load-button:hover, .history-load-button:focus { border-color: var(--pi-accent); color: var(--pi-text-bright); }
  .history-load-button:disabled { cursor: default; opacity: .55; }
  .queued-messages { max-width: 100%; min-width: 0; box-sizing: border-box; display: grid; gap: 8px; margin: 0 0 14px; padding: 12px; border: 1px solid var(--pi-warning-border); border-radius: 10px; background: var(--pi-warning-surface); color: var(--pi-text); overflow: hidden; }
  .queued-header { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
  .queued-header strong { color: var(--pi-warning); }
  .queued-header small { color: var(--pi-muted); }
  .queued-message { display: grid; gap: 4px; padding-top: 8px; border-top: 1px solid var(--pi-border); }
  .queued-message:first-of-type { padding-top: 0; border-top: 0; }
  .queued-kind { color: var(--pi-muted); font-size: 12px; text-transform: uppercase; }
  .session-activity { max-width: 100%; min-width: 0; box-sizing: border-box; display: grid; gap: 4px; margin: 0 0 14px; padding: 12px; border: 1px solid var(--pi-border); border-radius: 10px; background: var(--pi-surface); color: var(--pi-text); overflow: hidden; }
  .session-activity.compacting { border-color: var(--pi-purple-border); background: var(--pi-purple-surface); }
  .session-activity.receiving { border-color: var(--pi-success-border); background: var(--pi-success-bg); }
  .session-activity strong { color: var(--pi-purple); }
  .session-activity.receiving strong { color: var(--pi-success); }
  .session-activity span, .session-activity small { color: var(--pi-muted); }
  .history-boundary small { color: var(--pi-dim); }
  .msg-header { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 22px; margin-bottom: 8px; }
  .msg > .msg-header { position: sticky; top: -26px; z-index: 4; margin: -12px -12px 8px; padding: 7px 10px 6px; border-radius: 9px 9px 0 0; border-bottom: 1px solid color-mix(in srgb, var(--pi-border-muted) 35%, transparent); background: var(--pi-surface); box-shadow: 0 8px 18px var(--pi-shadow-soft); }
  .msg.user > .msg-header { border-bottom-color: color-mix(in srgb, var(--pi-accent-border) 35%, transparent); background: var(--pi-selection-bg); }
  .msg.tool > .msg-header { border-bottom-color: color-mix(in srgb, var(--pi-warning-border) 35%, transparent); background: var(--pi-warning-surface); }
  .msg.bash > .msg-header { border-bottom-color: color-mix(in srgb, var(--pi-success) 35%, transparent); background: var(--pi-success-bg); }
  .msg.skill > .msg-header { border-bottom-color: color-mix(in srgb, var(--pi-purple-border) 35%, transparent); background: var(--pi-purple-surface); }
  .group-msg > .msg-header { position: sticky; top: -26px; z-index: 4; margin: -10px 0 8px; padding: 7px 0 6px; border-bottom: 1px solid color-mix(in srgb, var(--pi-border-muted) 35%, transparent); background: var(--pi-bg); }
  .msg-header-trailing { min-width: 0; display: inline-flex; align-items: baseline; justify-content: flex-end; gap: 8px; }
  .msg-actions { display: inline-flex; gap: 6px; opacity: 0; transition: opacity .12s ease; }
  .msg-action { display: inline-grid; place-items: center; width: 24px; height: 24px; border: 1px solid var(--pi-border); border-radius: 6px; background: var(--pi-surface); color: var(--pi-muted); padding: 0; font: 14px system-ui, sans-serif; line-height: 1; cursor: pointer; }
  .msg-action:hover, .msg-action:focus { color: var(--pi-text); border-color: var(--pi-accent); }
  .msg:hover > .msg-header .msg-actions, .msg:focus-within > .msg-header .msg-actions, .group-msg:hover > .msg-header .msg-actions, .group-msg:focus-within > .msg-header .msg-actions { opacity: 1; }
  .label { display: block; color: var(--pi-muted); font-size: 12px; text-transform: uppercase; }
  .msg-header .label { margin: 0; }
  .msg-meta { min-width: 0; opacity: .28; border: 0; background: transparent; color: var(--pi-dim); padding: 0; font: 11px system-ui, sans-serif; text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; transition: opacity .12s ease, max-width .12s ease; cursor: pointer; user-select: text; -webkit-user-select: text; }
  .msg:hover > .msg-header .msg-meta, .msg:focus-within > .msg-header .msg-meta, .group-msg:hover > .msg-header .msg-meta, .group-msg:focus-within > .msg-header .msg-meta, .msg-meta:focus, .msg-meta.expanded { opacity: 1; }
  .msg-meta:focus { outline: 1px solid var(--pi-border); outline-offset: 3px; border-radius: 4px; }
  @media (hover: none) {
    .msg-actions { opacity: 1; }
    .msg-meta { opacity: .75; max-width: 26px; }
    .msg-meta::before { content: "ⓘ"; font-size: 13px; }
    .msg-meta:focus, .msg-meta.expanded { opacity: 1; max-width: 75%; }
    .msg-meta:focus::before, .msg-meta.expanded::before { content: ""; }
  }
  formatted-text.part { display: block; }
  .part { max-width: 100%; min-width: 0; box-sizing: border-box; overflow: visible; }
  .part + .part { margin-top: 10px; }
  .tool-line { color: var(--pi-warning); }
  .summary { color: var(--pi-muted); margin-left: 6px; }
  .part:is(details) { border-top: 1px solid var(--pi-border); padding-top: 8px; }
  .part > formatted-text { display: block; max-width: 100%; min-width: 0; overflow: visible; }
  .skill-invocation, .skill-read { border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); padding: 8px 10px; }
  .skill-invocation > summary, .skill-read > strong { color: var(--pi-purple); }
  .skill-invocation > small, .skill-read > small { display: block; margin: 6px 0 0; color: var(--pi-muted); }
  summary { cursor: pointer; color: var(--pi-muted); }
  pre { margin: 6px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; }
  .shell-output { color: var(--pi-text); font: 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; line-height: 1.45; }
  @keyframes pulse { 0%, 100% { transform: scale(.75); opacity: .55; } 50% { transform: scale(1.2); opacity: 1; } }
`;

export const formattedTextStyles = css`
  :host { display: block; }
  .formatted { white-space: normal; overflow-wrap: anywhere; line-height: 1.45; }
  p, ul, ol, pre, blockquote, table, .code-block-wrapper { margin: 0 0 10px; }
  :is(p, ul, ol, pre, blockquote, table, .code-block-wrapper):last-child { margin-bottom: 0; }
  ul, ol { padding-left: 22px; }
  li + li { margin-top: 3px; }
  code { border: 1px solid var(--pi-border); border-radius: 4px; background: var(--pi-bg); padding: 1px 4px; font: 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .code-block-wrapper { position: relative; }
  .code-block-wrapper pre { margin: 0; padding-right: 40px; }
  pre { border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-bg); padding: 10px; overflow-x: auto; overflow-y: hidden; }
  pre code { border: 0; padding: 0; background: transparent; }
  .code-copy-button { position: absolute; top: 6px; right: 6px; z-index: 1; display: inline-grid; place-items: center; width: 24px; height: 24px; border: 1px solid var(--pi-border); border-radius: 6px; background: var(--pi-surface); color: var(--pi-muted); padding: 0; font: 14px system-ui, sans-serif; line-height: 1; cursor: pointer; }
  .code-copy-button:hover, .code-copy-button:focus { color: var(--pi-text); border-color: var(--pi-accent); }
  blockquote { border-left: 3px solid var(--pi-border); padding-left: 10px; color: var(--pi-muted); }
  a { color: var(--pi-accent); }
  h1, h2, h3, h4 { margin: 14px 0 8px; line-height: 1.2; }
  h1:first-child, h2:first-child, h3:first-child, h4:first-child { margin-top: 0; }
  h1 { font-size: 20px; }
  h2 { font-size: 17px; }
  h3 { font-size: 15px; }
  h4 { font-size: 14px; }
  table { border-collapse: collapse; display: block; overflow-x: auto; overflow-y: hidden; }
  th, td { border: 1px solid var(--pi-border); padding: 4px 8px; }
  th { background: var(--pi-surface); }
`;

export const statusBarStyles = css`
  :host { display: block; color: var(--pi-muted); font: 12px system-ui, sans-serif; }
  .bar { display: flex; gap: 12px; align-items: center; min-width: 0; padding: 7px 12px; border-top: 1px solid var(--pi-border); background: var(--pi-bg); white-space: nowrap; overflow: hidden; }
  span { overflow: hidden; text-overflow: ellipsis; }
  .workspace-label { min-width: 0; display: inline-flex; align-items: baseline; gap: 5px; max-width: 100%; overflow: hidden; white-space: nowrap; }
  .workspace-label-base, .workspace-label-item, .workspace-label-render { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .workspace-label-item, .workspace-label-render, .workspace-label-separator { color: var(--pi-muted); }
  .workspace-label-link { color: var(--pi-accent); text-decoration: none; }
  .workspace-label-link:hover, .workspace-label-link:focus { text-decoration: underline; }
  .bar > span:first-child { flex: 1 1 auto; min-width: 80px; }
  .activity { display: inline-flex; align-items: center; gap: 6px; color: var(--pi-muted); }
  .activity.active { color: var(--pi-success); }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; opacity: .45; flex: 0 0 auto; }
  .activity.active .dot { animation: pulse 1s ease-in-out infinite; opacity: 1; }
  .muted { color: var(--pi-dim); }
  @keyframes pulse { 0%, 100% { transform: scale(.75); opacity: .55; } 50% { transform: scale(1.2); opacity: 1; } }
`;

export const autocompleteStyles = css`
  :host { display: block; }
  .menu { position: absolute; left: 0; right: 0; bottom: calc(100% + 6px); z-index: 10; max-height: 260px; overflow: auto; border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); box-shadow: 0 10px 30px var(--pi-shadow); }
  button { display: grid; grid-template-columns: minmax(120px, 1fr) auto; gap: 4px 10px; width: 100%; border: 0; border-bottom: 1px solid var(--pi-border); border-radius: 0; background: transparent; color: var(--pi-text); padding: 8px 10px; text-align: left; cursor: pointer; }
  button:last-child { border-bottom: 0; }
  button.selected, button:hover { background: var(--pi-selection-bg); }
  span { color: var(--pi-muted); font-size: 12px; }
  small { grid-column: 1 / -1; color: var(--pi-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`;

export const commandPickerStyles = css`
  :host { position: fixed; inset: 0; z-index: 10; color: var(--pi-text); font: 14px system-ui, sans-serif; }
  .backdrop { display: grid; place-items: center; width: 100%; height: 100%; background: var(--pi-overlay); }
  section { width: min(720px, calc(100vw - 40px)); max-height: min(640px, calc(100vh - 40px)); display: flex; flex-direction: column; border: 1px solid var(--pi-border); border-radius: 12px; background: var(--pi-bg); box-shadow: 0 20px 60px var(--pi-shadow-strong); overflow: hidden; }
  header { display: flex; align-items: center; justify-content: space-between; padding: 12px; border-bottom: 1px solid var(--pi-border); }
  .options { min-height: 0; overflow: auto; outline: none; }
  button { border: 0; background: transparent; color: var(--pi-text); cursor: pointer; }
  header button { font-size: 20px; color: var(--pi-muted); }
  input { margin: 10px 12px; border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-bg); color: var(--pi-text); font: 14px system-ui, sans-serif; padding: 8px 10px; outline: none; }
  input:focus { border-color: var(--pi-accent); }
  .options button { display: block; width: 100%; padding: 10px 12px; border-bottom: 1px solid var(--pi-border-muted); text-align: left; }
  .options button.selected, .options button:hover { background: var(--pi-selection-bg); }
  small { display: block; margin-top: 4px; color: var(--pi-muted); }
  .empty { padding: 24px; color: var(--pi-muted); text-align: center; }
`;

export const actionPaletteStyles = css`
  :host { position: fixed; inset: 0; z-index: 20; color: var(--pi-text); font: 14px system-ui, sans-serif; }
  .backdrop { --palette-top: min(12dvh, 90px); --palette-bottom: max(20px, env(safe-area-inset-bottom)); display: grid; align-items: start; justify-items: center; width: 100%; height: 100dvh; background: var(--pi-overlay); padding: var(--palette-top) 20px var(--palette-bottom); box-sizing: border-box; overflow: hidden; }
  section { width: min(720px, 100%); max-height: min(640px, calc(100dvh - var(--palette-top) - var(--palette-bottom))); display: flex; flex-direction: column; border: 1px solid var(--pi-border); border-radius: 12px; background: var(--pi-bg); box-shadow: 0 20px 60px var(--pi-shadow-strong); overflow: hidden; }
  header { display: grid; grid-template-columns: 1fr auto; gap: 8px; padding: 10px; border-bottom: 1px solid var(--pi-border); }
  input { min-width: 0; border: 0; outline: none; background: transparent; color: var(--pi-text); font: 16px system-ui, sans-serif; padding: 8px; }
  input::placeholder { color: var(--pi-dim); }
  button { border: 0; background: transparent; color: var(--pi-text); cursor: pointer; }
  header button { color: var(--pi-muted); font-size: 22px; padding: 2px 8px; }
  .options { flex: 1 1 auto; min-height: 0; overflow: auto; -webkit-overflow-scrolling: touch; }
  .options button { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 3px 12px; width: 100%; padding: 10px 12px; border-bottom: 1px solid var(--pi-border-muted); text-align: left; }
  .options button.selected, .options button:hover { background: var(--pi-selection-bg); }
  .main { min-width: 0; }
  strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  small { display: block; color: var(--pi-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .group { grid-column: 1 / -1; font-size: 12px; }
  kbd { align-self: center; border: 1px solid var(--pi-border); border-radius: 6px; background: var(--pi-surface); color: var(--pi-muted); padding: 2px 6px; font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: nowrap; }
  .empty { padding: 24px; color: var(--pi-muted); text-align: center; }
`;

export const promptEditorStyles = css`
  :host { position: relative; z-index: 5; display: block; color: var(--pi-text); font: 14px system-ui, sans-serif; }
  footer { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; padding: 12px; border-top: 1px solid var(--pi-border); }
  footer.shell-mode { border-top-color: var(--pi-success); background: var(--pi-success-bg); }
  .editor-wrap { position: relative; min-width: 0; }
  .actions { display: flex; gap: 8px; align-items: center; justify-content: flex-end; flex-wrap: nowrap; white-space: nowrap; }
  .compact-status { display: flex; min-width: 0; align-items: center; gap: 6px; color: var(--pi-muted); font-size: 12px; flex: 1 1 0; }
  .compact-status > button { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .select-model { max-width: min(42vw, 320px); }
  .select-thinking { max-width: 110px; }
  textarea, .markdown-editor .cm-editor { box-sizing: border-box; width: 100%; min-height: 54px; max-height: 220px; resize: none; overflow: hidden; border-radius: 8px; border: 1px solid var(--pi-border); background: var(--pi-bg); color: var(--pi-text); font: 16px/1.4 system-ui, sans-serif; }
  textarea { overflow-y: auto; padding: 8px; }
  .markdown-editor .cm-scroller { max-height: 220px; overflow-y: auto; font-family: system-ui, sans-serif; line-height: 1.4; }
  .markdown-editor .cm-content { min-height: 38px; padding: 8px; caret-color: var(--pi-text); }
  .markdown-editor .cm-line { padding: 0; }
  .markdown-editor .cm-placeholder { color: var(--pi-dim); }
  .markdown-editor .cm-focused { outline: none; }
  .shell-mode textarea, .shell-mode .markdown-editor .cm-editor { border-color: var(--pi-success); box-shadow: 0 0 0 1px var(--pi-success-ring); }
  .mode-hint { position: absolute; right: 8px; bottom: 8px; max-width: calc(100% - 16px); border: 1px solid var(--pi-success-border); border-radius: 999px; background: var(--pi-success-surface); color: var(--pi-success); padding: 2px 8px; font-size: 12px; pointer-events: none; }
  button { border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); color: var(--pi-text); padding: 7px 9px; cursor: pointer; }
  button:disabled, textarea:disabled, .markdown-editor-disabled .cm-editor { opacity: .5; cursor: not-allowed; }
  @media (max-width: 640px) {
    footer { gap: 8px; padding: 8px; }
    .actions { gap: 6px; }
    .compact-status { flex: 1 1 220px; gap: 4px; }
    .select-model { max-width: min(58vw, 260px); }
    button { padding: 6px 8px; }
  }
  @media (max-width: 430px) {
    .compact-status { flex-basis: 170px; font-size: 11px; }
    .select-model { max-width: 48vw; }
    .select-thinking { max-width: 70px; }
    button { padding: 5px 7px; }
  }
`;

export const composerStyles = promptEditorStyles;
