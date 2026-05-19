export default {
  apiVersion: 1,
  name: "Info Plugin",
  activate: ({ html }) => ({
    contributions: {
      actions: [
        {
          id: "workspace.show-path",
          title: "Show Current Workspace Path",
          group: "Info",
          enabled: (context) => context.state.selectedWorkspace !== undefined,
          run: (context) => {
            const path = context.state.selectedWorkspace?.path ?? "No workspace selected";
            window.alert(path);
          },
        },
      ],
      workspaceLabels: [
        {
          id: "workspace.kind-label",
          order: 100,
          items: (context) => [{ type: "text", text: context.workspace.isGitRepo ? "git" : "folder", title: context.workspace.path }],
        },
      ],
      workspacePanels: [
        {
          id: "workspace.info",
          title: "Info",
          order: 1000,
          render: (context) => html`
            <section class="toolbar"><strong>Info</strong></section>
            <section class="viewer">
              <p><strong>Workspace</strong></p>
              <p class="muted">${context.workspace.label}</p>
              <p class="muted">${context.workspace.path}</p>
            </section>
          `,
        },
      ],
    },
  }),
};
