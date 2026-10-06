import type { PluginRuntimeState, PluginSelectionSnapshot } from "../../../plugin-api";
import type { AppState } from "../appState";
import type { PiWebPlugin } from "./types";

/** Copy only documented selection; plugins never receive the selected SessionInfo object. */
export function publicPluginSelection(state: AppState): PluginSelectionSnapshot {
  const session = state.selectedSession;
  const machine = state.selectedMachine;
  const project = state.selectedProject;
  const workspace = state.selectedWorkspace;
  return {
    ...(machine === undefined ? {} : { selectedMachine: { id: machine.id, name: machine.name, kind: machine.kind } }),
    ...(project === undefined ? {} : { selectedProject: { id: project.id, name: project.name, path: project.path } }),
    ...(workspace === undefined ? {} : { selectedWorkspace: {
      id: workspace.id, projectId: workspace.projectId, path: workspace.path, label: workspace.label, isMain: workspace.isMain,
      ...(workspace.provider === undefined ? {} : { provider: workspace.provider }),
      ...(workspace.removal === undefined ? {} : { removal: workspace.removal }),
    } }),
    ...(session === undefined ? {} : { selectedSession: {
      id: session.id,
      cwd: session.cwd,
      ...(session.name === undefined ? {} : { name: session.name }),
      archived: session.archived === true,
      pending: "clientPendingStart" in session && session.clientPendingStart === true,
    } }),
  };
}

export function publicPluginState(state: AppState): PluginRuntimeState {
  return {
    ...publicPluginSelection(state),
    ...(state.workspaceTool === undefined ? {} : { workspaceTool: state.workspaceTool }),
    mainView: state.mainView,
    ...(state.piWebStatus === undefined ? {} : { piWebStatus: state.piWebStatus }),
  };
}

function publicContext<Context extends { state: AppState }>(context: Context): Context {
  // The loader represents opaque external callbacks with the internal contribution
  // types. Only those callbacks receive this narrowed, public state at runtime.
  return { ...context, state: publicPluginState(context.state) };
}

/** Adapt external callbacks at the host boundary while core plugins retain internal state. */
export function adaptPublicPlugin(plugin: PiWebPlugin): PiWebPlugin {
  return {
    ...plugin,
    async activate(context) {
      const activation = await plugin.activate(context);
      const { actions, applicationPanels, workspacePanels, workspaceLabels } = activation.contributions;
      return {
        ...activation,
        ...(activation.start === undefined ? {} : { start: activation.start.bind(activation) }),
        ...(activation.dispose === undefined ? {} : { dispose: activation.dispose.bind(activation) }),
        contributions: {
          ...activation.contributions,
          ...(actions === undefined ? {} : { actions: actions.map(({ enabled, disabledReason, run, ...action }) => ({
            ...action,
            ...(enabled === undefined ? {} : { enabled: (context) => enabled(publicContext(context)) }),
            ...(disabledReason === undefined ? {} : { disabledReason: (context) => disabledReason(publicContext(context)) }),
            run: (context) => run(publicContext(context)),
          })) }),
          ...(applicationPanels === undefined ? {} : { applicationPanels: applicationPanels.map(({ visible, badge, render, ...panel }) => ({
            ...panel,
            ...(visible === undefined ? {} : { visible: (context) => visible(publicContext(context)) }),
            ...(badge === undefined ? {} : { badge: (context) => badge(publicContext(context)) }),
            render: (context) => render(publicContext(context)),
          })) }),
          ...(workspacePanels === undefined ? {} : { workspacePanels: workspacePanels.map(({ visible, fileOpenQuery, badge, onInvalidate, render, ...panel }) => ({
            ...panel,
            ...(visible === undefined ? {} : { visible: (context) => visible(publicContext(context)) }),
            ...(fileOpenQuery === undefined ? {} : { fileOpenQuery: (context, path) => fileOpenQuery(publicContext(context), path) }),
            ...(badge === undefined ? {} : { badge: (context) => badge(publicContext(context)) }),
            ...(onInvalidate === undefined ? {} : { onInvalidate: (context, invalidation) => onInvalidate(publicContext(context), invalidation) }),
            render: (context) => render(publicContext(context)),
          })) }),
          ...(workspaceLabels === undefined ? {} : { workspaceLabels: workspaceLabels.map(({ visible, items, ...label }) => ({
            ...label,
            ...(visible === undefined ? {} : { visible: (context) => visible(publicContext(context)) }),
            items: (context) => items(publicContext(context)),
          })) }),
        },
      };
    },
  };
}
