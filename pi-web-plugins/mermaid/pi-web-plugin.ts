import type { StylesheetIntegrationCapabilityV1, PluginCapability, ContentRendererInput, PiWebPlugin } from "@jmfederico/pi-web/plugin-api";
import { loadMermaidEngine, MermaidPreview } from "./MermaidPreview";
import { mermaidSyntaxHighlighter } from "./mermaidSyntax";

const stylesheetIntegrationCapability: PluginCapability<StylesheetIntegrationCapabilityV1, 1> = {
  pluginId: "pi-web", id: "stylesheet-integration", version: 1,
  parse(value) {
    if (!isStylesheetIntegration(value)) {
      throw new Error("Stylesheet integration capability v1 requires registerRoot and createController");
    }
    return value;
  },
};

function isStylesheetIntegration(value: unknown): value is StylesheetIntegrationCapabilityV1 {
  return typeof value === "object" && value !== null
    && "registerRoot" in value && typeof value.registerRoot === "function"
    && "createController" in value && typeof value.createController === "function"
    && "subscribe" in value && typeof value.subscribe === "function";
}

const plugin = {
  apiVersion: 5,
  name: "Mermaid",
  // Fail explicitly on older API v4 hosts that cannot consume renderers.
  // This plugin contributes to the capability but does not call its methods.
  requires: [stylesheetIntegrationCapability, { pluginId: "pi-web", id: "content-rendering", version: 1, parse: () => undefined }],
  activate: ({ html }) => {
    // Portable machine copies share one tag but retain the active package's
    // source and asset loader, never the first machine's artifact URL.
    if (customElements.get("pi-web-mermaid-preview") === undefined) customElements.define("pi-web-mermaid-preview", MermaidPreview);
    let stylesheetIntegration: StylesheetIntegrationCapabilityV1 | undefined;
    return {
      start: ({ capabilities }) => {
        stylesheetIntegration = capabilities.resolve(stylesheetIntegrationCapability);
      },
      contributions: {
        syntaxHighlighters: [mermaidSyntaxHighlighter],
        contentRenderers: [{
          id: "diagram",
          title: "Diagram",
          languages: ["mermaid"],
          fileExtensions: ["mmd", "mermaid"],
          render: (input: ContentRendererInput) => html`<pi-web-mermaid-preview .stylesheetIntegration=${stylesheetIntegration} .input=${input} .loadEngine=${loadMermaidEngine}></pi-web-mermaid-preview>`,
        }],
      },
    };
  },
} satisfies PiWebPlugin;

export default plugin;
