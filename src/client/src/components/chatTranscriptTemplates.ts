import { html, nothing } from "lit";
import { live } from "lit/directives/live.js";
import { cache } from "lit/directives/cache.js";
import { MessageActionsMenu } from "./chat/MessageActionsMenu";
import { renderSessionWarningIcon } from "./shared";
import { chatToolOutputLabel, chatMessageGroupClassName, chatMessageGroupLabel } from "./chat/transcriptLabels";
import { chatMessageHasHeader, summarizeChatGroup, type ChatDisplayGroup, type ChatGroup } from "../chatGroups";
import type { ChatBehaviors } from "../chatBehaviors";
import type { AskUserSubmission, SessionRef } from "../api";
import type { AskUserOutcome } from "../../../shared/apiTypes";
import type { ChatContentRendering } from "../formatting/contentRendering";
import type { MarkdownWorkspaceContext } from "../formatting/workspaceLinks";
import type { ChatLine, ChatPart } from "../chatTypes";
import type { ImageOpenDetail } from "./ImagePresentation";
import type { ChatMessageActionController } from "./ChatMessageActionController";

export interface TranscriptGroupDisclosure {
  open: boolean;
  anchor: string | undefined;
  toggle: ((event: Event) => void) | undefined;
}

/** Data and narrow interaction boundaries; templates share ChatView's shadow root. */
export interface TranscriptRenderContext {
  machineId: string;
  sessionId: string;
  session: SessionRef;
  messages: readonly ChatLine[];
  messageStart: number;
  behaviors: ChatBehaviors;
  contentRendering: ChatContentRendering | undefined;
  workspaceContext: MarkdownWorkspaceContext | undefined;
  anchors: {
    message: (index: number, message: ChatLine) => string | undefined;
    event: (index: number, message: ChatLine) => string | undefined;
  };
  disclosure: {
    isOpen: (key: string, defaultOpen: boolean) => boolean;
    toggle: (key: string, event: Event, defaultOpen: boolean) => void;
  };
  metadata: {
    expandedKey: string | undefined;
    label: (message: ChatLine) => string;
    expand: (key: string | undefined) => void;
  };
  actions: ChatMessageActionController;
  openQuestionId: () => string | undefined;
  questionOutcomes: ReadonlyMap<string, AskUserOutcome[]>;
  questionIds: ReadonlySet<string>;
  askDraftSessionId: string;
  onSubmitAsk: ((askId: string, submission: AskUserSubmission) => void | Promise<void>) | undefined;
  openImageGallery: (images: readonly { part: Extract<ChatPart, { type: "image" }>; description: string }[], selectedIndex: number) => void;
}

export function renderMessage(context: TranscriptRenderContext, message: ChatLine, index: number, entryActionHeaders: ReadonlySet<ChatLine>) {
    const toolOnly = isToolExecutionOnlyMessage(message);
    const hasHeader = chatMessageHasHeader(message);
    const shellClass = toolOnly ? "msg tool-execution-shell" : "msg ask-user-record-shell";
    const conversationClass = hasHeader && (message.role === "user" || message.role === "assistant") ? " conversation-message conversation-layout" : "";
    return html`
      <article class=${`${hasHeader ? `msg ${message.role}${conversationClass}` : shellClass} ui-transcript-surface`} data-index=${index} data-scroll-anchor-id=${context.anchors.message(index, message) ?? nothing}>
        ${conversationClass !== "" ? html`
          <div class="conversation-content">
            ${renderMessageHeader(context, message, String(index), index, entryActionHeaders, message.role, true)}
            <div class="conversation-body">${message.parts.map((part, partIndex) => renderPart(context, part, message, index, partIndex))}</div>
          </div>
          ${renderMessageMetadata(context, message, String(index))}
        ` : html`
          ${hasHeader ? renderMessageHeader(context, message, String(index), index, entryActionHeaders) : null}
          ${message.parts.map((part, partIndex) => renderPart(context, part, message, index, partIndex))}
        `}
      </article>
    `;
  }


export function renderToolImageOutputs(context: TranscriptRenderContext, group: Extract<ChatDisplayGroup, { kind: "tool-images" }>, entryActionHeaders: ReadonlySet<ChatLine>) {
    const { outputs } = group;
    const first = outputs[0];
    const sourcesKey = `image-sources:${JSON.stringify([context.machineId, context.sessionId, first.message.entryId ?? first.index])}`;
    const sourcesOpen = context.disclosure.isOpen(sourcesKey, false);
    const label = chatToolOutputLabel(outputs.every((output) => output.toolName === first.toolName) ? first.toolName : undefined);
    const parts = outputs.flatMap((output, outputIndex) => output.message.parts.flatMap((part, partIndex) => part.type !== "image" ? [] : [{
      part, output, anchor: outputIndex > 0 && partIndex === 0 ? context.anchors.message(output.index, output.message) : undefined,
    }]));
    const images = parts.map((image, imageIndex) => ({ ...image,
      description: `${chatToolOutputLabel(image.output.toolName)} image ${String(imageIndex + 1)} of ${String(parts.length)}`,
    }));
    return html`
      <article class="msg tool-image-output conversation-message ui-transcript-surface" data-index=${first.index} data-scroll-anchor-id=${context.anchors.message(first.index, first.message) ?? nothing}>
        ${outputs.length === 1 ? renderMessageHeader(context, first.message, String(first.index), first.index, entryActionHeaders, label) : html`<div class="msg-header"><span class="label">${label}</span></div>`}
        <div class="tool-image-thumbnails">
          ${images.map((image, imageIndex) => html`
            <pi-web-transcript-image .imagePart=${image.part} .thumbnail=${true} .description=${image.description}
              data-index=${image.output.index} data-scroll-anchor-id=${image.anchor ?? nothing}
              .loadingDisabled=${!context.behaviors.loadImages} .session=${context.session} .machineId=${context.machineId}
              @image-open=${(event: CustomEvent<ImageOpenDetail>) => { event.stopPropagation(); context.openImageGallery(images, imageIndex); }}
            ></pi-web-transcript-image>
          `)}
        </div>
        ${outputs.length === 1 ? null : html`
          <details class="image-output-sources" ?open=${live(sourcesOpen)} @toggle=${(event: Event) => { context.disclosure.toggle(sourcesKey, event, false); }}>
            <summary class="ui-transcript-disclosure">Sources (${String(outputs.length)})</summary>
            ${sourcesOpen ? outputs.map((output, outputIndex) => html`<section class="image-output-source" aria-label=${`Output ${String(outputIndex + 1)}`}>
              ${renderMessageHeader(context, output.message, `image-source:${String(output.index)}`, output.index, entryActionHeaders, `${chatToolOutputLabel(output.toolName)} · ${String(outputIndex + 1)}`)}
            </section>`) : nothing}
          </details>
        `}
      </article>
    `;
  }


function isToolExecutionOnlyMessage(message: ChatLine): boolean {
    return message.role === "tool" && message.parts.length > 0 && message.parts.every((part) => part.type === "toolExecution");
  }


// Detached cached bodies retain nested native/tool state without rendering while closed.
// Inline question forms remain standalone readable messages, outside these groups.
export function renderMessageGroup(context: TranscriptRenderContext, group: Extract<ChatGroup, { kind: "group" }>, defaultOpen: boolean, entryActionHeaders: ReadonlySet<ChatLine>, disclosure: TranscriptGroupDisclosure) {
    const { messages, startIndex } = group;
    const { open, anchor, toggle } = disclosure;
    return html`
      <details class=${`${chatMessageGroupClassName(defaultOpen)} ui-transcript-surface ui-transcript-activity`} data-index=${startIndex} data-scroll-anchor-id=${anchor ?? nothing} ?open=${open} @toggle=${toggle}>
        <summary class="ui-transcript-disclosure ui-transcript-heading">
          <span class="label">${chatMessageGroupLabel(defaultOpen)}</span>
          <span>${summarizeChatGroup(messages.map((event) => event.message))}</span>
        </summary>
        ${cache(open ? renderMessageGroupBody(context, group, entryActionHeaders) : nothing)}
      </details>
    `;
  }


export function renderMessageGroupBody(context: TranscriptRenderContext, { messages, startIndex }: Extract<ChatGroup, { kind: "group" }>, entryActionHeaders: ReadonlySet<ChatLine> = new Set()) {
    return html`
      <div class="group-body">
        ${messages.map(({ message, index }, offset) => {
          return html`
            <section class=${`group-msg ${message.role} ui-transcript-surface`} data-index=${index} data-scroll-anchor-id=${context.anchors.event(index, message) ?? nothing}>
              ${chatMessageHasHeader(message) ? html`<div class="transcript-content">${renderMessageHeader(context, message, `${String(startIndex)}:${String(offset)}`, index, entryActionHeaders)}</div>` : null}
              ${renderGroupedParts(context, message, index)}
            </section>`;
        })}
      </div>
    `;
  }


/** Sections own their body inset; only consecutive ordinary content shares outer padding. */
function renderGroupedParts(context: TranscriptRenderContext, message: ChatLine, messageIndex: number) {
  const runs: { section: boolean; parts: { part: ChatPart; index: number }[] }[] = [];
  message.parts.forEach((part, index) => {
    if ((part.type === "text" || part.type === "thinking") && (part.displayText ?? part.text) === "") return;
    const section = part.type === "thinking" || part.type === "toolCall" || part.type === "toolResult"
      || part.type === "toolExecution" || part.type === "askUserQuestion" || part.type === "askUserRecord";
    const previous = runs.at(-1);
    if (!section && previous !== undefined && !previous.section) previous.parts.push({ part, index });
    else runs.push({ section, parts: [{ part, index }] });
  });
  return runs.map((run) => html`
    <div class=${run.section ? "transcript-section" : "transcript-content"}>
      ${run.parts.map(({ part, index }) => renderPart(context, part, message, messageIndex, index))}
    </div>
  `);
}

export function renderMessageHeader(context: TranscriptRenderContext, message: ChatLine, key: string, index: number, entryActionHeaders: ReadonlySet<ChatLine>, label: string = message.role, metadataBelow = false) {
    const meta = context.metadata.label(message);
    const expanded = context.metadata.expandedKey === key;
    const detailId = `message-meta-${key}`;
    const conversation = label === "user" || label === "assistant";
    return html`
      <div class=${conversation ? "msg-header conversation-header" : "msg-header"}>
        <span class=${conversation ? "visually-hidden" : "label"}>${label}</span>
        <pi-message-actions-menu>
          <div class="msg-actions-strip">
            ${renderMessageActions(context, message, key, context.messages[index - context.messageStart] ?? message, entryActionHeaders.has(message))}
            <button type="button" class="msg-meta ui-button ui-button--icon ui-button--small" title=${meta} aria-label="Message information" aria-controls=${detailId} aria-expanded=${String(expanded)} @click=${(event: MouseEvent) => {
              context.metadata.expand(expanded ? undefined : key);
              const menu = event.currentTarget instanceof HTMLElement ? event.currentTarget.closest("pi-message-actions-menu") : null;
              if (menu instanceof MessageActionsMenu) menu.close();
            }}>${renderSessionWarningIcon("info", "msg-info-icon")}</button>
          </div>
        </pi-message-actions-menu>
      </div>
      ${metadataBelow ? null : renderMessageMetadata(context, message, key)}
    `;
  }

function renderMessageMetadata(context: TranscriptRenderContext, message: ChatLine, key: string) {
  return html`<div id=${`message-meta-${key}`} class="msg-meta-details" ?hidden=${context.metadata.expandedKey !== key}>${context.metadata.label(message)}</div>`;
}

export function renderPart(context: TranscriptRenderContext, part: ChatPart, message: ChatLine, messageIndex: number, partIndex: number) {
    const intentKey = JSON.stringify([context.machineId, context.sessionId, message.entryId ?? messageIndex, partIndex]);
    if (part.type === "text" || part.type === "thinking") {
      const text = part.displayText ?? part.text;
      if (text === "") return null;
      if (part.type === "thinking") {
        const disclosureKey = `thinking:${intentKey}`;
        const open = context.disclosure.isOpen(disclosureKey, true);
        return html`
          <details class="part thinking ui-transcript-surface ui-transcript-activity" ?open=${live(open)}
            @toggle=${(event: Event) => { context.disclosure.toggle(disclosureKey, event, true); }}>
            <summary class="ui-transcript-disclosure ui-transcript-heading"><svg class="thinking-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M6 14a5 5 0 1 1 8-1H9l-3 2v-1Z"/><circle cx="4" cy="17" r="1"/></svg>Thinking</summary>
            ${open ? html`<formatted-text .imagesEnabled=${context.behaviors.loadImages} .codeBlocks=${context.behaviors.codeBlocks} .intentKey=${intentKey} .contentRendering=${context.contentRendering} .machineId=${context.machineId} .workspaceContext=${context.workspaceContext} .text=${text}></formatted-text>` : nothing}
          </details>
        `;
      }
      if (message.role === "bash") return html`<pre class="part shell-output">${text}</pre>`;
      return html`<formatted-text .imagesEnabled=${context.behaviors.loadImages} .codeBlocks=${context.behaviors.codeBlocks} .intentKey=${intentKey} class="part" .contentRendering=${context.contentRendering} .machineId=${context.machineId} .workspaceContext=${context.workspaceContext} .text=${text}></formatted-text>`;
    }
    if (part.type === "skillInvocation") {
      const key = `skill:${intentKey}`;
      const open = context.disclosure.isOpen(key, false);
      return html`
      <details class="part skill-invocation" ?open=${live(open)} @toggle=${(event: Event) => { context.disclosure.toggle(key, event, false); }}>
        <summary class="ui-transcript-disclosure"><b>[skill]</b> ${part.name}</summary>
        ${open ? html`<small>${part.location}</small>
        <formatted-text .imagesEnabled=${context.behaviors.loadImages} .codeBlocks=${context.behaviors.codeBlocks} .intentKey=${intentKey} .contentRendering=${context.contentRendering} .machineId=${context.machineId} .workspaceContext=${context.workspaceContext} .text=${part.content}></formatted-text>` : nothing}
      </details>
    `;
    }
    if (part.type === "skillRead") return html`
      <div class="part skill-read">
        <strong>Loaded ${part.name}</strong>
        <small>read ${part.path}</small>
      </div>
    `;
    if (part.type === "askUserQuestion") {
      const open = context.openQuestionId() === part.ask.askId;
      return html`<ask-user-card
        class=${open ? "part open-question-card" : "part closed-question-card"}
        .ask=${part.ask} .open=${open}
        .outcomes=${context.questionOutcomes.get(part.ask.askId) ?? []}
        .draftSessionId=${context.askDraftSessionId}
        .onSubmit=${open ? context.onSubmitAsk : undefined}
      ></ask-user-card>`;
    }
    if (part.type === "askUserRecord") return html`
      <ask-user-card
        class="part"
        .outcome=${part.outcome}
        .compact=${context.questionIds.has(part.outcome.askId)}
        .draftSessionId=${context.askDraftSessionId}
      ></ask-user-card>
    `;
    if (part.type === "image") {
      return html`<pi-web-transcript-image class="part chat-image" .imagePart=${part} .loadingDisabled=${!context.behaviors.loadImages}
        .session=${context.session} .machineId=${context.machineId}
      ></pi-web-transcript-image>`;
    }
    if (part.type === "toolCall") return html`<div class="part tool-line ui-transcript-surface ui-transcript-activity ui-transcript-tool"><div class="ui-transcript-heading"><span aria-hidden="true">▶</span> ${part.toolName}<span class="summary">${part.summary}</span></div></div>`;
    if (part.type === "toolExecution") return html`<tool-execution-view class="part" .execution=${part}></tool-execution-view>`;
    if (part.type === "toolResult") {
      const key = `tool-result:${intentKey}`;
      const open = context.disclosure.isOpen(key, part.isError);
      return html`
      <details class=${`part tool-result ui-transcript-surface ui-transcript-activity ui-transcript-tool${part.isError ? " error" : ""}`} ?open=${live(open)} @toggle=${(event: Event) => { context.disclosure.toggle(key, event, part.isError); }}>
        <summary class="ui-transcript-disclosure ui-transcript-heading">${part.isError ? "✖" : "✓"} ${part.toolName} result${part.isError ? " · Failed" : ""}</summary>
        ${open ? html`<formatted-text .imagesEnabled=${context.behaviors.loadImages} .codeBlocks=${context.behaviors.codeBlocks} .intentKey=${intentKey} .contentRendering=${context.contentRendering} .machineId=${context.machineId} .workspaceContext=${context.workspaceContext} .text=${part.text}></formatted-text>` : nothing}
      </details>
    `;
    }
    return null;
  }


export function renderMessageActions(context: TranscriptRenderContext, message: ChatLine, key: string, source: ChatLine, includeEntryActions: boolean) {
  const actions = context.actions.available(source, message, includeEntryActions);
  if (actions.length === 0) return null;
  const error = context.actions.errorMessage(key);
  return html`
    <div class="msg-actions" aria-label="Message actions">
      ${actions.map(({ action, enabled, ariaLabel }) => {
        const presentation = context.actions.presentation(key, action.id);
        const icon = presentation?.icon ?? action.icon;
        return html`<button type="button" class=${`msg-action ui-button ui-button--small ${icon === undefined ? "" : "ui-button--icon"}`} title=${presentation?.title ?? action.title} aria-label=${presentation?.ariaLabel ?? presentation?.title ?? ariaLabel} ?disabled=${!enabled || context.actions.pending(key, action)} @click=${(event: MouseEvent) => { event.stopPropagation(); void context.actions.run(source, message, key, action); }}>${icon ?? action.title}</button>`;
      })}
      ${error === undefined ? null : html`<span role="alert">${error}</span>`}
    </div>
  `;
}
