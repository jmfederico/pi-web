import type { PiWebPlugin } from "@jmfederico/pi-web/plugin-api";
import { TodosPanel } from "./panel.js";

const plugin: PiWebPlugin = {
  apiVersion: 4,
  name: "To-dos",
  activate({ html, lifetimeSignal }) {
    if (customElements.get("pi-todos-panel") === undefined) customElements.define("pi-todos-panel", TodosPanel);
    return {
      contributions: {
        applicationPanels: [{
          id: "list", title: "To-dos",
          render(context) {
            return html`<pi-todos-panel .source=${{ machineId: context.machine.id, ...(context.backend === undefined ? {} : { backend: context.backend }), lifetime: lifetimeSignal }}></pi-todos-panel>`;
          },
        }],
      },
    };
  },
};
export default plugin;
