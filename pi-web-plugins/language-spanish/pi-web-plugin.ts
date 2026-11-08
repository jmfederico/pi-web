import type { PiWebPlugin } from "@jmfederico/pi-web/plugin-api";

// Keep namespace discovery separate from the lazily loaded translation text.
const namespaces = [
  "core.appActions",
  "core.appFeedback",
  "core.appShell",
  "core.auth",
  "core.chatActions",
  "core.chatChrome",
  "core.chatTranscript",
  "core.commandResults",
  "core.askUser",
  "core.content-renderer",
  "core.conversationLayout",
  "core.runtimeActivity",
  "core.sessionNavigation",
  "core.settingsDialog",
  "core.statusBar",
  "core.deprecatedAgentInputs",
  "core.banners",
  "core.settingsLocalization",
  "core.settingsMcp",
  "core.settingsPackages",
  "core.settingsPlugins",
  "core.settingsSessiond",
  "core.settingsFrame",
  "core.settingsTheme",
  "core.settingsShortcuts",
  "core.settingsFeedback",
  "core.settingsGeneral",
  "core.pendingSession",
  "core.piWebStatus",
  "core.projectWorkspaceFeedback",
  "core.sessionFeedback",
  "core.extensionDialogs",
  "core.formattedText",
  "core.images",
  "core.machines",
  "core.pickers",
  "core.pluginRecovery",
  "core.restart",
  "core.actions",
  "core.messageActions",
  "plugin:themes:themes",
  "core.projectWorkspace",
  "core.promptEditor",
  "core.routeFeedback",
  "core.serverNotices",
  "core.sessionCleanup",
  "core.sessionNotifications",
  "core.sessionTree",
  "core.sessionTreeSummary",
  "core.toolExecution",
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
  "plugin:workflows:worktree",
] as const;

const plugin = {
  apiVersion: 5,
  name: "Spanish / Español",
  activate({ localization }) {
    if (localization === undefined) {
      throw new Error("El plugin de español requiere un servidor de PI WEB compatible con la localización");
    }
    for (const namespace of namespaces) {
      localization.registerCatalog({
        id: namespace,
        namespace,
        locale: "es",
        async load() {
          const { default: catalogs } = await import("./catalogs.js");
          const catalog = catalogs[namespace];
          if (catalog === undefined) throw new Error(`Falta el catálogo de español: ${namespace}`);
          return catalog;
        },
      });
    }
    return { contributions: {} };
  },
} satisfies PiWebPlugin;

export default plugin;
