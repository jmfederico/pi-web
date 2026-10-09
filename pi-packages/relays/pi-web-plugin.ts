import type { PiWebPlugin } from "@jmfederico/pi-web/plugin-api";
import { RELAYS_ROOT } from "./relayDiscovery.js";
import { relayIdentityFromMetadata } from "./relayIdentity.js";
import { defineRelaysPanelElement, RELAY_SELECTION_QUERY_KEY } from "./relaysPanelElement.js";

const plugin = {
  apiVersion: 4,
  name: "Relays",
  activate: ({ runtimePluginId, html, svg }) => {
    defineRelaysPanelElement();

    return {
      contributions: {
        actions: [
          {
            id: "workspace.open-relays",
            title: "Open Workspace Relays",
            description: `Open the workspace Relays tab. Relays live in ${RELAYS_ROOT}.`,
            group: "Workspace",
            enabled: (context) => context.state.selectedWorkspace !== undefined,
            run: (context) => {
              if (context.state.selectedWorkspace === undefined) return;
              context.selectWorkspaceTool(`${runtimePluginId}:workspace.relays`);
            },
          },
        ],
        sessionLabels: [
          {
            id: "session.relay",
            items: (context) => {
              const identity = relayIdentityFromMetadata(context.session.metadata);
              if (identity === undefined) return [];
              return [{
                type: "render",
                render: () => html`
                  <button
                    type="button"
                    style="border:0; padding:0; background:transparent; color:var(--pi-accent); font:inherit; text-align:start; overflow-wrap:anywhere; cursor:pointer"
                    title=${identity.packetPath}
                    aria-label=${`Open Relay ${identity.relayName}, leg ${identity.leg}`}
                    @click=${() => context.navigate({
                      machineId: context.machine.id,
                      projectId: context.workspace.projectId,
                      workspaceId: context.workspace.id,
                      view: "workspace",
                      tool: `${runtimePluginId}:workspace.relays`,
                      query: { [RELAY_SELECTION_QUERY_KEY]: identity.packetPath },
                    }, { mode: "patch" })}
                  >relay</button>
                `,
              }];
            },
          },
        ],
        workspacePanels: [
          {
            id: "workspace.relays",
            title: "Relays",
            icon: svg`
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M9 17H7A5 5 0 0 1 7 7h2"></path>
                <path d="M15 7h2a5 5 0 1 1 0 10h-2"></path>
                <line x1="8" y1="12" x2="16" y2="12"></line>
              </svg>
            `,
            order: 50,
            render: (context) => html`<pi-web-relays-panel .context=${context}></pi-web-relays-panel>`,
          },
        ],
      },
    };
  },
} satisfies PiWebPlugin;

export default plugin;
