import type { PiWebPluginV5, PluginCapability, StylesheetIntegrationCapabilityV1 } from "@jmfederico/pi-web/plugin-api";
import { parseRecord, PRIVATE_INPUT_TOOL, recordObject } from "../protocol.js";
import { definePrivateInputForm } from "./form.js";

const stylesCapability: PluginCapability<StylesheetIntegrationCapabilityV1> = {
  pluginId: "pi-web", id: "stylesheet-integration", version: 1,
  parse(value) {
    if (typeof value !== "object" || value === null
      || !("registerRoot" in value) || typeof value.registerRoot !== "function"
      || !("createController" in value) || typeof value.createController !== "function"
      || !("subscribe" in value) || typeof value.subscribe !== "function") throw new Error("Stylesheet integration unavailable");
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Public capability validated above.
    return value as StylesheetIntegrationCapabilityV1;
  },
};

export default {
  apiVersion: 5,
  name: "Private input",
  requires: [stylesCapability, {
    pluginId: "pi-web", id: "transcript-rendering", version: 1, parse: recordObject,
  }],
  activate({ html }) {
    definePrivateInputForm();
    let styles: StylesheetIntegrationCapabilityV1 | undefined;
    return {
      start({ capabilities }) { styles = capabilities.resolve(stylesCapability); },
      contributions: {
        transcriptRenderers: [{
          id: "private-input", target: "tool",
          resolve(toolName, next) {
            if (toolName !== PRIVATE_INPUT_TOOL) return next();
            return { placement: "standalone", render(input) {
              if (input.entry.status !== "success") return undefined;
              try { parseRecord(recordObject(input.entry.details)["privateInput"]); }
              catch { return undefined; }
              return html`<pi-web-private-input .context=${input} .stylesIntegration=${styles}></pi-web-private-input>`;
            } };
          },
        }],
      },
    };
  },
} satisfies PiWebPluginV5;
