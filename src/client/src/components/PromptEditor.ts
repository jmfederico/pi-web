import { defaultKeymap, history, historyKeymap, indentWithTab, insertNewlineAndIndent } from "@codemirror/commands";
import { markdown, deleteMarkupBackward, insertNewlineContinueMarkup } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { defaultHighlightStyle, indentOnInput, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { LitElement, html, type PropertyValues } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { api, type FileSuggestion, type SessionStatus, type SlashCommand } from "../api";
import { inputModeForDraft } from "../inputModes";
import { clearDraft, loadDraft, saveDraft } from "../promptDraftStorage";
import { promptEditorStyles, type CompletionItem } from "./shared";
import "./AutocompleteMenu";

@customElement("prompt-editor")
export class PromptEditor extends LitElement {
  @property({ type: Boolean }) disabled = false;
  @property() sessionId?: string;
  @property() cwd?: string;
  @property() machineId = "local";
  @property({ type: Boolean }) canSteer = false;
  @property({ type: Boolean }) isCompacting = false;
  @property({ type: Boolean }) canStop = false;
  @property({ attribute: false }) status?: SessionStatus;
  @property({ attribute: false }) onSend?: (text: string, streamingBehavior?: "steer" | "followUp") => void;
  @property({ attribute: false }) onStop?: () => void;
  @property({ attribute: false }) onSelectModel?: () => void;
  @property({ attribute: false }) onSelectThinking?: () => void;
  @query(".markdown-editor") private editorHost?: HTMLDivElement;
  @state() private draft = "";
  @state() private completions: CompletionItem[] = [];
  @state() private selectedIndex = 0;
  private requestVersion = 0;
  private editor: EditorView | undefined;
  private readonly editableCompartment = new Compartment();
  private readonly readOnlyCompartment = new Compartment();

  protected override willUpdate(changed: PropertyValues<this>) {
    if (!changed.has("sessionId")) return;
    const previousSessionId = changed.get("sessionId");
    if (previousSessionId !== undefined && previousSessionId !== "") saveDraft(previousSessionId, this.draft);
    this.draft = this.sessionId !== undefined && this.sessionId !== "" ? loadDraft(this.sessionId) : "";
    this.completions = [];
    this.selectedIndex = 0;
  }

  override firstUpdated(): void {
    this.createEditor();
  }

  protected override updated(changed: PropertyValues) {
    if (changed.has("disabled")) this.updateEditorDisabledState();
    if (changed.has("draft") || changed.has("sessionId")) this.syncEditorDoc();
  }

  override disconnectedCallback(): void {
    this.editor?.destroy();
    this.editor = undefined;
    super.disconnectedCallback();
  }

  override render() {
    const inputMode = inputModeForDraft(this.draft);
    const shellMode = inputMode.kind === "shell";
    const queuesInput = this.canSteer || this.isCompacting;
    return html`
      <footer class=${shellMode ? "shell-mode" : ""}>
        <div class="editor-wrap">
          <div class=${`markdown-editor${this.disabled ? " markdown-editor-disabled" : ""}`} aria-label="Message pi" aria-disabled=${this.disabled ? "true" : "false"}></div>
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
    this.editor?.focus();
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

  private createEditor() {
    if (!this.editorHost || this.editor !== undefined) return;
    this.editor = new EditorView({
      parent: this.editorHost,
      state: EditorState.create({
        doc: this.draft,
        extensions: [
          history(),
          markdown(),
          indentOnInput(),
          indentUnit.of("  "),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of((view) => inputAssistanceContentAttributes(view.state.sliceDoc(0, view.state.selection.main.head))),
          placeholder("Message pi... Use / for commands, @ for tracked files, @ space for all files"),
          this.editableCompartment.of(EditorView.editable.of(!this.disabled)),
          this.readOnlyCompartment.of(EditorState.readOnly.of(this.disabled)),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) this.updateDraft(update.state.doc.toString());
          }),
          keymap.of([
            { key: "ArrowDown", run: () => this.moveCompletion(1) },
            { key: "ArrowUp", run: () => this.moveCompletion(-1) },
            { key: "Escape", run: () => this.closeCompletions() },
            { key: "Enter", run: () => this.handleEditorEnter() },
            { key: "Shift-Enter", run: (view) => insertNewlineContinueMarkup(view) || insertNewlineAndIndent(view) },
            { key: "Tab", run: (view) => this.handleEditorTab(view) },
            { key: "Shift-Tab", run: (view) => indentWithTab.shift?.(view) ?? false },
            { key: "Backspace", run: (view) => deleteMarkupBackward(view) },
            ...historyKeymap,
            ...defaultKeymap,
          ]),
        ],
      }),
    });
  }

  private syncEditorDoc() {
    const editor = this.editor;
    if (!editor) return;
    const current = editor.state.doc.toString();
    if (current === this.draft) return;
    editor.dispatch({
      changes: { from: 0, to: current.length, insert: this.draft },
      selection: EditorSelection.cursor(this.draft.length),
    });
  }

  private updateEditorDisabledState() {
    this.editor?.dispatch({
      effects: [
        this.editableCompartment.reconfigure(EditorView.editable.of(!this.disabled)),
        this.readOnlyCompartment.reconfigure(EditorState.readOnly.of(this.disabled)),
      ],
    });
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
      const commands = await api.commands(this.sessionId, this.machineId).catch(emptySlashCommands);
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
      const files = await api.files(this.cwd, trigger.query, { kind: trigger.fileKind, mode: trigger.fileMode, scope: trigger.fileScope, machineId: this.machineId }).catch(emptyFileSuggestions);
      if (version !== this.requestVersion) return;
      this.completions = files
        .slice(0, 12)
        .map((file) => {
          const insertText = fileInsertText(file.path, trigger.quoted === true, file.path.endsWith("/") ? trigger.allPrefix : undefined);
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

  private currentTrigger(): { kind: "command" | "file"; query: string; from: number; to: number; fileScope?: "tracked" | "all" | undefined; allPrefix?: "@ " | "!@" | undefined; quoted?: boolean } | undefined {
    const cursor = this.editor?.state.selection.main.head ?? this.draft.length;
    const beforeCursor = this.draft.slice(0, cursor);
    const quotedTrigger = this.currentQuotedTrigger(beforeCursor, cursor);
    if (quotedTrigger !== undefined) return quotedTrigger;

    const tokenStart = Math.max(beforeCursor.lastIndexOf(" "), beforeCursor.lastIndexOf("\n")) + 1;
    const token = beforeCursor.slice(tokenStart);
    const beforeToken = beforeCursor.slice(0, tokenStart);
    if (beforeToken.endsWith("@ ")) return { kind: "file", query: token, from: tokenStart - 2, to: cursor, fileScope: "all", allPrefix: "@ " };
    if (token.startsWith("/") && tokenStart === 0) return { kind: "command", query: token.slice(1), from: tokenStart, to: cursor };
    if (token.startsWith("!@")) return { kind: "file", query: token.slice(2), from: tokenStart, to: cursor, fileScope: "all", allPrefix: "!@" };
    if (token.startsWith("@")) return { kind: "file", query: token.slice(1), from: tokenStart, to: cursor, fileScope: "tracked" };
    return undefined;
  }

  private currentQuotedTrigger(beforeCursor: string, cursor: number): { kind: "file"; query: string; from: number; to: number; fileScope?: "tracked" | "all" | undefined; allPrefix?: "@ " | "!@" | undefined; quoted: true } | undefined {
    const quoteStart = beforeCursor.lastIndexOf("\"");
    if (quoteStart === -1) return undefined;
    const prefix = beforeCursor.slice(0, quoteStart);
    if (prefix.endsWith("!@")) return { kind: "file", query: beforeCursor.slice(quoteStart + 1), from: prefix.length - 2, to: cursor, fileScope: "all", allPrefix: "!@", quoted: true };
    if (prefix.endsWith("@")) return { kind: "file", query: beforeCursor.slice(quoteStart + 1), from: prefix.length - 1, to: cursor, fileScope: "tracked", quoted: true };
    if (prefix.endsWith("@ ")) return { kind: "file", query: beforeCursor.slice(quoteStart + 1), from: prefix.length - 2, to: cursor, fileScope: "all", allPrefix: "@ ", quoted: true };
    return undefined;
  }

  private moveCompletion(delta: number): boolean {
    if (!this.completions.length) return false;
    this.selectedIndex = (this.selectedIndex + delta + this.completions.length) % this.completions.length;
    return true;
  }

  private closeCompletions(): boolean {
    if (!this.completions.length) return false;
    this.completions = [];
    return true;
  }

  private handleEditorEnter(): boolean {
    if (this.completions.length) {
      const completion = this.completions[this.selectedIndex];
      if (completion !== undefined) this.pick(completion);
      return true;
    }
    this.send(this.canSteer || this.isCompacting ? "followUp" : undefined);
    return true;
  }

  private handleEditorTab(view: EditorView): boolean {
    if (this.completions.length) {
      const completion = this.completions[this.selectedIndex];
      if (completion !== undefined) this.pick(completion);
      return true;
    }
    const trigger = this.currentTrigger();
    if (trigger?.kind === "file") {
      void this.refreshCompletions();
      return true;
    }
    return indentWithTab.run?.(view) ?? false;
  }

  private pick(item: CompletionItem) {
    const editor = this.editor;
    if (!editor) return;
    const suffix = item.kind === "file" && (item.insertText.endsWith("/") || item.cursorOffset !== undefined) ? "" : " ";
    const cursor = item.replaceFrom + (item.cursorOffset ?? item.insertText.length) + suffix.length;
    const replaceTo = item.insertText.endsWith("\"") && this.draft.slice(item.replaceTo).startsWith("\"") ? item.replaceTo + 1 : item.replaceTo;
    editor.dispatch({
      changes: { from: item.replaceFrom, to: replaceTo, insert: `${item.insertText}${suffix}` },
      selection: EditorSelection.cursor(cursor),
      scrollIntoView: true,
    });
    this.completions = [];
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

function fileInsertText(path: string, quoted: boolean, allPrefix?: "@ " | "!@"): string {
  const prefix = allPrefix ?? "@";
  if (!quoted && !path.includes(" ")) return `${prefix}${path}`;
  return `${prefix}"${path}"`;
}

function emptySlashCommands(): SlashCommand[] {
  return [];
}

function emptyFileSuggestions(): FileSuggestion[] {
  return [];
}

const proseInputAssistanceAttributes: Record<string, string> = {
  spellcheck: "true",
  autocorrect: "on",
  autocapitalize: "sentences",
  writingsuggestions: "true",
};

const codeLikeInputAssistanceAttributes: Record<string, string> = {
  spellcheck: "false",
  autocorrect: "off",
  autocapitalize: "off",
  writingsuggestions: "false",
};

function inputAssistanceContentAttributes(draftBeforeCursor: string): Record<string, string> {
  // CodeMirror is optimized for code and disables these by default, but the chat prompt is usually prose.
  return inputModeForDraft(draftBeforeCursor).kind === "normal" ? proseInputAssistanceAttributes : codeLikeInputAssistanceAttributes;
}

