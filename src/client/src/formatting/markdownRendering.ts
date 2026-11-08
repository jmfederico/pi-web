import { html } from "lit";
import type { MarkdownExtensionContribution, MarkdownRenderRequest, MarkdownRenderingCapability, PluginCapability } from "../../../plugin-api";
import type { ChatContentRendering } from "./contentRendering";
import { createDocumentMarkdownRenderer, sanitizeDocumentMarkdownHtml } from "./documentMarkdown";
import { createMarkdownEngine, defaultMarkdownEngine, type MarkdownEngine } from "./markdownEngine";
import "../components/ContentRenderingBoundary";

export const markdownRenderingCapabilityToken: PluginCapability<MarkdownRenderingCapability> = {
  pluginId: "pi-web", id: "markdown-rendering", version: 1,
  parse(value) {
    if (!isMarkdownRenderingCapability(value)) {
      throw new Error("Markdown rendering capability v1 is unavailable");
    }
    return value;
  },
};

function isMarkdownRenderingCapability(value: unknown): value is MarkdownRenderingCapability {
  return typeof value === "object" && value !== null && "render" in value && typeof value.render === "function";
}

/** Owns parser configuration and mounted-document invalidation, not application state. */
export class MarkdownRenderingService {
  private readonly views = new Map<string, { extensions: readonly MarkdownExtensionContribution[]; engine: MarkdownEngine }>();
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly select: (machineId: string) => readonly MarkdownExtensionContribution[],
    private readonly contentRendering: (machineId: string) => ChatContentRendering,
  ) {}

  getEngine(machineId: string): MarkdownEngine {
    const extensions = this.select(machineId);
    const previous = this.views.get(machineId);
    if (previous?.extensions.length === extensions.length
      && extensions.every((extension, index) => extension === previous.extensions[index])) return previous.engine;
    const engine = extensions.length === 0 ? defaultMarkdownEngine : createMarkdownEngine(extensions);
    this.views.set(machineId, { extensions, engine });
    return engine;
  }

  /** Only a changed eligible configuration invalidates a mounted document. */
  notifyChanged(): void {
    for (const listener of this.listeners) listener();
  }

  clear(): void {
    this.views.clear();
    this.notifyChanged();
  }

  private subscribe(machineId: string, listener: () => void): () => void {
    let previous = this.contentRendering(machineId);
    const check = (): void => {
      const current = this.contentRendering(machineId);
      if (current === previous) return;
      previous = current;
      listener();
    };
    this.listeners.add(check);
    return () => { this.listeners.delete(check); };
  }

  readonly capability: MarkdownRenderingCapability = Object.freeze({
    render: (request: MarkdownRenderRequest) => {
      // Capture the request, not a caller-owned mutable object. Heavy parsing stays
      // inside the visibility-gated host boundary, including after invalidation.
      const input = { ...request, ...(request.labels === undefined ? {} : { labels: { ...request.labels } }) };
      return html`<pi-web-content-rendering-boundary style="display: contents"
        .source=${input.text}
        .observe=${(listener: () => void) => this.subscribe(input.machineId, listener)}
        .renderContent=${() => {
          const rendering = this.contentRendering(input.machineId);
          const parsed = rendering.markdown.parse(input.text, createDocumentMarkdownRenderer(input.labels),
            (generated) => sanitizeDocumentMarkdownHtml(generated, input.labels));
          return rendering.renderMarkdown({ ...input, parsed, toSafeHtml: () => parsed.html });
        }}
      ></pi-web-content-rendering-boundary>`;
    },
  });
}
