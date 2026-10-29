import { css } from "lit";
import { uiButtonStyles, uiToolbarStyles } from "./controlStyles";
import { uiTranscriptStyles } from "./transcriptStyles";
import { chatNavigationStyles } from "./chatNavigationStyles";

export const chatStyles = css`
  ${uiButtonStyles}
  ${uiToolbarStyles}
  ${uiTranscriptStyles}
  ${chatNavigationStyles}
  @layer pi-web-base {
  :host { position: relative; display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: visible; color: var(--pi-text); font: 14px var(--pi-font, system-ui, sans-serif); }
  .chat-wrap { --pi-chat-jump-size: 28px; position: relative; flex: 1 1 auto; min-width: 0; min-height: 0; overflow: visible; display: flex; flex-direction: column; }
  .top-notices { box-sizing: border-box; flex: 0 0 auto; max-height: 40%; min-height: 0; display: flex; flex-direction: column; overflow: hidden; border-bottom: 1px solid var(--pi-border); background: var(--pi-bg-overlay); }
  /* Empty notification hosts retain live regions without leaving a visible stack boundary. */
  .top-notices:has(> session-notification-tray[empty]) { border-bottom: 0; }
  .visually-hidden { position: absolute !important; width: 1px !important; height: 1px !important; padding: 0 !important; margin: -1px !important; overflow: hidden !important; clip: rect(0 0 0 0) !important; clip-path: inset(50%) !important; white-space: nowrap !important; border: 0 !important; }
  /* Contain sticky headers below the overlay scrollbar. Disable native anchoring
     to avoid browser-driven jumps; ChatScrollFlows anchors history prepends. */
  .chat { isolation: isolate; --pi-chat-sticky-top: 0px; flex: 1 1 auto; min-width: 0; min-height: 0; overflow-x: hidden; overflow-y: auto; overflow-anchor: none; padding: 0; box-sizing: border-box; }
  .chat-wrap > .chat-jumps { position: absolute; right: 0; bottom: 0; }
  .chat-wrap.plain .msg-header, .chat-wrap.plain .event-group > summary { position: static; top: auto; }
  .chat-wrap.plain *, .chat-wrap.plain *::before, .chat-wrap.plain *::after { transition: none !important; animation: none !important; box-shadow: none !important; text-shadow: none !important; filter: none !important; backdrop-filter: none !important; transform: none !important; border-radius: 0 !important; }
  .chat-wrap.plain .chat-image { --pi-image-radius: 0; }
  .msg { --ui-transcript-bg: var(--pi-bg); display: flow-root; max-width: 100%; min-width: 0; margin: 0; padding: 12px 16px 16px; overflow: visible; }
  .chat > .msg:last-child, .chat > .session-activity:last-child { margin-bottom: 0; }
  .msg.conversation-message { padding: 12px; --ui-transcript-bg: var(--pi-chat-conversation-bg, color-mix(in srgb, var(--pi-muted) 6%, var(--pi-bg))); --formatted-link-color: color-mix(in srgb, var(--pi-accent) 45%, var(--pi-text) 55%); --formatted-muted-color: color-mix(in srgb, var(--pi-text-secondary) 80%, var(--pi-text) 20%); border-inline-start: 3px solid var(--pi-chat-conversation-border, color-mix(in srgb, var(--pi-muted) 55%, var(--pi-border) 45%)); padding-inline-start: 12px; }
  .msg.user { --ui-transcript-bg: var(--pi-chat-user-bg, color-mix(in srgb, var(--pi-accent) 6%, var(--pi-bg))); border-inline-start-color: var(--pi-chat-user-border, color-mix(in srgb, var(--pi-accent) 55%, var(--pi-bg))); }
  .msg.tool { color: var(--pi-text); }
  .msg.tool-execution-shell, .msg.ask-user-record-shell { padding: 0; border: 0; background: transparent; color: var(--pi-text); }
  .msg.ask-user-record-shell ask-user-card { margin: 0 auto; }
  .msg.system { --ui-transcript-bg: var(--pi-chat-system-bg, color-mix(in srgb, var(--pi-surface) 40%, var(--pi-bg))); color: var(--pi-text-secondary); }
  .msg.event-group { --ui-activity-tone: var(--pi-border); --ui-transcript-bg: var(--pi-bg); --ui-transcript-heading-bg: var(--pi-bg); padding: 0; color: var(--pi-text); }
  .msg.event-group > summary { position: sticky; top: 0; z-index: 5; display: flex; align-items: center; gap: 8px; padding-inline: 13px; }
  .msg.event-group > summary:hover { background: var(--pi-surface-hover); }
  .msg.event-group > summary .label { flex: 0 1 auto; margin: 0; color: inherit; font-weight: 600; }
  .msg.event-group > summary > span { min-width: 0; overflow-wrap: anywhere; }
  .group-body { --ui-activity-edge-width: 0px; padding: 0; }
  .group-msg + .group-msg, .group-msg[data-mount-separator] { border-block-start: 1px solid var(--pi-muted); }
  /* Section surfaces meet without exterior gaps; their children own body padding. */
  .transcript-section { min-width: 0; }
  .transcript-content { min-width: 0; padding: 8px 12px; }
  .transcript-content + .transcript-content { padding-top: 0; }
  .chat-image { --pi-image-max-height: 320px; --pi-image-radius: 8px; display: block; max-width: 100%; margin: 8px 0 0; }
  .tool-image-thumbnails { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 0; }
  .image-output-sources { margin-top: 4px; }
  .image-output-source { padding: 4px 12px; }
  .image-output-source + .image-output-source, .image-output-source[data-mount-separator] { border-top: 1px solid var(--pi-border-muted); }
  .group-msg { display: flow-root; max-width: 100%; min-width: 0; padding: 0; color: var(--pi-text); overflow: visible; }
  .group-msg.system { color: var(--pi-text-secondary); }
  .history-boundary { position: relative; z-index: 5; display: grid; gap: 3px; justify-items: center; margin: 0 0 14px; color: var(--pi-muted); font-size: 12px; text-align: center; }
  .history-load-button { color: var(--pi-text-secondary); }
  .queued-messages { --ui-transcript-bg: color-mix(in srgb, var(--pi-warning) 5%, var(--pi-bg)); max-width: 100%; min-width: 0; display: grid; gap: 8px; margin: 0; padding: 12px 16px; color: var(--pi-text); overflow: hidden; }
  .queued-header { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 10px; }
  .queued-heading { overflow-wrap: anywhere; min-width: 0; flex: 1 1 180px; display: grid; gap: 2px; }
  .queued-heading strong { color: var(--pi-warning); }
  .queued-heading small { color: var(--pi-muted); }
  .queued-clear-button { color: var(--pi-warning); }
  .queued-message { display: grid; gap: 4px; padding-top: 8px; border-top: 1px solid var(--pi-border); }
  .queued-message:first-of-type { padding-top: 0; border-top: 0; }
  .queued-message-header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; }
  .queued-message-actions { flex-wrap: wrap; }
  .queued-action .prompt-action-icon { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
  .queued-message-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }
  .queued-attachments { display: inline-flex; align-items: center; gap: 4px; color: var(--pi-text-secondary); font-size: 12px; }
  .queued-kind { overflow-wrap: anywhere; color: var(--pi-muted); font-size: 12px; text-transform: uppercase; }
  .queued-dialogs { margin: -8px 0 14px; padding: 0 4px; color: var(--pi-muted); font-size: 12px; text-align: center; }
  .session-activity { overflow-wrap: anywhere; --ui-transcript-bg: var(--pi-chat-activity-bg, color-mix(in srgb, var(--pi-surface) 40%, var(--pi-bg))); max-width: 100%; min-width: 0; display: grid; gap: 4px; margin: 0 0 12px; padding: 12px 16px; color: var(--pi-text); overflow: hidden; }
  .session-activity.compacting { --ui-transcript-bg: var(--pi-chat-compacting-bg, color-mix(in srgb, var(--pi-purple) 5%, var(--pi-bg))); }
  .session-activity strong { color: var(--pi-purple); }
  .session-activity span, .session-activity small { color: var(--pi-muted); }
  .history-boundary small { color: var(--pi-dim); }
  .msg-header { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 28px; margin-bottom: 4px; }
  .msg.conversation-layout { padding: 0; }
  .conversation-content { position: relative; min-width: 0; }
  .conversation-body { min-width: 0; padding: 12px; }
  .conversation-layout > .msg-meta-details { padding: 6px 12px; }
  .conversation-content > .msg-header.conversation-header { position: absolute; inset-block-end: 0; inset-inline-end: 0; z-index: 6; min-height: 0; margin: 0; }
  .msg-actions { display: contents; }
  .msg-actions-strip { display: flex; flex-wrap: nowrap; width: max-content; background: var(--ui-transcript-bg, var(--pi-bg)); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--pi-text) 12%, transparent); }
  pi-message-actions-menu[open] { background: var(--ui-transcript-bg, var(--pi-bg)); }
  .msg-actions-strip .ui-button { flex: 0 0 auto; white-space: nowrap; }
  .msg-actions [role="alert"] { max-width: 240px; padding: 4px 10px; color: var(--pi-danger); }
  .msg-fork-icon { font-size: 14px; }
  .msg-info-icon { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
  pi-message-actions-menu { flex: 0 0 auto; }
  .label { display: block; color: var(--pi-muted); font-size: 12px; font-weight: 400; }
  .msg-header .label { min-width: 0; margin: 0; overflow-wrap: anywhere; }
  .msg-actions-strip .ui-button:hover:not(:disabled), .msg-meta[aria-expanded="true"] { background: color-mix(in srgb, var(--pi-text) 8%, transparent); color: var(--pi-text); }
  .msg-meta-details { clear: both; min-width: 0; padding: 6px 0; color: var(--pi-muted); font: 12px/18px var(--pi-font, system-ui, sans-serif); overflow-wrap: anywhere; user-select: text; -webkit-user-select: text; }
  formatted-text.part { display: block; }
  formatted-text.part, .queued-message formatted-text { text-align: start; unicode-bidi: plaintext; }
  .part { max-width: 100%; min-width: 0; box-sizing: border-box; overflow: visible; overflow-wrap: anywhere; }
  .part + .part { margin-top: 10px; }
  .generated-text { white-space: pre-wrap; overflow-wrap: anywhere; text-align: start; }
  .thinking { --ui-activity-tone: var(--pi-thinking, color-mix(in srgb, #4f83b3 70%, var(--pi-text) 30%)); }
  .thinking-icon { flex: 0 0 auto; width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.5; }
  .thinking > summary { font-weight: 600; }
  .tool-line > .ui-transcript-heading { font: 13px/20px var(--pi-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); overflow-wrap: anywhere; }
  .tool-result.error { --ui-activity-tone: var(--pi-danger); }
  .tool-result.error > summary { color: color-mix(in srgb, var(--pi-danger) 65%, var(--pi-text) 35%); }
  .summary { color: var(--pi-text-secondary); margin-inline-start: 6px; }
  .part:is(details):not(.ui-transcript-activity) { padding-top: 4px; }
  .part:is(details) > formatted-text { padding: 8px 12px 0; box-sizing: border-box; }
  .part.ui-transcript-activity > formatted-text { padding: 8px 12px 12px; }
  .part > formatted-text { display: block; max-width: 100%; min-width: 0; overflow: visible; }
  .skill-invocation, .skill-read { padding: 8px 0; }
  .skill-invocation > summary, .skill-read > strong { color: var(--pi-purple); }
  .skill-invocation > summary > b { flex: 0 0 auto; }
  .skill-invocation > summary > bdi { min-width: 0; overflow-wrap: anywhere; }
  .skill-invocation > small, .skill-read > small { display: block; max-width: 100%; margin: 6px 0 0; overflow-x: auto; overflow-y: hidden; overscroll-behavior-x: contain; scrollbar-width: thin; white-space: nowrap; color: var(--pi-muted); direction: ltr; text-align: left; unicode-bidi: isolate; }
  .skill-read > small { direction: inherit; text-align: start; unicode-bidi: plaintext; white-space: normal; overflow-wrap: anywhere; }
  summary { cursor: pointer; color: var(--pi-muted); }
  pre { margin: 6px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; direction: ltr; text-align: left; unicode-bidi: isolate; }
  .shell-output { color: var(--pi-text); font: 13px var(--pi-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); line-height: 1.45; direction: ltr; text-align: left; unicode-bidi: isolate; }
  }
`;
