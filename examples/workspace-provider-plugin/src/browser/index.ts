import type { JsonObject, PiWebPlugin, WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";

const summaries = new Map<string, string>();

const plugin: PiWebPlugin = {
  apiVersion: 2,
  name: "Example Workspace Provider",
  activate: ({ pluginId, runtimePluginId, html }) => ({
    contributions: {
      actions: [
        {
          id: "workspace.open",
          title: "Open Example Workspace Provider",
          enabled: ({ state }) => state.selectedWorkspace?.provider?.pluginId === pluginId,
          run: ({ selectWorkspaceTool }) => {
            selectWorkspaceTool(`${runtimePluginId}:workspace.example-provider`);
          },
        },
      ],
      workspacePanels: [
        {
          id: "workspace.example-provider",
          title: "Example Provider",
          visible: ({ workspace }) => workspace.provider?.pluginId === pluginId,
          render: (context) => {
            const marker = stringMetadata(context.workspace.provider?.metadata, "marker") ?? "unknown";
            const summary = summaries.get(workspaceKey(context)) ?? "Request a summary from the owning server plugin.";
            return html`
              <section class="toolbar"><strong>Example workspace provider</strong></section>
              <section class="viewer">
                <p>This workspace is owned by <code>${pluginId}</code>.</p>
                <p class="muted">Claim marker: <code>${marker}</code></p>
                <button
                  ?disabled=${context.backend === undefined}
                  @click=${() => { void refreshSummary(context); }}
                >Request backend summary</button>
                <p aria-live="polite">${summary}</p>
              </section>
            `;
          },
        },
      ],
    },
  }),
};

export default plugin;

async function refreshSummary(context: WorkspacePanelContext): Promise<void> {
  const key = workspaceKey(context);
  try {
    if (context.backend === undefined) throw new Error("The paired workspace backend is unavailable");
    const result = await context.backend.request("summary", null);
    if (typeof result !== "string") throw new Error("The workspace backend returned an invalid summary");
    summaries.set(key, result);
  } catch (error) {
    summaries.set(key, error instanceof Error ? error.message : String(error));
  }
  context.host.requestRender();
}

function workspaceKey(context: WorkspacePanelContext): string {
  return `${context.machine.id}:${context.workspace.id}`;
}

function stringMetadata(metadata: JsonObject | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" ? value : undefined;
}
