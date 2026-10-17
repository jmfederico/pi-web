import type { StylesheetIntegrationCapabilityV1, PluginCapability, PiWebPlugin } from "@jmfederico/pi-web/plugin-api";
import hljs from "highlight.js/lib/common";
import { HighlightedCode } from "./HighlightedCode";

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
  apiVersion: 4,
  name: "Code highlighting",
  requires: [stylesheetIntegrationCapability, { pluginId: "pi-web", id: "content-rendering", version: 1, parse: () => undefined }],
  activate: ({ html }) => {
    if (customElements.get("pi-web-highlighted-code") === undefined) customElements.define("pi-web-highlighted-code", HighlightedCode);
    let stylesheetIntegration: StylesheetIntegrationCapabilityV1 | undefined;
    return {
      start: ({ capabilities }) => {
        stylesheetIntegration = capabilities.resolve(stylesheetIntegrationCapability);
      },
      contributions: {
        // The renderer input is language-independent, so each grammar owns its
        // selector aliases and captures the language used to highlight it.
        contentRenderers: hljs.listLanguages().map((language) => ({
          id: language,
          // Some library aliases (e.g. c#) are not valid host selectors.
          languages: [language, ...(hljs.getLanguage(language)?.aliases ?? [])].filter((alias) => /^[a-z0-9][a-z0-9_+.-]*$/iu.test(alias)),
          renderMode: "automatic" as const,
          render: ({ text }) => html`<pi-web-highlighted-code .stylesheetIntegration=${stylesheetIntegration}
            .markup=${hljs.highlight(text, { language, ignoreIllegals: true }).value}
          ></pi-web-highlighted-code>`,
        })),
      },
    };
  },
} satisfies PiWebPlugin;

export default plugin;
