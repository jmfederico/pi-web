import { html } from "lit";
import type { ApplicationPanelContextV5, ApplicationPanelContributionV5, LocalizedMessages, PluginLocalization, StylesheetIntegrationCapabilityV1 } from "@jmfederico/pi-web/plugin-api";
import type { ManagedMcpPanelContext } from "./ManagedMcpPanel.js";
import type source from "./managedMcp.messages.js";

/** Never borrow a session from a different panel machine or workspace. */
export function managedMcpPanelContext(context: Pick<ApplicationPanelContextV5, "machine" | "workspace" | "state">): ManagedMcpPanelContext {
  const { machine, workspace, state } = context;
  const matchingWorkspace = state.selectedMachine?.id === machine.id
    && workspace !== undefined && state.selectedWorkspace?.id === workspace.id
    && state.selectedWorkspace.projectId === workspace.projectId && state.selectedWorkspace.path === workspace.path;
  const session = matchingWorkspace && state.selectedSession?.cwd === workspace.path
    && !state.selectedSession.archived && !state.selectedSession.pending ? state.selectedSession : undefined;
  return {
    machineId: machine.id,
    ...(workspace === undefined ? {} : { cwd: workspace.path, projectId: workspace.projectId, workspaceId: workspace.id }),
    ...(session === undefined ? {} : { sessionId: session.id }),
  };
}

export function createManagedMcpPanel(localization: PluginLocalization, messages: LocalizedMessages<typeof source>, getStyles: () => StylesheetIntegrationCapabilityV1): ApplicationPanelContributionV5 {
  return {
    id: "mcp", order: 10,
    get title() { return messages.t("title"); },
    render: (context) => {
      const target = managedMcpPanelContext(context);
      return html`<managed-mcp-panel .context=${target} .backend=${context.backend}
        .localization=${localization} .messages=${messages} .styles=${getStyles()} .machineLabel=${context.machine.name}
        .sessionLabel=${target.sessionId === undefined ? "" : context.state.selectedSession?.name ?? target.sessionId}></managed-mcp-panel>`;
    },
  };
}
