import { marked } from "marked";

const renderer = new marked.Renderer();

// Workspace file bytes are untrusted. Raw HTML must remain visible as text,
// never become nodes that the application can execute or load resources from.
renderer.html = ({ text }) => escapeHtml(text);
renderer.image = ({ text }) => escapeHtml(text === "" ? "[Image omitted]" : `[Image omitted: ${text}]`);
renderer.checkbox = ({ checked }) => checked ? "[x] " : "[ ] ";

const NO_ATTRIBUTES = new Set<string>();

// This is intentionally an allowlist of elements Marked may generate for the
// Markdown features we support. Resource-loading and active elements (including
// img, svg, iframe, input, audio, and video) are deliberately absent.
const GENERATED_MARKDOWN_ATTRIBUTES: Readonly<Record<string, ReadonlySet<string>>> = {
  a: new Set(["href", "title"]),
  blockquote: NO_ATTRIBUTES,
  br: NO_ATTRIBUTES,
  code: NO_ATTRIBUTES,
  del: NO_ATTRIBUTES,
  em: NO_ATTRIBUTES,
  h1: NO_ATTRIBUTES,
  h2: NO_ATTRIBUTES,
  h3: NO_ATTRIBUTES,
  h4: NO_ATTRIBUTES,
  h5: NO_ATTRIBUTES,
  h6: NO_ATTRIBUTES,
  hr: NO_ATTRIBUTES,
  li: NO_ATTRIBUTES,
  ol: new Set(["start"]),
  p: NO_ATTRIBUTES,
  pre: NO_ATTRIBUTES,
  strong: NO_ATTRIBUTES,
  table: NO_ATTRIBUTES,
  tbody: NO_ATTRIBUTES,
  td: new Set(["align"]),
  th: new Set(["align"]),
  thead: NO_ATTRIBUTES,
  tr: NO_ATTRIBUTES,
  ul: NO_ATTRIBUTES,
};

const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
const SAFE_TABLE_ALIGNMENTS = new Set(["left", "center", "right"]);
const TABLE_SCROLL_CLASS = "table-scroll";

/** Render untrusted workspace Markdown through the dedicated allowlist policy. */
export function renderWorkspaceMarkdownHtml(markdown: string): string {
  const generated = marked.parse(markdown, {
    async: false,
    breaks: true,
    gfm: true,
    renderer,
  });
  return sanitizeWorkspaceMarkdownHtml(generated);
}

/**
 * Sanitize HTML generated from workspace Markdown. This seam is exported so
 * the element, attribute, and URL policy can be contract-tested directly.
 */
export function sanitizeWorkspaceMarkdownHtml(generatedHtml: string): string {
  const template = document.createElement("template");
  template.innerHTML = generatedHtml;

  for (const element of [...template.content.querySelectorAll("*")]) {
    const tag = element.tagName.toLowerCase();
    const allowedAttributes = GENERATED_MARKDOWN_ATTRIBUTES[tag];
    if (allowedAttributes === undefined) {
      element.remove();
      continue;
    }

    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (!allowedAttributes.has(name) || !isAllowedAttributeValue(tag, name, attribute.value)) {
        element.removeAttribute(attribute.name);
      }
    }

    if (tag === "a") secureWorkspaceMarkdownLink(element);
  }

  wrapTablesInScrollRegions(template.content);
  return template.innerHTML;
}

function secureWorkspaceMarkdownLink(element: Element): void {
  if (!element.hasAttribute("href")) {
    element.removeAttribute("target");
    element.removeAttribute("rel");
    element.removeAttribute("referrerpolicy");
    return;
  }
  element.setAttribute("target", "_blank");
  element.setAttribute("rel", "noopener noreferrer");
  element.setAttribute("referrerpolicy", "no-referrer");
}

function isAllowedAttributeValue(tag: string, name: string, value: string): boolean {
  if (tag === "a" && name === "href") return isAllowedLink(value);
  if (tag === "ol" && name === "start") return /^-?\d+$/.test(value);
  if ((tag === "td" || tag === "th") && name === "align") return SAFE_TABLE_ALIGNMENTS.has(value.toLowerCase());
  return true;
}

function isAllowedLink(value: string): boolean {
  if (value === "" || hasAsciiControlCharacter(value)) return false;
  try {
    return SAFE_LINK_PROTOCOLS.has(new URL(value).protocol);
  } catch {
    return false;
  }
}

function hasAsciiControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

// Markdown tables stay readable on narrow panels without accepting any class,
// role, or tabindex values from the untrusted generated HTML.
function wrapTablesInScrollRegions(root: DocumentFragment): void {
  root.querySelectorAll("table").forEach((table) => {
    const wrapper = document.createElement("div");
    wrapper.className = TABLE_SCROLL_CLASS;
    wrapper.setAttribute("role", "region");
    wrapper.setAttribute("aria-label", "Table");
    wrapper.setAttribute("tabindex", "0");
    table.before(wrapper);
    wrapper.append(table);
  });
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
