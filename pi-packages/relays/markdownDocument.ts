import { marked } from "./vendor/marked.esm.js";

// Raw HTML inside relay documents is escaped before sanitizing, so the
// sanitizer only ever sees marked-generated markup. This mirrors the safety
// rules of the app's renderer in src/client/src/formatting/markdown.ts; the
// plugin cannot import that module, so the rules are duplicated here.
const renderer = new marked.Renderer();
renderer.html = ({ text }) => escapeHtml(text);

const MAX_MARKDOWN_CACHE_ENTRIES = 300;
const markdownHtmlCache = new Map<string, string>();

/** Relay documents ending in .md render as markdown; everything else stays preformatted text. */
export function isMarkdownDocumentPath(path: string): boolean {
  return path.toLowerCase().endsWith(".md");
}

/** Render one relay markdown document into sanitized HTML safe to interpolate into innerHTML. */
export function renderRelayDocumentHtml(source: string): string {
  const cached = markdownHtmlCache.get(source);
  if (cached !== undefined) return cached;
  const html = marked.parse(source, { async: false, breaks: true, gfm: true, renderer });
  const safeHtml = sanitizeHtml(html);
  markdownHtmlCache.set(source, safeHtml);
  if (markdownHtmlCache.size > MAX_MARKDOWN_CACHE_ENTRIES) {
    const oldest = markdownHtmlCache.keys().next().value;
    if (oldest !== undefined) markdownHtmlCache.delete(oldest);
  }
  return safeHtml;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

const TABLE_SCROLL_CLASS = "table-scroll";

function sanitizeHtml(html: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  template.content.querySelectorAll("script, style, iframe, object, embed").forEach((node) => { node.remove(); });
  template.content.querySelectorAll("*").forEach((element) => {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on")) element.removeAttribute(attribute.name);
      if ((name === "href" || name === "src") && !isSafeUrl(attribute.value)) element.removeAttribute(attribute.name);
    }
    if (element.tagName === "A") {
      element.setAttribute("target", "_blank");
      element.setAttribute("rel", "noreferrer noopener");
    }
  });
  wrapTablesInScrollRegions(template.content);
  return template.innerHTML;
}

// Tables keep their natural width and scroll horizontally instead of being
// squeezed into the panel, which is unreadable on narrow screens.
function wrapTablesInScrollRegions(root: DocumentFragment): void {
  root.querySelectorAll("table").forEach((table) => {
    if (table.parentElement?.classList.contains(TABLE_SCROLL_CLASS) === true) return;
    const wrapper = document.createElement("div");
    wrapper.className = TABLE_SCROLL_CLASS;
    wrapper.setAttribute("role", "region");
    wrapper.setAttribute("aria-label", "Table");
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
