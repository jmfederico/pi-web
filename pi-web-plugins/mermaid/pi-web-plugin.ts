import type { ContentRendererInput, PiWebPlugin } from "@jmfederico/pi-web/plugin-api";
import { loadMermaidEngine, MermaidPreview } from "./MermaidPreview";

const plugin: PiWebPlugin = {
  apiVersion: 4,
  name: "Mermaid",
  // Fail explicitly on older API v4 hosts that cannot consume renderers.
  // This plugin contributes to the capability but does not call its methods.
  requires: [{ pluginId: "pi-web", id: "content-rendering", version: 1, parse: () => undefined }],
  activate: ({ html }) => {
    // Portable machine copies share one tag but retain the active package's
    // source and asset loader, never the first machine's artifact URL.
    if (customElements.get("pi-web-mermaid-preview") === undefined) customElements.define("pi-web-mermaid-preview", MermaidPreview);
    return {
      contributions: {
        contentRenderers: [{
          id: "diagram",
          languages: ["mermaid"],
          fileExtensions: ["mmd", "mermaid"],
          render: (input: ContentRendererInput) => html`<pi-web-mermaid-preview .input=${input} .loadEngine=${loadMermaidEngine}></pi-web-mermaid-preview>`,
        }],
      },
    };
  },
};

export default plugin;
