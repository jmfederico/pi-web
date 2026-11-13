import { html } from "lit";
import type { ApplicationPanelContext, ApplicationPanelContribution } from "../types";
import { managedMcpMessages, type ManagedMcpPanelContext } from "../../components/ManagedMcpPanel";

/** Never borrow a session from a different panel machine or workspace. */
export function managedMcpPanelContext(context: ApplicationPanelContext): ManagedMcpPanelContext {
  const { machine, workspace, state } = context;
  const matchingWorkspace = state.selectedMachine?.id === machine.id
    && workspace !== undefined && state.selectedWorkspace?.id === workspace.id
    && state.selectedWorkspace.projectId === workspace.projectId && state.selectedWorkspace.path === workspace.path;
  const session = matchingWorkspace && state.selectedSession?.cwd === workspace.path
    && state.selectedSession.archived !== true ? state.selectedSession : undefined;
  return {
    machineId: machine.id,
    ...(workspace === undefined ? {} : { cwd: workspace.path }),
    ...(session === undefined ? {} : { sessionId: session.id }),
  };
}

export function createCoreManagedMcpPanel(): ApplicationPanelContribution {
  return {
    id: "mcp", order: 10,
    get title() { return managedMcpMessages.t("title"); },
    render: (context) => {
      const target = managedMcpPanelContext(context);
      return html`<managed-mcp-panel .context=${target} .machineLabel=${context.machine.name}
        .sessionLabel=${target.sessionId === undefined ? "" : context.state.selectedSession?.name ?? target.sessionId}></managed-mcp-panel>`;
    },
  };
}
