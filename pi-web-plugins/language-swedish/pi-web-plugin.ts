import type { PiWebPlugin } from "@jmfederico/pi-web/plugin-api";

// Register metadata eagerly; translation text loads only when Swedish is requested.
const namespaces = [
  "core.appFeedback",
  "core.commandResults",
  "core.appActions",
  "core.appShell",
  "core.askUser",
  "core.auth",
  "core.chatActions",
  "core.chatChrome",
  "core.chatTranscript",
  "core.content-renderer",
  "core.conversationLayout",
  "core.deprecatedAgentInputs",
  "core.banners",
  "core.extensionDialogs",
  "core.formattedText",
  "core.images",
  "core.machines",
  "core.pickers",
  "core.projectWorkspace",
  "core.promptEditor",
  "core.runtimeActivity",
  "core.sessionCleanup",
  "core.sessionNavigation",
  "core.sessionNotifications",
  "core.sessionTree",
  "core.settingsFeedback",
  "core.settingsFrame",
  "core.settingsGeneral",
  "core.settingsLocalization",
  "core.settingsMcp",
  "core.settingsPackages",
  "core.settingsPlugins",
  "core.settingsSessiond",
  "core.settingsShortcuts",
  "core.settingsTheme",
  "core.settingsDialog",
  "core.statusBar",
  "core.toolExecution",
  "core.pendingSession",
  "core.piWebStatus",
  "core.projectWorkspaceFeedback",
  "core.sessionFeedback",
  "core.pluginRecovery",
  "core.restart",
  "core.actions",
  "core.messageActions",
  "plugin:themes:themes",
  "core.routeFeedback",
  "core.serverNotices",
  "core.sessionTreeSummary",
  "core.workspaceRemoval",
  "plugin:code-highlight:renderer",
  "plugin:files:files",
  "plugin:files:runtime",
  "plugin:git:panel",
  "plugin:info:panel",
  "plugin:mermaid:preview",
  "plugin:pi-web.terminal:terminal",
  "plugin:updates:panel",
  "plugin:workspace-tasks:tasks",
  "plugin:relays:browser",
  "plugin:workflows:worktree"
];

const plugin = {
  apiVersion: 5,
  name: "Swedish / Svenska",
  activate: ({ localization }) => {
    if (localization === undefined) throw new Error("Swedish requires a localization-capable PI WEB host");
    for (const namespace of namespaces) {
      localization.registerCatalog({
        id: namespace,
        namespace,
        locale: "sv",
        load: async () => {
          const { default: catalogs } = await import("./catalogs.js");
          const catalog = catalogs[namespace];
          if (catalog === undefined) throw new Error(`Missing Swedish catalog: ${namespace}`);
          return catalog;
        },
      });
    }
    return { contributions: {} };
  },
} satisfies PiWebPlugin;

export default plugin;
