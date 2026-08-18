// Skeleton of a PI WEB plugin: metadata plus contribution definitions.
//
// Everything the bundled Info panel and action actually render lives in
// infoInternals.ts. That file is replaceable implementation detail — when
// copying this plugin as a starting point, keep this file's shape and swap
// the internals for your own.

import type { PiWebPlugin } from "@jmfederico/pi-web/plugin-api";
import { copyDiagnostics, renderInfoPanel } from "./infoInternals.js";

const plugin: PiWebPlugin = {
  apiVersion: 2,
  name: "Info Plugin",
  activate: ({ html, svg }) => ({
    contributions: {
      actions: [
        {
          id: "copy-diagnostics",
          title: "Copy PI WEB Diagnostics",
          description: "Copy version, installation, and status details for this machine, ready to paste into a bug report",
          group: "Info",
          run: (context) => copyDiagnostics(context),
        },
      ],
      workspaceLabels: [
        {
          id: "workspace.kind-label",
          order: 100,
          items: (context) => [{ type: "text", text: context.workspace.provider?.pluginId ?? "folder", title: context.workspace.path }],
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
          render: (context) => renderInfoPanel(html, context),
        },
      ],
    },
  }),
};

export default plugin;
