import type { PiWebPlugin } from "@jmfederico/pi-web/plugin-api";

const plugin: PiWebPlugin = {
  apiVersion: 1,
  name: "Info Plugin",
  activate: ({ html, svg }) => ({
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
          items: (context) => [{ type: "text", text: context.workspace.vcs ?? (context.workspace.isGitRepo ? "git" : "folder"), title: context.workspace.path }],
        },
      ],
      workspacePanels: [
        {
          id: "workspace.info",
          title: "Info",
          icon: svg`
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="9"></circle>
              <path d="M12 11v5"></path>
              <path d="M12 8h.01"></path>
            </svg>
          `,
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

export default plugin;
