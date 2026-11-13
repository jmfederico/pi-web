import type { LocalizedMessages } from "@jmfederico/pi-web/plugin-api";
import { LocalizationService } from "../../../src/client/src/localization/service.js";
import { createPluginLocalization } from "../../../src/client/src/plugins/localization.js";
import { stylesheetIntegrationCapability } from "../../../src/client/src/plugins/styles.js";
import { defineManagedMcpPanel, ManagedMcpPanel } from "./ManagedMcpPanel.js";
import source from "./managedMcp.messages.js";

export function panelServices() {
  const lifetime = new AbortController();
  const service = new LocalizationService({ preferences: { language: "en", formatLocale: "en-US" } });
  const localization = createPluginLocalization(service, "mcp-manager", "mcp-manager", lifetime.signal);
  let messages: LocalizedMessages<typeof source> | undefined;
  const getMessages = () => messages ??= localization.registerMessages("panel", source);
  defineManagedMcpPanel();
  return {
    lifetime, localization, get messages() { return getMessages(); }, styles: stylesheetIntegrationCapability,
    createPanel() {
      const panel = new ManagedMcpPanel();
      panel.localization = localization;
      panel.messages = getMessages();
      panel.styles = stylesheetIntegrationCapability;
      return panel;
    },
  };
}
