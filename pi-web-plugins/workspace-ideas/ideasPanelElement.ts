import type { WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import {
  appendPiWebGitignoreEntry,
  archiveIdea,
  createIdea,
  emptyIdeasConfig,
  gitignoreContainsPiWeb,
  gitignorePath,
  ideasCacheKey,
  ideasConfigPath,
  ideasDirectoryPath,
  parseIdeasConfig,
  withRunSession,
  type Idea,
  type IdeasConfig,
} from "./config.js";
import { startIdeaSession, writeWorkspaceFile } from "./ideasApi.js";
import { escapeAttr, escapeHtml, formatDate } from "./html.js";
import { ideasStyles } from "./styles.js";

export const ideasPanelTagName = "pi-web-workspace-ideas-panel";

const ideasChangedEvent = "pi-web-workspace-ideas-changed";
const missingWorkspaceFileError = "Path does not exist";

type GitignoreState =
  | { kind: "loading" }
  | { kind: "ignored" }
  | { kind: "not-ignored"; gitignoreExists: boolean };

interface IdeaStatus {
  kind: "info" | "success" | "error";
  message: string;
}

const configCache = new Map<string, IdeasConfig>();

export function defineIdeasPanelElement(): void {
  if (!customElements.get(ideasPanelTagName)) customElements.define(ideasPanelTagName, PiWebIdeasPanel);
}

export function ideasPanelBadge(context: WorkspacePanelContext): string | number | undefined {
  const count = configCache.get(ideasCacheKey(context))?.ideas.length ?? 0;
  return count > 0 ? count : undefined;
}

class PiWebIdeasPanel extends HTMLElement {
  private contextValue: WorkspacePanelContext | undefined;
  private contextKey: string | undefined;
  private draft = "";
  private runningIdeaId: string | undefined;
  private status: IdeaStatus | undefined;
  private gitignore: GitignoreState = { kind: "loading" };
  private loading = false;
  private readonly root = this.attachShadow({ mode: "open" });
  private readonly onIdeasChanged = () => { void this.loadAndRender({ force: true }); };

  set context(value: WorkspacePanelContext | undefined) {
    const nextKey = value === undefined ? undefined : ideasCacheKey(value);
    this.contextValue = value;
    if (this.contextKey === nextKey) return;

    this.contextKey = nextKey;
    this.runningIdeaId = undefined;
    this.status = undefined;
    this.gitignore = { kind: "loading" };
    void this.loadAndRender({ force: true });
  }

  connectedCallback(): void {
    window.addEventListener(ideasChangedEvent, this.onIdeasChanged);
    void this.loadAndRender();
  }

  disconnectedCallback(): void {
    window.removeEventListener(ideasChangedEvent, this.onIdeasChanged);
  }

  private async loadAndRender(options?: { force?: boolean | undefined }): Promise<void> {
    const context = this.contextValue;
    if (context === undefined) {
      this.render();
      return;
    }

    if (this.loading) return;
    if (configCache.has(ideasCacheKey(context)) && options?.force !== true) {
      this.render();
      return;
    }

    this.loading = true;
    try {
      await Promise.all([this.loadConfig(context), this.loadGitignoreState(context)]);
    } finally {
      this.loading = false;
    }
    this.render();
  }

  private async loadConfig(context: WorkspacePanelContext): Promise<IdeasConfig> {
    try {
      const file = await context.files.readFile(ideasConfigPath);
      if (file.binary || file.truncated) throw new Error(`${ideasConfigPath} must be a small text file`);
      const config = parseIdeasConfig(JSON.parse(file.content));
      configCache.set(ideasCacheKey(context), config);
      return config;
    } catch (error) {
      if (errorMessage(error) !== missingWorkspaceFileError) {
        this.status = { kind: "error", message: error instanceof Error ? error.message : String(error) };
      }
      const config = emptyIdeasConfig();
      configCache.set(ideasCacheKey(context), config);
      return config;
    }
  }

  private async loadGitignoreState(context: WorkspacePanelContext): Promise<void> {
    try {
      const file = await context.files.readFile(gitignorePath);
      this.gitignore = gitignoreContainsPiWeb(file.content)
        ? { kind: "ignored" }
        : { kind: "not-ignored", gitignoreExists: true };
    } catch (error) {
      this.gitignore = errorMessage(error) === missingWorkspaceFileError
        ? { kind: "not-ignored", gitignoreExists: false }
        : { kind: "not-ignored", gitignoreExists: true };
    }
  }

  private render(): void {
    const context = this.contextValue;
    if (context === undefined) {
      this.root.innerHTML = `${ideasStyles()}<section class="empty">Select a workspace.</section>`;
      return;
    }

    const config = configCache.get(ideasCacheKey(context)) ?? emptyIdeasConfig();
    this.root.innerHTML = `
      ${ideasStyles()}
      <section class="toolbar">
        <strong>Ideas</strong>
        <span>${String(config.ideas.length)} active · ${String(config.archive.length)} archived</span>
      </section>
      ${this.renderGitignoreWarning()}
      ${this.renderStatus()}
      ${this.renderComposer()}
      <section class="ideas">
        ${config.ideas.length === 0 ? `<p class="muted">No ideas yet.</p>` : config.ideas.map((idea) => renderIdea(context, idea, this.runningIdeaId)).join("")}
      </section>
    `;
    this.bindRenderedControls(context);
  }

  private renderComposer(): string {
    return `
      <section class="composer">
        <label for="idea-input">New idea</label>
        <textarea id="idea-input" rows="4" placeholder="Describe an idea to run in a new Pi session…">${escapeHtml(this.draft)}</textarea>
        <div class="composer-actions"><button data-add-idea>Add idea</button></div>
      </section>
    `;
  }

  private renderGitignoreWarning(): string {
    if (this.gitignore.kind !== "not-ignored") return "";
    const message = this.gitignore.gitignoreExists
      ? `${ideasDirectoryPath}/ is not ignored by Git.`
      : `${gitignorePath} is missing and ${ideasDirectoryPath}/ is not ignored by Git.`;
    return `<div class="warning"><span>${escapeHtml(message)}</span><button data-fix-gitignore>Fix</button></div>`;
  }

  private renderStatus(): string {
    if (this.status === undefined) return "";
    return `<div class="status ${escapeAttr(this.status.kind)}">${escapeHtml(this.status.message)}</div>`;
  }

  private bindRenderedControls(context: WorkspacePanelContext): void {
    const textarea = this.root.querySelector<HTMLTextAreaElement>("#idea-input");
    textarea?.addEventListener("input", () => { this.draft = textarea.value; });
    this.root.querySelector("button[data-add-idea]")?.addEventListener("click", () => { void this.addIdea(context, textarea?.value ?? ""); });
    this.root.querySelector("button[data-fix-gitignore]")?.addEventListener("click", () => { void this.fixGitignore(context); });
    for (const button of this.root.querySelectorAll("button[data-run-idea]")) button.addEventListener("click", () => { void this.runIdea(context, button.getAttribute("data-run-idea")); });
    for (const button of this.root.querySelectorAll("button[data-delete-idea]")) button.addEventListener("click", () => { void this.deleteIdea(context, button.getAttribute("data-delete-idea")); });
    for (const button of this.root.querySelectorAll("button[data-done-idea]")) button.addEventListener("click", () => { void this.archiveIdea(context, button.getAttribute("data-done-idea")); });
  }

  private async addIdea(context: WorkspacePanelContext, text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed === "") {
      this.status = { kind: "error", message: "Idea text is required." };
      this.render();
      return;
    }

    const config = await this.loadConfig(context);
    config.ideas.unshift(createIdea(trimmed));
    await this.saveConfig(context, config);
    this.draft = "";
    this.status = { kind: "success", message: "Idea saved." };
    this.changed(context);
  }

  private async deleteIdea(context: WorkspacePanelContext, ideaId: string | null): Promise<void> {
    if (ideaId === null) return;
    const config = await this.loadConfig(context);
    config.ideas = config.ideas.filter((idea) => idea.id !== ideaId);
    await this.saveConfig(context, config);
    this.status = { kind: "success", message: "Idea deleted." };
    this.changed(context);
  }

  private async archiveIdea(context: WorkspacePanelContext, ideaId: string | null): Promise<void> {
    if (ideaId === null) return;
    const config = await this.loadConfig(context);
    const idea = config.ideas.find((candidate) => candidate.id === ideaId);
    if (idea === undefined) return;

    config.ideas = config.ideas.filter((candidate) => candidate.id !== ideaId);
    config.archive.unshift(archiveIdea(idea));
    await this.saveConfig(context, config);
    this.status = { kind: "success", message: "Idea archived." };
    this.changed(context);
  }

  private async runIdea(context: WorkspacePanelContext, ideaId: string | null): Promise<void> {
    if (ideaId === null || this.runningIdeaId !== undefined) return;
    const config = await this.loadConfig(context);
    const idea = config.ideas.find((candidate) => candidate.id === ideaId);
    if (idea === undefined || idea.runSessionId !== undefined) return;

    this.runningIdeaId = idea.id;
    this.status = { kind: "info", message: "Starting a new Pi session…" };
    this.render();

    try {
      const session = await startIdeaSession(context, idea.id, idea.text);
      const runWorkspaceId = session.workspaceId ?? context.workspace.id;
      config.ideas = config.ideas.map((candidate) => candidate.id === idea.id ? withRunSession(candidate, session.id, runWorkspaceId) : candidate);
      await this.saveConfig(context, config);
      this.status = { kind: "success", message: "Session started. It is visible in the Sessions list." };
    } catch (error) {
      this.status = { kind: "error", message: error instanceof Error ? error.message : String(error) };
    } finally {
      this.runningIdeaId = undefined;
      this.changed(context);
    }
  }

  private async fixGitignore(context: WorkspacePanelContext): Promise<void> {
    try {
      const content = await readOptionalTextFile(context, gitignorePath);
      await writeWorkspaceFile(context, gitignorePath, appendPiWebGitignoreEntry(content));
      await this.loadGitignoreState(context);
      this.status = this.gitignore.kind === "ignored"
        ? { kind: "success", message: `${ideasDirectoryPath}/ added to ${gitignorePath}.` }
        : { kind: "error", message: `${gitignorePath} was written but ${ideasDirectoryPath}/ is still not ignored.` };
    } catch (error) {
      this.status = { kind: "error", message: `Failed to update ${gitignorePath}: ${errorMessage(error) ?? String(error)}` };
    }
    this.changed(context);
  }

  private async saveConfig(context: WorkspacePanelContext, config: IdeasConfig): Promise<void> {
    await writeWorkspaceFile(context, ideasConfigPath, `${JSON.stringify(config, null, 2)}\n`);
    configCache.set(ideasCacheKey(context), config);
  }

  private changed(context: WorkspacePanelContext): void {
    context.host.requestRender();
    window.dispatchEvent(new Event(ideasChangedEvent));
    this.render();
  }
}

function renderIdea(context: WorkspacePanelContext, idea: Idea, runningIdeaId: string | undefined): string {
  const sessionLink = idea.runSessionId === undefined ? "" : `<a href="${escapeAttr(sessionHref(context, idea))}">Session ${escapeHtml(idea.runSessionId.slice(0, 8))}</a>`;
  return `
    <article class="idea-card">
      <div class="idea-copy">
        <p>${escapeHtml(idea.text)}</p>
        <small>Added ${escapeHtml(formatDate(idea.createdAt))}</small>
        ${sessionLink}
      </div>
      <div class="idea-actions">${renderIdeaActions(idea, runningIdeaId)}</div>
    </article>
  `;
}

function renderIdeaActions(idea: Idea, runningIdeaId: string | undefined): string {
  if (idea.runSessionId !== undefined) return `<button data-done-idea="${escapeAttr(idea.id)}">Done</button>`;
  const disabled = runningIdeaId !== undefined;
  return `
    <button data-run-idea="${escapeAttr(idea.id)}" ${disabled ? "disabled" : ""}>${runningIdeaId === idea.id ? "Starting…" : "Run"}</button>
    <button class="secondary" data-delete-idea="${escapeAttr(idea.id)}" ${disabled ? "disabled" : ""}>Delete</button>
  `;
}

function sessionHref(context: WorkspacePanelContext, idea: Idea): string {
  const url = new URL(window.location.href);
  url.searchParams.set("project", context.workspace.projectId);
  url.searchParams.set("workspace", idea.runWorkspaceId ?? context.workspace.id);
  url.searchParams.set("session", idea.runSessionId ?? "");
  url.searchParams.set("view", "chat");
  return `${url.pathname}${url.search}${url.hash}`;
}

async function readOptionalTextFile(context: WorkspacePanelContext, path: string): Promise<string> {
  try {
    return (await context.files.readFile(path)).content;
  } catch (error) {
    if (errorMessage(error) === missingWorkspaceFileError) return "";
    throw error;
  }
}

function errorMessage(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}
