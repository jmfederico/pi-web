import type { StylesheetIntegrationCapabilityV1, PluginCapability, ContentRendererInput, PiWebPlugin } from "@jmfederico/pi-web/plugin-api";
import { MermaidPreview } from "./MermaidPreview";
import { loadMermaidEngine, MermaidEngine } from "./mermaidEngine";
import { mermaidSyntaxHighlighter } from "./mermaidSyntax";
import { createMermaidContent } from "./mermaidLocalization";

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
  activate: ({ html, localization }) => {
    if (localization === undefined) throw new Error("The Mermaid plugin requires a localization-capable PI WEB host");
    const content = createMermaidContent(localization);
    // Portable machine copies share one tag but retain the active package's
    // source and asset loader, never the first machine's artifact URL.
    if (customElements.get("pi-web-mermaid-preview") === undefined) customElements.define("pi-web-mermaid-preview", MermaidPreview);
    let stylesheetIntegration: StylesheetIntegrationCapabilityV1 | undefined;
    // One engine per activation serves all of its diagrams and is released with it.
    const engine = new MermaidEngine(loadMermaidEngine);
    return {
      start: ({ capabilities }) => {
        stylesheetIntegration = capabilities.resolve(stylesheetIntegrationCapability);
      },
      dispose: () => { engine.dispose(); },
      contributions: {
        syntaxHighlighters: [mermaidSyntaxHighlighter],
        contentRenderers: [{
          id: "diagram",
          get title() { return content.messages.t("diagram"); },
          languages: ["mermaid"],
          fileExtensions: ["mmd", "mermaid"],
          render: (input: ContentRendererInput) => html`<pi-web-mermaid-preview .stylesheetIntegration=${stylesheetIntegration} .content=${content} .input=${input} .engine=${engine}></pi-web-mermaid-preview>`,
        }],
      },
    };
  },
} satisfies PiWebPlugin;

export default plugin;
