import { css } from "lit";

export type ChatPart =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "skillInvocation"; name: string; location: string; content: string }
  | { type: "toolCall"; toolName: string; summary: string }
  | { type: "toolResult"; toolName: string; text: string; isError: boolean }
  | { type: "empty" };

export interface ChatLine {
  role: "user" | "assistant" | "tool" | "system" | "bash";
  parts: ChatPart[];
  source?: "compaction" | "branch_summary";
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
  :host { display: block; height: 100dvh; box-sizing: border-box; padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); color: #e6edf3; background: #0d1117; font: 14px system-ui, sans-serif; }
  .shell { display: grid; grid-template-columns: 340px minmax(420px, 1fr) minmax(360px, 42vw); height: 100%; min-height: 0; }
  aside { display: flex; flex-direction: column; min-height: 0; border-right: 1px solid #30363d; overflow: hidden; }
  header { flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 12px; border-bottom: 1px solid #30363d; }
  project-list, workspace-list { flex: 0 0 auto; max-height: 26%; overflow: auto; border-bottom: 1px solid #21262d; }
  session-list { flex: 1 1 auto; min-height: 0; overflow: auto; }
  main { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
  .mobile-tabs { display: none; flex: 0 0 auto; gap: 6px; padding: 8px; border-bottom: 1px solid #30363d; overflow-x: auto; }
  .mobile-navigation-tab, .mobile-navigation-panel, .mobile-panel { display: none; }
  .mobile-tabs button.selected { border-color: #58a6ff; background: #0d2847; }
  workspace-panel { min-width: 0; min-height: 0; border-left: 1px solid #30363d; overflow: hidden; }
  @media (max-width: 1180px) {
    .shell { grid-template-columns: 340px minmax(0, 1fr); }
    .shell > workspace-panel { display: none; }
    .mobile-tabs { display: flex; }
    main.workspace-view chat-view, main.workspace-view prompt-editor, main.workspace-view status-bar,
    main.workspace-view .empty { display: none; }
    main.chat-view .mobile-panel, main.navigation-view .mobile-panel { display: none; }
    .mobile-panel { flex: 1 1 auto; min-height: 0; display: flex; }
    .mobile-panel workspace-panel { flex: 1 1 auto; border-left: 0; }
  }
  @media (max-width: 760px) {
    .shell { grid-template-columns: minmax(0, 1fr); }
    aside { display: none; }
    .mobile-navigation-tab { display: block; }
    main.navigation-view chat-view, main.navigation-view prompt-editor, main.navigation-view status-bar,
    main.navigation-view .empty { display: none; }
    main.navigation-view .mobile-navigation-panel { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
  }
  status-bar { flex: 0 0 auto; }
  chat-view { flex: 1 1 auto; min-height: 0; overflow: hidden; }
  prompt-editor, chat-composer { flex: 0 0 auto; }
  button { border: 1px solid #30363d; border-radius: 8px; background: #161b22; color: #e6edf3; padding: 7px 9px; cursor: pointer; }
  .empty { margin: auto; color: #8b949e; }
  .error { padding: 10px 16px; border-bottom: 1px solid #30363d; color: #ff7b72; }
`;

export const workspacePanelStyles = css`
  :host { display: flex; flex-direction: column; min-height: 0; color: #e6edf3; background: #0d1117; font: 13px system-ui, sans-serif; }
  header { flex: 0 0 auto; display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 8px; border-bottom: 1px solid #30363d; }
  .tabs { display: flex; gap: 6px; }
  button { border: 1px solid #30363d; border-radius: 7px; background: #161b22; color: #e6edf3; padding: 5px 7px; cursor: pointer; }
  button.selected { border-color: #58a6ff; background: #0d2847; }
  small, .muted { color: #8b949e; }
  header small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .toolbar { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 8px; border-bottom: 1px solid #21262d; }
  .toolbar button { margin-left: auto; }
  .stale { border: 1px solid #6e5200; border-radius: 999px; color: #d29922; padding: 1px 6px; font-size: 12px; }
  .split { flex: 1 1 auto; min-height: 0; display: grid; grid-template-rows: minmax(160px, 34%) minmax(0, 1fr); }
  .list { min-height: 0; overflow: auto; border-bottom: 1px solid #30363d; padding: 6px; }
  .row { display: grid; grid-template-columns: 18px minmax(0, 1fr); gap: 4px; width: 100%; border: 0; border-radius: 5px; background: transparent; text-align: left; padding: 4px 6px 4px calc(6px + var(--depth, 0) * 14px); }
  .row:hover, .row.selected { background: #0d2847; }
  .row span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .summary { margin: 4px 6px 8px; color: #8b949e; }
  .viewer { min-height: 0; overflow: hidden; display: flex; flex-direction: column; }
  .diffs { flex: 1 1 auto; min-height: 0; overflow: auto; display: grid; grid-template-rows: minmax(120px, 1fr) minmax(120px, 1fr); }
  .diffs.single { grid-template-rows: minmax(0, 1fr); }
  .diff-section { min-height: 0; display: flex; flex-direction: column; border-bottom: 1px solid #30363d; }
  .diff-section:last-child { border-bottom: 0; }
  .viewer-header { position: sticky; top: 0; display: flex; justify-content: space-between; gap: 8px; padding: 8px; border-bottom: 1px solid #21262d; background: #0d1117; }
  .viewer-header strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  code-viewer { flex: 1 1 auto; min-height: 0; }
  pre { margin: 0; padding: 10px; overflow: auto; font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; }
  p { margin: 10px; }
`;

export const listStyles = css`
  :host { display: block; color: #e6edf3; font: 14px system-ui, sans-serif; }
  section { padding: 10px; }
  h2 { display: flex; justify-content: space-between; align-items: center; margin: 0 0 8px; color: #8b949e; font-size: 12px; text-transform: uppercase; }
  button { border: 1px solid #30363d; border-radius: 8px; background: #161b22; color: #e6edf3; padding: 7px 9px; cursor: pointer; }
  section > button { display: block; width: 100%; text-align: left; margin: 6px 0; }
  .subheading { margin-top: 14px; }
  .section-toggle { display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%; border: 0; background: transparent; color: inherit; padding: 0; font: inherit; text-transform: inherit; }
  .section-toggle small { display: inline; color: inherit; font-size: inherit; }
  .action-row { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) auto; margin: 6px 0; }
  .action-row.selected .action-main, .action-row.selected .action-menu-toggle { border-color: #58a6ff; background: #0d2847; }
  .action-row.archived .action-main { color: #8b949e; }
  .action-main { min-width: 0; text-align: left; border-top-right-radius: 0; border-bottom-right-radius: 0; }
  .action-menu { position: relative; align-self: stretch; }
  .action-menu-toggle { display: grid; place-items: center; height: 100%; min-width: 32px; padding: 0; color: #8b949e; border-left: 0; border-top-left-radius: 0; border-bottom-left-radius: 0; }
  .action-menu-toggle:hover { color: #e6edf3; background: #21262d; }
  .action-menu-panel { position: fixed; z-index: 50; min-width: 120px; padding: 4px; border: 1px solid #30363d; border-radius: 8px; background: #161b22; box-shadow: 0 8px 24px #0008; }
  .action-menu-panel button { display: block; width: 100%; text-align: left; border: 0; background: transparent; color: #e6edf3; }
  .action-menu-panel button:hover { background: #0d2847; }
  button.selected { border-color: #58a6ff; background: #0d2847; }
  button:disabled { opacity: .5; cursor: not-allowed; }
  small { display: block; color: #8b949e; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`;

export const chatStyles = css`
  :host { display: flex; flex-direction: column; min-height: 0; overflow: hidden; color: #e6edf3; font: 14px system-ui, sans-serif; }
  .chat-wrap { position: relative; flex: 1 1 auto; min-height: 0; overflow: hidden; }
  .chat { height: 100%; min-height: 0; overflow: auto; padding: 16px 16px 64px; box-sizing: border-box; }
  .history-indicator { position: absolute; top: 10px; right: 18px; z-index: 2; display: grid; gap: 2px; max-width: min(320px, calc(100% - 36px)); border: 1px solid #30363d; border-radius: 8px; background: #0d1117dd; color: #8b949e; padding: 6px 8px; font-size: 12px; text-align: right; pointer-events: none; box-shadow: 0 8px 24px #0006; }
  .activity-dock { position: absolute; left: 16px; right: 16px; bottom: 12px; z-index: 3; display: flex; align-items: center; gap: 8px; min-width: 0; box-sizing: border-box; border: 1px solid #30363d; border-radius: 999px; background: #0d1117e6; color: #8b949e; padding: 8px 12px; font-size: 13px; pointer-events: none; box-shadow: 0 8px 28px #0008; backdrop-filter: blur(6px); }
  .activity-dock.active { border-color: #238636; color: #3fb950; background: #0f1b12ee; }
  .activity-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; opacity: .45; flex: 0 0 auto; }
  .activity-dock.active .dot { animation: pulse 1s ease-in-out infinite; opacity: 1; }
  .msg { margin: 0 0 14px; padding: 12px; border: 1px solid #30363d; border-radius: 10px; background: #161b22; }
  .msg.user { border-color: #2f81f7; background: #0d2847; }
  .msg.tool { border-color: #6e5200; background: #1f1a10; color: #d29922; }
  .msg.system { color: #ff7b72; }
  .msg.bash { border-color: #3fb950; background: #0f1b12; }
  .msg.event-group { padding: 0; border-color: #30363d; background: #0d1117; color: #8b949e; }
  .msg.event-group > summary { display: flex; align-items: center; gap: 8px; padding: 8px 12px; color: #8b949e; }
  .msg.event-group > summary .label { margin: 0; }
  .group-body { padding: 0 12px 12px; }
  .group-msg { padding: 10px 0; border-top: 1px solid #21262d; color: #e6edf3; }
  .group-msg.tool { color: #d29922; }
  .group-msg.system { color: #ff7b72; }
  .group-msg.bash { color: #3fb950; }
  .history-boundary { display: grid; gap: 3px; margin: 0 0 14px; color: #8b949e; font-size: 12px; text-align: center; }
  .session-activity { display: grid; gap: 4px; margin: 0 0 14px; padding: 12px; border: 1px solid #30363d; border-radius: 10px; background: #161b22; color: #e6edf3; }
  .session-activity.compacting { border-color: #a371f7; background: #21132f; }
  .session-activity strong { color: #d2a8ff; }
  .session-activity span, .session-activity small { color: #8b949e; }
  .history-boundary small { color: #6e7681; }
  .label { display: block; margin-bottom: 8px; color: #8b949e; font-size: 12px; text-transform: uppercase; }
  formatted-text.part { display: block; }
  .part + .part { margin-top: 10px; }
  .tool-line { color: #d29922; }
  .summary { color: #8b949e; margin-left: 6px; }
  .part:is(details) { border-top: 1px solid #30363d; padding-top: 8px; }
  .skill-invocation { border: 1px solid #30363d; border-radius: 8px; background: #161b22; padding: 8px 10px; }
  .skill-invocation > summary { color: #d2a8ff; }
  .skill-invocation > small { display: block; margin: 6px 0 8px; color: #8b949e; }
  summary { cursor: pointer; color: #8b949e; }
  pre { margin: 6px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; }
  .shell-output { color: #e6edf3; font: 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; line-height: 1.45; }
  @keyframes pulse { 0%, 100% { transform: scale(.75); opacity: .55; } 50% { transform: scale(1.2); opacity: 1; } }
`;

export const formattedTextStyles = css`
  :host { display: block; }
  .formatted { white-space: normal; overflow-wrap: anywhere; line-height: 1.45; }
  p, ul, ol, pre, blockquote, table, .code-block-wrapper { margin: 0 0 10px; }
  :is(p, ul, ol, pre, blockquote, table, .code-block-wrapper):last-child { margin-bottom: 0; }
  ul, ol { padding-left: 22px; }
  li + li { margin-top: 3px; }
  code { border: 1px solid #30363d; border-radius: 4px; background: #0d1117; padding: 1px 4px; font: 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .code-block-wrapper { position: relative; }
  .code-block-wrapper pre { margin: 0; padding-right: 58px; }
  pre { border: 1px solid #30363d; border-radius: 8px; background: #0d1117; padding: 10px; overflow: auto; }
  pre code { border: 0; padding: 0; background: transparent; }
  .code-copy-button { position: absolute; top: 6px; right: 6px; z-index: 1; border: 1px solid #30363d; border-radius: 6px; background: #161b22; color: #8b949e; padding: 3px 7px; font: 12px system-ui, sans-serif; cursor: pointer; }
  .code-copy-button:hover { color: #e6edf3; border-color: #58a6ff; }
  blockquote { border-left: 3px solid #30363d; padding-left: 10px; color: #8b949e; }
  a { color: #58a6ff; }
  h1, h2, h3, h4 { margin: 14px 0 8px; line-height: 1.2; }
  h1:first-child, h2:first-child, h3:first-child, h4:first-child { margin-top: 0; }
  h1 { font-size: 20px; }
  h2 { font-size: 17px; }
  h3 { font-size: 15px; }
  h4 { font-size: 14px; }
  table { border-collapse: collapse; display: block; overflow: auto; }
  th, td { border: 1px solid #30363d; padding: 4px 8px; }
  th { background: #161b22; }
`;

export const statusBarStyles = css`
  :host { display: block; color: #8b949e; font: 12px system-ui, sans-serif; }
  .bar { display: flex; gap: 12px; align-items: center; min-width: 0; padding: 7px 12px; border-top: 1px solid #30363d; background: #0d1117; white-space: nowrap; overflow: hidden; }
  span { overflow: hidden; text-overflow: ellipsis; }
  .bar > span:first-child { flex: 1 1 auto; min-width: 80px; }
  .activity { display: inline-flex; align-items: center; gap: 6px; color: #8b949e; }
  .activity.active { color: #3fb950; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; opacity: .45; flex: 0 0 auto; }
  .activity.active .dot { animation: pulse 1s ease-in-out infinite; opacity: 1; }
  .muted { color: #6e7681; }
  @keyframes pulse { 0%, 100% { transform: scale(.75); opacity: .55; } 50% { transform: scale(1.2); opacity: 1; } }
`;

export const autocompleteStyles = css`
  :host { display: block; }
  .menu { position: absolute; left: 0; right: 0; bottom: calc(100% + 6px); z-index: 10; max-height: 260px; overflow: auto; border: 1px solid #30363d; border-radius: 8px; background: #161b22; box-shadow: 0 10px 30px #0008; }
  button { display: grid; grid-template-columns: minmax(120px, 1fr) auto; gap: 4px 10px; width: 100%; border: 0; border-bottom: 1px solid #30363d; border-radius: 0; background: transparent; color: #e6edf3; padding: 8px 10px; text-align: left; cursor: pointer; }
  button:last-child { border-bottom: 0; }
  button.selected, button:hover { background: #0d2847; }
  span { color: #8b949e; font-size: 12px; }
  small { grid-column: 1 / -1; color: #8b949e; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`;

export const commandPickerStyles = css`
  :host { position: fixed; inset: 0; z-index: 10; color: #e6edf3; font: 14px system-ui, sans-serif; }
  .backdrop { display: grid; place-items: center; width: 100%; height: 100%; background: #0008; }
  section { width: min(720px, calc(100vw - 40px)); max-height: min(640px, calc(100vh - 40px)); display: flex; flex-direction: column; border: 1px solid #30363d; border-radius: 12px; background: #0d1117; box-shadow: 0 20px 60px #000b; overflow: hidden; }
  header { display: flex; align-items: center; justify-content: space-between; padding: 12px; border-bottom: 1px solid #30363d; }
  .options { min-height: 0; overflow: auto; outline: none; }
  button { border: 0; background: transparent; color: #e6edf3; cursor: pointer; }
  header button { font-size: 20px; color: #8b949e; }
  .options button { display: block; width: 100%; padding: 10px 12px; border-bottom: 1px solid #21262d; text-align: left; }
  .options button.selected, .options button:hover { background: #0d2847; }
  small { display: block; margin-top: 4px; color: #8b949e; }
`;

export const actionPaletteStyles = css`
  :host { position: fixed; inset: 0; z-index: 20; color: #e6edf3; font: 14px system-ui, sans-serif; }
  .backdrop { --palette-top: min(12dvh, 90px); --palette-bottom: max(20px, env(safe-area-inset-bottom)); display: grid; align-items: start; justify-items: center; width: 100%; height: 100dvh; background: #0008; padding: var(--palette-top) 20px var(--palette-bottom); box-sizing: border-box; overflow: hidden; }
  section { width: min(720px, 100%); max-height: min(640px, calc(100dvh - var(--palette-top) - var(--palette-bottom))); display: flex; flex-direction: column; border: 1px solid #30363d; border-radius: 12px; background: #0d1117; box-shadow: 0 20px 60px #000b; overflow: hidden; }
  header { display: grid; grid-template-columns: 1fr auto; gap: 8px; padding: 10px; border-bottom: 1px solid #30363d; }
  input { min-width: 0; border: 0; outline: none; background: transparent; color: #e6edf3; font: 16px system-ui, sans-serif; padding: 8px; }
  input::placeholder { color: #6e7681; }
  button { border: 0; background: transparent; color: #e6edf3; cursor: pointer; }
  header button { color: #8b949e; font-size: 22px; padding: 2px 8px; }
  .options { flex: 1 1 auto; min-height: 0; overflow: auto; -webkit-overflow-scrolling: touch; }
  .options button { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 3px 12px; width: 100%; padding: 10px 12px; border-bottom: 1px solid #21262d; text-align: left; }
  .options button.selected, .options button:hover { background: #0d2847; }
  .main { min-width: 0; }
  strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  small { display: block; color: #8b949e; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .group { grid-column: 1 / -1; font-size: 12px; }
  kbd { align-self: center; border: 1px solid #30363d; border-radius: 6px; background: #161b22; color: #8b949e; padding: 2px 6px; font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: nowrap; }
  .empty { padding: 24px; color: #8b949e; text-align: center; }
`;

export const promptEditorStyles = css`
  :host { position: relative; z-index: 5; display: block; color: #e6edf3; font: 14px system-ui, sans-serif; }
  footer { display: grid; grid-template-columns: 1fr auto; gap: 8px; padding: 12px; border-top: 1px solid #30363d; }
  footer.shell-mode { border-top-color: #3fb950; background: #0f1b12; }
  .editor-wrap { position: relative; min-width: 0; }
  .actions { display: flex; gap: 8px; align-items: start; white-space: nowrap; }
  textarea { box-sizing: border-box; width: 100%; min-height: 54px; max-height: 220px; resize: none; overflow-y: auto; border-radius: 8px; border: 1px solid #30363d; background: #0d1117; color: #e6edf3; padding: 8px; }
  .shell-mode textarea { border-color: #3fb950; box-shadow: 0 0 0 1px #3fb95055; }
  .mode-hint { position: absolute; right: 8px; bottom: 8px; max-width: calc(100% - 16px); border: 1px solid #238636; border-radius: 999px; background: #0f2a16; color: #3fb950; padding: 2px 8px; font-size: 12px; pointer-events: none; }
  button { border: 1px solid #30363d; border-radius: 8px; background: #161b22; color: #e6edf3; padding: 7px 9px; cursor: pointer; }
  button:disabled, textarea:disabled { opacity: .5; cursor: not-allowed; }
`;

export const composerStyles = promptEditorStyles;
