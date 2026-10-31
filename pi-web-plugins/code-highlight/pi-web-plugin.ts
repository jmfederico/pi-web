import type { ContentRenderRequest, StylesheetIntegrationCapabilityV1, SyntaxHighlightingCapability, PluginCapability, PiWebPlugin } from "@jmfederico/pi-web/plugin-api";
import hljs from "highlight.js/lib/common";
import { HighlightedCode } from "./HighlightedCode";
import { TokenHighlightedCode } from "./TokenHighlightedCode";
import definitions from "./codeHighlight.messages";

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

const syntaxHighlightingCapability: PluginCapability<SyntaxHighlightingCapability> = {
  pluginId: "pi-web", id: "syntax-highlighting", version: 1,
  parse(value) {
    if (!isSyntaxHighlighting(value)) throw new Error("Code highlighting requires syntax highlighting capability v1");
    return value;
  },
};

function isSyntaxHighlighting(value: unknown): value is SyntaxHighlightingCapability {
  return typeof value === "object" && value !== null
    && "supports" in value && typeof value.supports === "function"
    && "highlight" in value && typeof value.highlight === "function";
}

/** Language IDs and aliases take precedence over a filename's extension. */
function builtInLanguage(request: Pick<ContentRenderRequest, "language" | "filePath">): string | undefined {
  const language = request.language?.trim().split(/\s/u)[0]?.toLowerCase();
  const name = request.filePath?.split(/[\\/]/u).at(-1);
  const extension = name?.includes(".") === true ? name.split(".").at(-1)?.toLowerCase() : undefined;
  const candidate = language !== undefined && hljs.getLanguage(language) !== undefined ? language : extension;
  const grammar = candidate === undefined ? undefined : hljs.getLanguage(candidate);
  // Plain text and its aliases add neither syntax coloring nor a useful alternate view.
  return grammar !== undefined && grammar !== hljs.getLanguage("plaintext") ? candidate : undefined;
}

const plugin = {
  apiVersion: 5,
  name: "Code highlighting",
  requires: [stylesheetIntegrationCapability, syntaxHighlightingCapability, { pluginId: "pi-web", id: "content-rendering", version: 1, parse: () => undefined }],
  activate: ({ html, localization }) => {
    if (localization === undefined) throw new Error("The Code highlighting plugin requires a localization-capable PI WEB host");
    const messages = localization.registerMessages("renderer", definitions);
    if (customElements.get("pi-web-highlighted-code") === undefined) customElements.define("pi-web-highlighted-code", HighlightedCode);
    if (customElements.get("pi-web-token-highlighted-code") === undefined) customElements.define("pi-web-token-highlighted-code", TokenHighlightedCode);
    let stylesheetIntegration: StylesheetIntegrationCapabilityV1 | undefined;
    let syntaxHighlighting: SyntaxHighlightingCapability | undefined;
    return {
      start: ({ capabilities }) => {
        stylesheetIntegration = capabilities.resolve(stylesheetIntegrationCapability);
        syntaxHighlighting = capabilities.resolve(syntaxHighlightingCapability);
      },
      contributions: {
        contentRenderers: [{
          id: "highlighted",
          get title() { return messages.t("highlighted"); },
          renderMode: "automatic",
          supports: (request) => syntaxHighlighting?.supports(request) === true || builtInLanguage(request) !== undefined,
          render: (input) => {
            const request = {
              machineId: input.machineId ?? "local",
              ...(input.language === undefined ? {} : { language: input.language }),
              ...(input.filePath === undefined ? {} : { filePath: input.filePath }),
            };
            const highlighting = syntaxHighlighting;
            if (highlighting?.supports(request) === true) {
              return html`<pi-web-token-highlighted-code .stylesheetIntegration=${stylesheetIntegration} .input=${input}
                .highlight=${(text: string, signal: AbortSignal) => highlighting.highlight({ ...request, text, signal })}
              ></pi-web-token-highlighted-code>`;
            }
            const language = builtInLanguage(request);
            if (language === undefined) throw new Error("No syntax highlighter supports this source");
            return html`<pi-web-highlighted-code .stylesheetIntegration=${stylesheetIntegration}
              .markup=${hljs.highlight(input.text, { language, ignoreIllegals: true }).value}
            ></pi-web-highlighted-code>`;
          },
        }],
      },
    };
  },
} satisfies PiWebPlugin;

export default plugin;
