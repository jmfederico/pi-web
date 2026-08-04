import type { PiWebPlugin } from "@jmfederico/pi-web/plugin-api";
import { createGitBrowserContributions } from "./git-panel.js";

const plugin: PiWebPlugin = {
  apiVersion: 1,
  name: "Git",
  activate: ({ pluginId, html, svg }) => ({
    contributions: createGitBrowserContributions(pluginId, html, svg),
  }),
};

export default plugin;
