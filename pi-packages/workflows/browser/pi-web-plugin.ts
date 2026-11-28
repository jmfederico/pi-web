import type { PiWebPluginV5, PluginActivationContextV5, PluginCapability, PluginRuntimeContextV5, StylesheetIntegrationCapabilityV1 } from "@jmfederico/pi-web/plugin-api";
import { openWorktreeDialog, type WorktreeMode } from "./worktreeDialog.js";
import definitions from "./workflows.messages.js";

const stylesCapability: PluginCapability<StylesheetIntegrationCapabilityV1, 1> = {
  pluginId: "pi-web", id: "stylesheet-integration", version: 1,
  parse(value) {
    if (!isStylesheetIntegration(value)) throw new Error("Invalid stylesheet integration capability v1");
    return value;
  },
};

function isStylesheetIntegration(value: unknown): value is StylesheetIntegrationCapabilityV1 {
  return typeof value === "object" && value !== null
    && "registerRoot" in value && typeof value.registerRoot === "function"
    && "createController" in value && typeof value.createController === "function"
    && "subscribe" in value && typeof value.subscribe === "function";
}

type WorktreeContext = Pick<PluginRuntimeContextV5, "state" | "backend" | "catalog" | "navigate" | "projects" | "refreshAppData" | "refreshProjectWorkspaces">;
function canCreateWorktree({ state, backend }: Pick<WorktreeContext, "state" | "backend">): boolean {
  return state.selectedProject !== undefined && backend !== undefined;
}

const plugin = {
  apiVersion: 5,
  name: "Workflows",
  requires: [stylesCapability],
  activate: ({ lifetimeSignal, selection, localization }: Pick<PluginActivationContextV5, "lifetimeSignal" | "selection" | "localization">) => {
    if (!localization) throw new Error("The Workflows plugin requires a localization-capable PI WEB host");
    const messages = localization.registerMessages("worktree", definitions);
    let styles: StylesheetIntegrationCapabilityV1 | undefined;
    let closeDialog: (() => void) | undefined;
    let unsubscribe: (() => void) | undefined;
    const close = () => { closeDialog?.(); closeDialog = undefined; unsubscribe?.(); unsubscribe = undefined; };
    lifetimeSignal.addEventListener("abort", close, { once: true });
    const open = (context: WorktreeContext, mode: WorktreeMode) => {
      const project = context.state.selectedProject;
      if (!project || !context.backend || lifetimeSignal.aborted) return;
      if (!styles) throw new Error("Workflows stylesheet integration not started");
      close();
      const peer = context.backend.forScope({ kind: "project", projectId: project.id });
      closeDialog = openWorktreeDialog(context, peer, mode, localization, messages, styles, () => { closeDialog = undefined; unsubscribe?.(); unsubscribe = undefined; });
      unsubscribe = selection?.subscribe((snapshot) => {
        if (snapshot.selectedProject?.id !== project.id || snapshot.selectedMachine?.id !== context.catalog.machineId) close();
      });
    };
    const common = { get group() { return messages.t("group"); }, enabled: canCreateWorktree, disabledReason: () => messages.t("disabled") };
    return {
      start({ capabilities }) { styles = capabilities.resolve(stylesCapability); },
      contributions: {
        actions: [{
          id: "worktree.create",
          get title() { return messages.t("agentAction"); },
          get description() { return messages.t("agentDescription"); },
          get group() { return common.group; },
          enabled: common.enabled,
          disabledReason: common.disabledReason,
          run: (context: WorktreeContext) => { open(context, "agent"); },
        }, {
          id: "worktree.set-path",
          placement: "workspace-create",
          get title() { return messages.t("manualAction"); },
          get description() { return messages.t("manualDescription"); },
          get group() { return common.group; },
          enabled: common.enabled,
          disabledReason: common.disabledReason,
          run: (context: WorktreeContext) => { open(context, "manual"); },
        }],
      },
      dispose() { close(); lifetimeSignal.removeEventListener("abort", close); },
    };
  },
} satisfies PiWebPluginV5;

export default plugin;
