import { LitElement, html, type PropertyValues } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { api, type FileSuggestion, type SessionStatus, type SlashCommand } from "../api";
import { inputModeForDraft } from "../inputModes";
import { promptEditorStyles, type CompletionItem } from "./shared";
import "./AutocompleteMenu";

@customElement("prompt-editor")
export class PromptEditor extends LitElement {
  @property({ type: Boolean }) disabled = false;
  @property() sessionId?: string;
  @property() cwd?: string;
  @property({ type: Boolean }) canSteer = false;
  @property({ type: Boolean }) isCompacting = false;
  @property({ type: Boolean }) canStop = false;
  @property({ attribute: false }) status?: SessionStatus;
  @property({ attribute: false }) onSend?: (text: string, streamingBehavior?: "steer" | "followUp") => void;
  @property({ attribute: false }) onStop?: () => void;
  @property({ attribute: false }) onSelectModel?: () => void;
  @property({ attribute: false }) onSelectThinking?: () => void;
  @query("textarea") private textarea?: HTMLTextAreaElement;
  @state() private draft = "";
  @state() private completions: CompletionItem[] = [];
  @state() private selectedIndex = 0;
  private requestVersion = 0;

  protected override willUpdate(changed: PropertyValues<this>) {
    if (!changed.has("sessionId")) return;
    const previousSessionId = changed.get("sessionId");
    if (previousSessionId !== undefined && previousSessionId !== "") saveDraft(previousSessionId, this.draft);
    this.draft = this.sessionId !== undefined && this.sessionId !== "" ? loadDraft(this.sessionId) : "";
    this.completions = [];
    this.selectedIndex = 0;
  }

  protected override updated(changed: PropertyValues) {
    if (changed.has("draft") || changed.has("sessionId")) this.resizeTextarea();
  }

  override render() {
    const inputMode = inputModeForDraft(this.draft);
    const shellMode = inputMode.kind === "shell";
    const queuesInput = this.canSteer || this.isCompacting;
    return html`
      <footer class=${shellMode ? "shell-mode" : ""}>
        <div class="editor-wrap">
          <textarea
            .value=${this.draft}
            ?disabled=${this.disabled}
            @input=${(event: Event) => {
              if (event.target instanceof HTMLTextAreaElement) this.updateDraft(event.target.value);
            }}
            @keydown=${(event: KeyboardEvent) => { this.handleKeyDown(event); }}
            placeholder="Message pi... Use / for commands, @ for files"
          ></textarea>
          ${shellMode ? html`<div class="mode-hint">Shell command${inputMode.excludeFromContext ? " · excluded from context" : ""}</div>` : null}
          ${this.isCompacting && !shellMode ? html`<div class="mode-hint">Compacting history · message will be queued</div>` : null}
          <autocomplete-menu .items=${this.completions} .selectedIndex=${this.selectedIndex} .onPick=${(item: CompletionItem) => { this.pick(item); }}></autocomplete-menu>
        </div>
        <div class="actions">
          ${this.renderCompactStatus()}
          <button ?disabled=${this.disabled} title=${queuesInput ? "Queue until the current activity finishes" : "Send message"} @click=${() => { this.send("followUp"); }}>${queuesInput ? "Queue" : "Send"}</button>
          ${this.canSteer && !this.isCompacting ? html`<button ?disabled=${this.disabled} title="Steer the current response before the next model call" @click=${() => { this.send("steer"); }}>Steer</button>` : null}
          <button ?disabled=${this.disabled || !this.canStop} title=${this.canStop ? "Stop current work and clear queued messages" : "Nothing running"} @click=${() => this.onStop?.()}>Stop</button>
        </div>
      </footer>
    `;
  }

  focusInput() {
    this.textarea?.focus();
  }

  private renderCompactStatus() {
    const status = this.status;
    if (status === undefined) return null;
    const model = status.model?.id ?? "no model";
    const provider = status.model?.provider !== undefined && status.model.provider !== "" ? `${status.model.provider}/` : "";
    return html`
      <div class="compact-status" aria-label="Session status">
        <button class="select-model" title="Select model" @click=${() => this.onSelectModel?.()}>${provider}${model}</button>
        <button class="select-thinking" title="Select thinking level" @click=${() => this.onSelectThinking?.()}>think ${status.thinkingLevel ?? "off"}</button>
      </div>
    `;
  }

  private resizeTextarea() {
    const textarea = this.textarea;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${String(textarea.scrollHeight)}px`;
  }

  private updateDraft(value: string) {
    this.draft = value;
    if (this.sessionId !== undefined && this.sessionId !== "") saveDraft(this.sessionId, this.draft);
    void this.refreshCompletions();
  }

  private async refreshCompletions() {
    const trigger = this.currentTrigger();
    const version = ++this.requestVersion;
    this.selectedIndex = 0;
    if (trigger === undefined) {
      this.completions = [];
      return;
    }
    if (trigger.kind === "command" && this.sessionId !== undefined && this.sessionId !== "") {
      const commands = await api.commands(this.sessionId).catch(emptySlashCommands);
      if (version !== this.requestVersion) return;
      this.completions = commands
        .filter((command) => command.name.toLowerCase().includes(trigger.query.toLowerCase()))
        .slice(0, 12)
        .map((command) => ({
          kind: "command",
          replaceFrom: trigger.from,
          replaceTo: trigger.to,
          insertText: `/${command.name}`,
          detail: command.source,
          ...(command.description === undefined ? {} : { description: command.description }),
        }));
    } else if (trigger.kind === "file" && this.cwd !== undefined && this.cwd !== "") {
      const files = await api.files(this.cwd, trigger.query, trigger.fileKind, trigger.fileMode).catch(emptyFileSuggestions);
      if (version !== this.requestVersion) return;
      this.completions = files
        .slice(0, 12)
        .map((file) => {
          const insertText = fileInsertText(file.path, trigger.fileMode === "path", trigger.quoted === true);
          return {
            kind: "file",
            replaceFrom: trigger.from,
            replaceTo: trigger.to,
            insertText,
            detail: file.kind,
            ...(file.path.endsWith("/") && insertText.endsWith("\"") ? { cursorOffset: insertText.length - 1 } : {}),
          };
        });
    }
  }

  private currentTrigger(): { kind: "command" | "file"; query: string; from: number; to: number; fileKind?: FileSuggestion["kind"]; fileMode?: "file" | "path"; quoted?: boolean } | undefined {
    const cursor = this.textarea?.selectionStart ?? this.draft.length;
    const beforeCursor = this.draft.slice(0, cursor);
    const quotedTrigger = this.currentQuotedTrigger(beforeCursor, cursor);
    if (quotedTrigger !== undefined) return quotedTrigger;

    const tokenStart = Math.max(beforeCursor.lastIndexOf(" "), beforeCursor.lastIndexOf("\n")) + 1;
    const token = beforeCursor.slice(tokenStart);
    const beforeToken = beforeCursor.slice(0, tokenStart);
    if (beforeToken.endsWith("@ ")) return { kind: "file", query: token, from: tokenStart, to: cursor, fileMode: "path" };
    if (token.startsWith("/") && tokenStart === 0) return { kind: "command", query: token.slice(1), from: tokenStart, to: cursor };
    if (token.startsWith("@")) return { kind: "file", query: token.slice(1), from: tokenStart, to: cursor };
    return undefined;
  }

  private currentQuotedTrigger(beforeCursor: string, cursor: number): { kind: "file"; query: string; from: number; to: number; fileMode?: "file" | "path"; quoted: true } | undefined {
    const quoteStart = beforeCursor.lastIndexOf("\"");
    if (quoteStart === -1) return undefined;
    const prefix = beforeCursor.slice(0, quoteStart);
    if (prefix.endsWith("@")) return { kind: "file", query: beforeCursor.slice(quoteStart + 1), from: prefix.length - 1, to: cursor, quoted: true };
    if (prefix.endsWith("@ ")) return { kind: "file", query: beforeCursor.slice(quoteStart + 1), from: quoteStart, to: cursor, fileMode: "path", quoted: true };
    return undefined;
  }

  private handleKeyDown(event: KeyboardEvent) {
    if (this.completions.length) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        this.selectedIndex = (this.selectedIndex + 1) % this.completions.length;
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        this.selectedIndex = (this.selectedIndex - 1 + this.completions.length) % this.completions.length;
        return;
      }
      if (event.key === "Tab" || event.key === "Enter") {
        event.preventDefault();
        const completion = this.completions[this.selectedIndex];
        if (completion !== undefined) this.pick(completion);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        this.completions = [];
        return;
      }
    }
    if (event.key === "Tab") {
      const trigger = this.currentTrigger();
      if (trigger?.kind === "file") {
        event.preventDefault();
        void this.refreshCompletions();
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      this.send(this.canSteer || this.isCompacting ? "followUp" : undefined);
    }
  }

  private pick(item: CompletionItem) {
    const suffix = item.kind === "file" && (item.insertText.endsWith("/") || item.cursorOffset !== undefined) ? "" : " ";
    const cursor = item.replaceFrom + (item.cursorOffset ?? item.insertText.length) + suffix.length;
    const after = item.insertText.endsWith("\"") && this.draft.slice(item.replaceTo).startsWith("\"") ? this.draft.slice(item.replaceTo + 1) : this.draft.slice(item.replaceTo);
    this.draft = `${this.draft.slice(0, item.replaceFrom)}${item.insertText}${suffix}${after}`;
    if (this.sessionId !== undefined && this.sessionId !== "") saveDraft(this.sessionId, this.draft);
    this.completions = [];
    void this.updateComplete.then(() => this.textarea?.setSelectionRange(cursor, cursor));
  }

  private send(streamingBehavior?: "steer" | "followUp") {
    const text = this.draft.trim();
    if (text === "" || this.disabled) return;
    this.draft = "";
    if (this.sessionId !== undefined && this.sessionId !== "") clearDraft(this.sessionId);
    this.completions = [];
    this.onSend?.(text, this.canSteer || this.isCompacting ? streamingBehavior : undefined);
  }

  static override styles = promptEditorStyles;
}

function fileInsertText(path: string, pathMode: boolean, quoted: boolean): string {
  const prefix = pathMode ? "" : "@";
  if (!quoted && !path.includes(" ")) return `${prefix}${path}`;
  return `${prefix}"${path}"`;
}

function emptySlashCommands(): SlashCommand[] {
  return [];
}

function emptyFileSuggestions(): FileSuggestion[] {
  return [];
}

const draftStoragePrefix = "pi-web:prompt-draft:";

function draftStorageKey(sessionId: string): string {
  return `${draftStoragePrefix}${sessionId}`;
}

function loadDraft(sessionId: string): string {
  try {
    return localStorage.getItem(draftStorageKey(sessionId)) ?? "";
  } catch {
    return "";
  }
}

function saveDraft(sessionId: string, draft: string): void {
  try {
    if (draft) localStorage.setItem(draftStorageKey(sessionId), draft);
    else localStorage.removeItem(draftStorageKey(sessionId));
  } catch {
    // Ignore localStorage quota/privacy errors.
  }
}

function clearDraft(sessionId: string): void {
  try {
    localStorage.removeItem(draftStorageKey(sessionId));
  } catch {
    // Ignore localStorage quota/privacy errors.
  }
}
