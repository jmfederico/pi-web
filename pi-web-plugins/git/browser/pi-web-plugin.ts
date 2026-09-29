import type { PiWebPlugin } from "@jmfederico/pi-web/plugin-api";
import { createGitBrowserContributions } from "./git-panel.js";

const plugin = {
  apiVersion: 4,
  name: "Git",
  activate: ({ pluginId, runtimePluginId, html, svg }) => ({
    contributions: createGitBrowserContributions(pluginId, runtimePluginId, html, svg),
  }),
} satisfies PiWebPlugin;

export default plugin;
