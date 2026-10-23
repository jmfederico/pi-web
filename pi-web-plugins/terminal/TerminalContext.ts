import type { ApplicationPanelContextV5, PluginMachine, PluginPeer, Workspace, WorkspaceHost, WorkspacePanelNavigationV1 } from "@jmfederico/pi-web/plugin-api";

export interface WorkspaceTerminalBinding {
  readonly scope: "workspace";
  readonly workspace: Workspace;
  readonly peer: PluginPeer;
  readonly navigation?: WorkspacePanelNavigationV1;
}

export interface MaintenanceTerminalBinding {
  readonly scope: "maintenance";
  readonly peer: PluginPeer;
}

export type TerminalBinding = WorkspaceTerminalBinding | MaintenanceTerminalBinding;
export type TerminalScope = TerminalBinding["scope"];

/** Each authority is complete and explicit; the view never infers it from peer identity. */
export interface TerminalContext {
  readonly machine: PluginMachine;
  readonly host: WorkspaceHost;
  readonly workspace?: WorkspaceTerminalBinding;
  readonly maintenance?: MaintenanceTerminalBinding;
}

export function applicationTerminalContext(context: Pick<ApplicationPanelContextV5, "machine" | "host" | "workspace" | "navigation" | "backend">): TerminalContext {
  const { workspace, backend, navigation } = context;
  return {
    machine: context.machine,
    host: context.host,
    ...(backend === undefined ? {} : {
      maintenance: { scope: "maintenance" as const, peer: backend.forScope({ kind: "machine" }) },
      ...(workspace === undefined ? {} : {
        workspace: {
          scope: "workspace" as const,
          workspace,
          peer: backend.forScope({ kind: "workspace", projectId: workspace.projectId, workspaceId: workspace.id }),
          ...(navigation === undefined ? {} : { navigation }),
        },
      }),
    }),
  };
}

export function terminalBinding(context: TerminalContext, scope: TerminalScope): TerminalBinding {
  const binding = scope === "maintenance" ? context.maintenance : context.workspace;
  if (binding === undefined) throw new Error(`Required Terminal ${scope} binding is unavailable`);
  return binding;
}

export function terminalBindings(context: TerminalContext): TerminalBinding[] {
  const bindings: TerminalBinding[] = [];
  if (context.workspace !== undefined) bindings.push(context.workspace);
  if (context.maintenance !== undefined) bindings.push(context.maintenance);
  return bindings;
}
