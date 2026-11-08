import { parse, TYPE, type MessageFormatElement } from "@formatjs/icu-messageformat-parser";
import { html, svg } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { MessageDefinitions } from "../src/shared/localization.js";
import { validateCatalog } from "../src/client/src/localization/catalog.js";
import { LocalizationService } from "../src/client/src/localization/service.js";
import { createPluginLocalization } from "../src/client/src/plugins/localization.js";
import authDefinitions from "../src/client/src/components/auth.messages.js";
import fileDefinitions from "./files/files.messages.js";
import spanish from "./language-spanish/pi-web-plugin.js";
import swedish from "./language-swedish/pi-web-plugin.js";
import spanishManifest from "./language-spanish/package.json";
import swedishManifest from "./language-swedish/package.json";

// Import source-only modules, not their browser registration side effects. Namespace
// addresses below follow registerMessages wiring, not message-module filenames.
const sourceModules = import.meta.glob<{ default: MessageDefinitions }>([
  "../src/client/src/**/*.messages.ts",
  "./**/*.messages.ts",
  "../pi-packages/relays/**/*.messages.ts",
  "../pi-packages/workflows/**/*.messages.ts",
], { eager: true });

const sourcePaths: Record<string, string> = {
  "core.actions": "../src/client/src/plugins/core/actions.messages.ts",
  "core.messageActions": "../src/client/src/plugins/core/messageActions.messages.ts",
  "core.appFeedback": "../src/client/src/appFeedback.messages.ts",
  "core.appShell": "../src/client/src/components/appShell/appShell.messages.ts",
  "core.promptEditor": "../src/client/src/components/promptEditor.messages.ts",
  "core.projectWorkspace": "../src/client/src/components/projectWorkspace.messages.ts",
  "core.images": "../src/client/src/components/image.messages.ts",
  "core.pluginRecovery": "../src/client/src/pluginRecovery.messages.ts",
  "core.restart": "../src/client/src/restart.messages.ts",
  "core.chatChrome": "../src/client/src/components/chatChrome.messages.ts",
  "core.formattedText": "../src/client/src/components/formattedText.messages.ts",
  "core.sessionNotifications": "../src/client/src/components/sessionNotifications.messages.ts",
  "core.auth": "../src/client/src/components/auth.messages.ts",
  "core.appActions": "../src/client/src/components/appActions.messages.ts",
  "core.sessionCleanup": "../src/client/src/components/sessionCleanup.messages.ts",
  "core.pendingSession": "../src/client/src/controllers/pendingSession.messages.ts",
  "core.projectWorkspaceFeedback": "../src/client/src/controllers/projectWorkspace.messages.ts",
  "core.piWebStatus": "../src/client/src/controllers/piWebStatus.messages.ts",
  "core.sessionFeedback": "../src/client/src/controllers/sessionFeedback.messages.ts",
  "core.sessionTreeSummary": "../src/client/src/sessionTreeSummary.messages.ts",
  "core.machines": "../src/client/src/components/machine.messages.ts",
  "core.routeFeedback": "../src/client/src/routeFeedback.messages.ts",
  "core.workspaceRemoval": "../src/client/src/workspaceRemoval.messages.ts",
  "core.chatTranscript": "../src/client/src/components/chatTranscript.messages.ts",
  "core.extensionDialogs": "../src/client/src/components/extensionDialog.messages.ts",
  "core.chatActions": "../src/client/src/components/chatActions.messages.ts",
  "core.commandResults": "../src/client/src/commandResults.messages.ts",
  "core.pickers": "../src/client/src/components/picker.messages.ts",
  "core.toolExecution": "../src/client/src/components/toolExecution.messages.ts",
  "core.deprecatedAgentInputs": "../src/client/src/components/deprecatedAgentInputs.messages.ts",
  "core.settingsDialog": "../src/client/src/components/settingsDialog.messages.ts",
  "core.banners": "../src/client/src/components/errorBanner.messages.ts",
  "core.sessionNavigation": "../src/client/src/components/sessionNavigation.messages.ts",
  "core.conversationLayout": "../src/client/src/components/conversationLayout.messages.ts",
  "core.runtimeActivity": "../src/client/src/components/runtimeActivity.messages.ts",
  "core.sessionTree": "../src/client/src/components/sessionTree.messages.ts",
  "core.serverNotices": "../src/client/src/serverNotices.messages.ts",
  "core.statusBar": "../src/client/src/components/statusBar.messages.ts",
  "core.askUser": "../src/client/src/components/askUser.messages.ts",
  "core.content-renderer": "../src/client/src/components/contentRenderer.messages.ts",
  "core.settingsLocalization": "../src/client/src/components/settings/settingsLocalization.messages.ts",
  "core.settingsPlugins": "../src/client/src/components/settings/settingsPlugins.messages.ts",
  "core.settingsPackages": "../src/client/src/components/settings/settingsPackages.messages.ts",
  "core.settingsFrame": "../src/client/src/components/settings/settingsFrame.messages.ts",
  "core.settingsTheme": "../src/client/src/components/settings/settingsTheme.messages.ts",
  "core.settingsShortcuts": "../src/client/src/components/settings/settingsShortcuts.messages.ts",
  "core.settingsSessiond": "../src/client/src/components/settings/settingsSessiond.messages.ts",
  "core.settingsMcp": "../src/client/src/components/settings/settingsMcp.messages.ts",
  "core.settingsFeedback": "../src/client/src/components/settings/settingsFeedback.messages.ts",
  "core.settingsGeneral": "../src/client/src/components/settings/settingsGeneral.messages.ts",
  // PiWebApp registers the built-in theme plugin with source ID "themes".
  "plugin:themes:themes": "../src/client/src/plugins/themes/themes.messages.ts",
  "plugin:files:files": "./files/files.messages.ts",
  "plugin:files:runtime": "./files/filesRuntime.messages.ts",
  "plugin:git:panel": "./git/browser/git.messages.ts",
  "plugin:code-highlight:renderer": "./code-highlight/codeHighlight.messages.ts",
  "plugin:workspace-tasks:tasks": "./workspace-tasks/tasks.messages.ts",
  "plugin:updates:panel": "./updates/updates.messages.ts",
  "plugin:mermaid:preview": "./mermaid/mermaid.messages.ts",
  "plugin:info:panel": "./info/info.messages.ts",
  "plugin:pi-web.terminal:terminal": "./terminal/terminal.messages.ts",
  "plugin:relays:browser": "../pi-packages/relays/relays.messages.ts",
  "plugin:workflows:worktree": "../pi-packages/workflows/browser/workflows.messages.ts",
};

function definitionsFor(namespace: string): MessageDefinitions {
  const path = sourcePaths[namespace];
  const source = path === undefined ? undefined : sourceModules[path];
  if (!source) throw new Error(`Unknown language-pack namespace or missing source: ${namespace} (${path ?? "unmapped"})`);
  return source.default;
}

// Named selections and exact-count branches carry meaning (for example whether
// a cleanup archives, deletes, or does neither); placeholder checks alone miss them.
function semanticBranches(elements: MessageFormatElement[], result: string[] = []): string[] {
  for (const element of elements) {
    if (element.type === TYPE.select || element.type === TYPE.plural) {
      const keys = Object.keys(element.options).filter((key) => element.type === TYPE.select || key.startsWith("=")).sort();
      if (keys.length > 0) result.push(`${element.value}:${keys.join(",")}`);
      for (const option of Object.values(element.options)) semanticBranches(option.value, result);
    } else if (element.type === TYPE.tag) {
      semanticBranches(element.children, result);
    }
  }
  return result.sort();
}

const packs = [
  { id: "language-spanish", locale: "es", regional: "es-MX", plugin: spanish, manifest: spanishManifest,
    catalogs: () => import("./language-spanish/catalogs.js").then((module) => module.default) },
  { id: "language-swedish", locale: "sv", regional: "sv-FI", plugin: swedish, manifest: swedishManifest,
    catalogs: () => import("./language-swedish/catalogs.js").then((module) => module.default) },
];

describe.each(packs)("$id", (pack) => {
  it("ships opt-in catalogs with known namespaces, keys and compatible ICU for every entry", async () => {
    expect(pack.manifest.piWeb.plugins.find((plugin) => plugin.id === pack.id)?.defaultEnabled).toBe(false);
    const catalogs = await pack.catalogs();
    expect(Object.keys(catalogs).length).toBeGreaterThan(0);
    const errors = Object.entries(catalogs).flatMap(([namespace, catalog]) => {
      const definitions = definitionsFor(namespace);
      expect(Object.keys(catalog).length, namespace).toBeGreaterThan(0);
      return validateCatalog(definitions, catalog).map((error) => `${namespace}: ${error}`);
    });
    // Partial translations are intentional: future source keys may fall back to English.
    expect(errors).toEqual([]);
    for (const [namespace, catalog] of Object.entries(catalogs)) {
      const definitions = definitionsFor(namespace);
      for (const [key, translated] of Object.entries(catalog)) {
        const source = definitions[key];
        if (source === undefined) throw new Error(`Unknown source: ${namespace}.${key}`);
        expect(semanticBranches(parse(translated)), `${namespace}.${key}`).toEqual(semanticBranches(parse(source.message)));
      }
    }
  });

  it("activates regional fallback and removes catalogs on lifetime abort, restoring English", async () => {
    const diagnostic = vi.fn();
    const service = new LocalizationService({ diagnostic });
    const auth = service.registerMessages("core.auth", authDefinitions);
    const files = service.registerMessages("plugin:files:files", fileDefinitions);
    const lifetime = new AbortController();
    const localization = createPluginLocalization(service, pack.id, `remote-${pack.id}`, lifetime.signal);
    const registerCatalog = vi.spyOn(service, "registerCatalog");
    expect(service.availableLanguages).toEqual(["en"]);
    expect(auth.t("cancel")).toBe("Cancel");
    expect(files.t("cancel")).toBe("Cancel");
    try {
      pack.plugin.activate({
        apiVersion: 5, pluginId: pack.id, runtimePluginId: `remote-${pack.id}`,
        html, svg, signal: new AbortController().signal, lifetimeSignal: lifetime.signal, localization,
      });
      await service.ready;
      // Availability is registered even while English is selected.
      expect(service.availableLanguages).toContain(pack.locale);
      expect(auth.t("cancel")).toBe("Cancel");
      expect(files.t("cancel")).toBe("Cancel");
      await service.setPreferences({ language: pack.regional, formatLocale: "en-US" });
      await service.ready;
      const catalogs = await pack.catalogs();
      expect(registerCatalog.mock.calls.map(([catalog]) => catalog.namespace).sort()).toEqual(Object.keys(catalogs).sort());
      expect(registerCatalog.mock.calls.every(([catalog]) => catalog.locale === pack.locale)).toBe(true);
      expect(catalogs["core.auth"]?.["cancel"]).toBeTruthy();
      expect(catalogs["plugin:files:files"]?.["cancel"]).toBeTruthy();
      expect(auth.t("cancel")).toBe(catalogs["core.auth"]?.["cancel"]);
      expect(files.t("cancel")).toBe(catalogs["plugin:files:files"]?.["cancel"]);
      expect(auth.t("cancel")).not.toBe("Cancel");
      expect(service.language).toBe(pack.locale);
      expect(service.preferences.formatLocale).toBe("en-US");

      lifetime.abort();
      await service.ready;
      expect(service.availableLanguages).toEqual(["en"]);
      expect(service.language).toBe("en");
      expect(auth.t("cancel")).toBe("Cancel");
      expect(files.t("cancel")).toBe("Cancel");
      expect(service.preferences.language).toBe(pack.regional);
      expect(diagnostic).not.toHaveBeenCalled();
    } finally {
      lifetime.abort();
      await service.ready;
    }
  });
});
