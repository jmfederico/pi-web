import type { PluginRuntimeState } from "../../../plugin-api";
import type { AppState } from "../appState";
import type { PiWebPlugin } from "./types";

/** Copy only documented state; plugins never receive the selected SessionInfo object. */
export function publicPluginState(state: AppState): PluginRuntimeState {
  const session = state.selectedSession;
  const machine = state.selectedMachine;
  return {
    ...(machine === undefined ? {} : { selectedMachine: { id: machine.id, name: machine.name, kind: machine.kind } }),
    ...(state.selectedWorkspace === undefined ? {} : { selectedWorkspace: state.selectedWorkspace }),
    ...(session === undefined ? {} : { selectedSession: {
      id: session.id,
      cwd: session.cwd,
      ...(session.name === undefined ? {} : { name: session.name }),
      archived: session.archived === true,
      pending: "clientPendingStart" in session && session.clientPendingStart === true,
    } }),
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
      const { actions, workspacePanels, workspaceLabels } = activation.contributions;
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
