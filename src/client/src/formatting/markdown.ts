import { Renderer } from "marked";
import { defaultMarkdownEngine, type MarkdownEngine, type MarkdownParseResult } from "./markdownEngine";
import messages from "../components/formattedText.messages";
import { DEFAULT_CODE_BLOCK_POLICY, type CodeBlockPolicy } from "./codeBlockPolicy";
import { replaceLocalMarkdownImages } from "./markdownImages";
import { workspaceFilePreviewUrl } from "../api/urls";
import { resolveAppUrl } from "../appUrl";
import { workspaceMarkdownFilePath, type MarkdownWorkspaceContext } from "./workspaceLinks";

const nativeCodeRenderer = new Renderer();

function markdownRenderer(codeBlocks: CodeBlockPolicy): Renderer {
  const renderer = new Renderer();
  renderer.html = ({ text }) => escapeHtml(text);
  renderer.code = (token) => {
    const block = codeBlocks.presentation === "code"
      ? nativeCodeRenderer.code(token)
      : `<div class="plain-code-block">${escapeHtml(token.text)}\n</div>\n`;
    // The literal, copy-free baseline has no frame or controls.
    if (codeBlocks.presentation === "plain" && !codeBlocks.copy) return block;
    const language = token.lang?.trim().split(/\s/u)[0] ?? "";
    const label = language === "" ? "" : `<span class="code-block-label">${escapeHtml(language)}</span>`;
    const copy = codeBlocks.copy
      ? `<button type="button" class="code-copy-button code-block-copy ui-button ui-button--icon ui-button--compact" title="${messages.copy.message}" aria-label="${messages.copy.message}"><span aria-hidden="true">⧉</span></button>`
      : "";
    // Generate the normal-flow header before mounting; never reparent source DOM.
    // English source attributes keep cached HTML locale-neutral; FormattedText
    // resolves owned labels on mount and on live language changes.
    const header = label === "" && copy === "" ? "" : `<div class="code-block-header" role="group" aria-label="${messages.controls.message}">${label}${copy}</div>`;
    return `<div class="code-block-wrapper code-block-frame">${header}${block}</div>\n`;
  };
  return renderer;
}

const MAX_MARKDOWN_CACHE_ENTRIES = 300;
const MAX_MARKDOWN_CACHE_CHARACTERS = 2_000_000;
const markdownCaches = new WeakMap<MarkdownEngine, { entries: Map<string, MarkdownParseResult>; characters: number }>();

export function toSafeMarkdownHtml(text: string, workspace?: MarkdownWorkspaceContext, imageIntentKey?: string, imagesEnabled = true, codeBlocks: CodeBlockPolicy = DEFAULT_CODE_BLOCK_POLICY): string {
  return parseChatMarkdown(text, workspace, imageIntentKey, imagesEnabled, codeBlocks).html;
}

/** Cache identity includes the active extension snapshot, never a mutable global parser. */
export function parseChatMarkdown(text: string, workspace?: MarkdownWorkspaceContext, imageIntentKey?: string, imagesEnabled = true, codeBlocks: CodeBlockPolicy = DEFAULT_CODE_BLOCK_POLICY, engine: MarkdownEngine = defaultMarkdownEngine): MarkdownParseResult {
  let cache = markdownCaches.get(engine);
  if (cache === undefined) {
    cache = { entries: new Map(), characters: 0 };
    markdownCaches.set(engine, cache);
  }
  const markdownHtmlCache = cache.entries;
  // Overflow is applied at the component boundary; preview policy does not alter HTML.
  // Only workspace links depend on the effective application base, not route/query changes.
  const key = JSON.stringify([text, imagesEnabled, codeBlocks.presentation, codeBlocks.copy, workspace === undefined ? null : [
    workspace.machineId, workspace.projectId, workspace.workspaceId, workspace.root, resolveAppUrl(""), imageIntentKey,
  ]]);
  const cached = markdownHtmlCache.get(key);
  if (cached !== undefined) return cached;
  const parsed = engine.parse(text, markdownRenderer(codeBlocks), (html) => sanitizeHtml(html, workspace, imageIntentKey, imagesEnabled));
  markdownHtmlCache.set(key, parsed);
  cache.characters += cachedCharacters(key, parsed);
  while (markdownHtmlCache.size > MAX_MARKDOWN_CACHE_ENTRIES || cache.characters > MAX_MARKDOWN_CACHE_CHARACTERS) {
    const oldest = markdownHtmlCache.entries().next().value;
    if (oldest === undefined) break;
    cache.characters -= cachedCharacters(...oldest);
    markdownHtmlCache.delete(oldest[0]);
  }
  return parsed;
}

function cachedCharacters(key: string, parsed: MarkdownParseResult): number {
  return key.length + parsed.html.length + parsed.codeBlocks.reduce((size, token) => size + token.raw.length + token.text.length, 0);
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

const TABLE_SCROLL_CLASS = "table-scroll";

function sanitizeHtml(html: string, workspace: MarkdownWorkspaceContext | undefined, imageIntentKey: string | undefined, imagesEnabled: boolean): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  if (workspace !== undefined) replaceLocalMarkdownImages(template.content, workspace, imageIntentKey);
  template.content.querySelectorAll("script, style, iframe, object, embed").forEach((node) => { node.remove(); });
  template.content.querySelectorAll("*").forEach((element) => {
    const href = element.tagName === "A" ? element.getAttribute("href") : null;
    if (href !== null && workspace !== undefined) {
      const path = workspaceMarkdownFilePath(href, workspace);
      if (path !== undefined) {
        element.setAttribute("href", workspaceFilePreviewUrl(workspace.projectId, workspace.workspaceId, path, { machineId: workspace.machineId, download: true }));
        element.setAttribute("data-workspace-file", path);
      }
    }
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on")) element.removeAttribute(attribute.name);
      if ((name === "href" || name === "src") && !isSafeUrl(attribute.value)) element.removeAttribute(attribute.name);
    }
    if (element.tagName === "A") {
      element.setAttribute("target", element.hasAttribute("data-workspace-file") ? "_self" : "_blank");
      element.setAttribute("rel", "noreferrer noopener");
    }
  });
  // Sources are assigned up front; native loading owns visibility and decoding.
  template.content.querySelectorAll("img").forEach((image) => {
    image.setAttribute("loading", "lazy");
    image.setAttribute("decoding", "async");
    if (!imagesEnabled) image.removeAttribute("src");
  });
  if (!imagesEnabled) template.content.querySelectorAll("pi-web-markdown-image").forEach((image) => {
    image.setAttribute("loading-disabled", "");
  });
  wrapTablesInScrollRegions(template.content);
  return template.innerHTML;
}

// Markdown tables stay at their natural width and scroll horizontally instead of
// being squeezed into the chat column, which is unreadable on narrow screens.
function wrapTablesInScrollRegions(root: DocumentFragment): void {
  root.querySelectorAll("table").forEach((table) => {
    if (table.parentElement?.classList.contains(TABLE_SCROLL_CLASS) === true) return;
    const wrapper = document.createElement("div");
    wrapper.className = TABLE_SCROLL_CLASS;
    wrapper.setAttribute("role", "region");
    wrapper.setAttribute("aria-label", messages.table.message);
    wrapper.setAttribute("tabindex", "0");
    table.before(wrapper);
    wrapper.append(table);
  });
}

function isSafeUrl(url: string): boolean {
  if (url.startsWith("#") || url.startsWith("/")) return true;
  try {
    return ["http:", "https:", "mailto:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}
