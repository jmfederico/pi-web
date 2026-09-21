import type { PluginActivationContext } from "@jmfederico/pi-web/plugin-api";
import { Lexer, type MarkedToken, type Token } from "marked";

type Html = PluginActivationContext["html"];

// The private lexer has no extensions. Narrow away Marked's open-ended Generic token type.
function isBuiltinToken(token: Token): token is MarkedToken {
  return ["space", "def", "heading", "paragraph", "text", "escape", "html", "strong", "em", "del", "codespan", "code", "blockquote", "br", "hr", "list", "list_item", "checkbox", "link", "image", "table"].includes(token.type);
}

function safeLink(href: string): string | undefined {
  // No relative URLs: translations must not navigate within the host application.
  try {
    const url = new URL(href);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** Render only known Markdown constructs. Text (including raw HTML) always stays in Lit text bindings. */
export function renderCaptainMarkdown(html: Html, markdown: string): unknown {
  const renderTokens = (tokens: Token[]): unknown[] => tokens.map(renderToken);
  function renderToken(input: Token): unknown {
    if (!isBuiltinToken(input)) return input.raw;
    const token = input;
    switch (token.type) {
      case "space": case "def": return null;
      case "heading": {
        const content = renderTokens(token.tokens);
        switch (token.depth) {
          case 1: return html`<h1>${content}</h1>`;
          case 2: return html`<h2>${content}</h2>`;
          case 3: return html`<h3>${content}</h3>`;
          case 4: return html`<h4>${content}</h4>`;
          case 5: return html`<h5>${content}</h5>`;
          default: return html`<h6>${content}</h6>`;
        }
      }
      case "paragraph": return html`<p>${renderTokens(token.tokens)}</p>`;
      case "text": return token.tokens ? renderTokens(token.tokens) : token.text;
      case "escape": return token.text;
      case "html": return token.raw;
      case "strong": return html`<strong>${renderTokens(token.tokens)}</strong>`;
      case "em": return html`<em>${renderTokens(token.tokens)}</em>`;
      case "del": return html`<del>${renderTokens(token.tokens)}</del>`;
      case "codespan": return html`<code>${token.text}</code>`;
      case "code": return html`<pre><code>${token.text}</code></pre>`;
      case "blockquote": return html`<blockquote>${renderTokens(token.tokens)}</blockquote>`;
      case "br": return html`<br>`;
      case "hr": return html`<hr>`;
      case "list": return token.ordered
        ? html`<ol start=${token.start}>${renderTokens(token.items)}</ol>`
        : html`<ul>${renderTokens(token.items)}</ul>`;
      case "list_item": return html`<li>${renderTokens(token.tokens)}</li>`;
      case "checkbox": return html`<input type="checkbox" disabled ?checked=${token.checked} aria-label="Task completed">`;
      case "link": {
        const href = safeLink(token.href);
        const label = renderTokens(token.tokens);
        return href !== undefined ? html`<a href=${href} target="_blank" rel="noreferrer noopener">${label}</a>` : label;
      }
      // Keep the description, but never create an image or load a remote resource.
      case "image": return token.text;
      case "table": return html`<div class="captain-table-scroll"><table><thead><tr>${token.header.map((cell) => html`<th scope="col">${renderTokens(cell.tokens)}</th>`)}</tr></thead><tbody>${token.rows.map((row) => html`<tr>${row.map((cell) => html`<td>${renderTokens(cell.tokens)}</td>`)}</tr>`)}</tbody></table></div>`;
      default: return input.raw;
    }
  }
  return renderTokens(new Lexer({ gfm: true }).lex(markdown));
}
