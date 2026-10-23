import { html, type TemplateResult } from "lit";
import { html as staticHtml, unsafeStatic } from "lit/static-html.js";
import { ref } from "lit/directives/ref.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { marked, type Tokens } from "marked";
import type { ContentRenderingCapability, ContentRenderRequest, ContentMarkdownRenderRequest, ContentTextRenderRequest, PluginCapability } from "../../../plugin-api";
import type { ContentRendererChoice } from "../plugins/contentRenderers";
import "../components/ContentRendererHost";
import "../components/ContentRenderingBoundary";
import { renderIntentMemory } from "./renderIntentMemory";
import type { CodeBlockSourcePolicy } from "./codeBlockPolicy";

export const contentRenderingCapabilityToken: PluginCapability<ContentRenderingCapability> = {
  pluginId: "pi-web", id: "content-rendering", version: 1,
  parse: (value) => {
    if (!isContentRenderingCapability(value)) throw new Error("Content rendering capability v1 is unavailable");
    return value;
  },
};

function isContentRenderingCapability(value: unknown): value is ContentRenderingCapability {
  return typeof value === "object" && value !== null
    && "listRenderers" in value && typeof value.listRenderers === "function"
    && "renderText" in value && typeof value.renderText === "function"
    && "renderMarkdown" in value && typeof value.renderMarkdown === "function";
}

/** Limit plugin work independently of the surrounding Markdown/file size limit. */
export const MAX_CONTENT_RENDERER_LENGTH = 100_000;

type SelectRenderer = (request: ContentRenderRequest) => readonly ContentRendererChoice[];

function isCodeToken(token: Tokens.Generic | Tokens.Code): token is Tokens.Code {
  return token.type === "code" && typeof token.text === "string";
}

export function isClosedFence(token: Tokens.Code): boolean {
  const lines = token.raw.trimEnd().split("\n");
  const opening = /^ {0,3}(`{3,}|~{3,})/u.exec(lines[0] ?? "")?.[1];
  if (opening === undefined || lines.length < 2) return false;
  const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u.exec(lines.at(-1) ?? "")?.[1];
  return closing?.startsWith(opening) === true;
}

/** Host-only Chat seam; intent identity is never part of the plugin capability. */
export interface ChatContentRendering {
  renderMarkdown(request: ContentMarkdownRenderRequest, intentKey?: string, sourcePolicy?: CodeBlockSourcePolicy): TemplateResult;
}

type RenderingRevision = (request: ContentRenderRequest) => unknown;

export function createContentRenderingCapability(select: SelectRenderer, revision?: RenderingRevision): ContentRenderingCapability {
  return createContentRenderingService(select, revision).capability;
}

export function createContentRenderingService(select: SelectRenderer, revision?: RenderingRevision): ChatContentRendering & { capability: ContentRenderingCapability } {
  const selection = (request: ContentRenderRequest): readonly ContentRendererChoice[] => {
    if (request.truncated === true || request.text.length > MAX_CONTENT_RENDERER_LENGTH) return [];
    return select(request);
  };
  const host = (request: ContentRenderRequest, choices: readonly ContentRendererChoice[], externalControls = false, rendererId?: string, allowManualPreview = false, intentKey?: string, sourcePolicy?: CodeBlockSourcePolicy): TemplateResult => html`<pi-web-content-renderer
    .renderingRevision=${revision?.(request)} .codeBlocks=${sourcePolicy} .intentKey=${intentKey} .externalControls=${externalControls} .text=${request.text} .machineId=${request.machineId} .language=${request.language} .filePath=${request.filePath} .choices=${choices} .rendererId=${rendererId} .allowManualPreview=${allowManualPreview}
  ></pi-web-content-renderer>`;

  const renderMarkdown = (request: ContentMarkdownRenderRequest, identity?: string, sourcePolicy?: CodeBlockSourcePolicy): TemplateResult => {
      const template = document.createElement("template");
      template.innerHTML = request.toSafeHtml(request.text);
      const tokens: Tokens.Code[] = [];
      void marked.walkTokens(marked.lexer(request.text, { gfm: true, breaks: true }), (token) => {
        if (isCodeToken(token)) tokens.push(token);
      });
      const hosts = new Map<Node, TemplateResult>();
      const blockSelector = "pre, .plain-code-block";
      template.content.querySelectorAll(blockSelector).forEach((block, index) => {
        const token = tokens[index];
        if (token === undefined || (block.tagName === "PRE" && block.querySelector("code") === null)) return;
        const text = token.text;
        const selected = isClosedFence(token) ? selection({
          machineId: request.machineId, text,
          ...(token.lang === undefined ? {} : { language: token.lang }),
          ...(request.truncated === undefined ? {} : { truncated: request.truncated }),
        }) : [];
        const intentKey = identity === undefined ? undefined : JSON.stringify([request.machineId, identity, index]);
        // Validate even when no host will mount (e.g. its plugin was disabled).
        if (intentKey !== undefined) renderIntentMemory.read(intentKey, text, selected.map(({ id }) => id));
        if (selected.length > 0) {
          // Replace the whole source block, including its optional copy controls.
          const root = block.parentElement?.classList.contains("code-block-wrapper") === true ? block.parentElement : block;
          hosts.set(root, host({ machineId: request.machineId, text, ...(token.lang === undefined ? {} : { language: token.lang }) }, selected, false, undefined, request.allowManualPreview, intentKey, sourcePolicy));
        }
      });

      // Only sanitized ancestor tags are rebuilt as Lit templates; the rest stays
      // under the caller's HTML policy. Use this path even without preview matches:
      // stable child parts preserve source blocks, Copy feedback and completed
      // preview hosts while trailing prose streams.
      const renderNode = (node: Node): unknown => {
        const replacement = hosts.get(node);
        if (replacement !== undefined) return replacement;
        if (!(node instanceof Element)) return node.textContent;
        if (!node.querySelector(blockSelector)) return unsafeHTML(node.outerHTML);
        const tag = unsafeStatic(node.tagName.toLowerCase());
        const attributes = [...node.attributes].map(({ name, value }) => [name, value] as const);
        return staticHtml`<${tag} ${ref((element) => {
          if (element === undefined) return;
          for (const attribute of [...element.attributes]) element.removeAttribute(attribute.name);
          for (const [name, value] of attributes) element.setAttribute(name, value);
        })}>${[...node.childNodes].map(renderNode)}</${tag}>`;
      };
      return html`${[...template.content.childNodes].map(renderNode)}`;
  };
  const capability: ContentRenderingCapability = Object.freeze({
    listRenderers(request: ContentRenderRequest) {
      return selection(request).map(({ id, label, renderer }) => ({ id, label, renderMode: renderer.renderMode ?? "manual",
        ...(renderer.title === undefined ? {} : { title: renderer.title }),
      }));
    },
    renderText(request: ContentTextRenderRequest): TemplateResult | undefined {
      const selected = selection(request);
      const external = request.controls === "external";
      return selected.length === 0 ? undefined : host(request, selected, external, external ? request.rendererId : undefined, request.allowManualPreview);
    },
    // Plain templates cross Lit copies, but directive instances do not (notably
    // the dev host's unsafeHTML/ref inside the production-bundled Files plugin).
    renderMarkdown: (request: ContentMarkdownRenderRequest) => html`<pi-web-content-rendering-boundary
      style="display: contents" .source=${request.text} .renderContent=${() => renderMarkdown(request)}
    ></pi-web-content-rendering-boundary>`,
  });
  return { capability, renderMarkdown };
}
