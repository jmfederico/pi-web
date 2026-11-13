import { panelServices } from "../../pi-packages/mcp-manager/browser/panel.testSupport.js";
import { parseManagedMcpView } from "../../pi-packages/mcp-manager/browser/managedMcp.js";

const style = document.createElement("style");
style.textContent = `
  :root { color-scheme: dark; --pi-bg: #161616; --pi-surface: #252525; --pi-text: #eee; --pi-text-bright: #fff; --pi-border: #555; --pi-border-muted: #444; --pi-muted: #aaa; --pi-accent: #aaf; --pi-overlay: #0008; }
  body { margin: 0; background: var(--pi-bg); color: var(--pi-text); font: 14px system-ui; }
`;
document.head.append(style);
const host = document.createElement("main");
host.style.cssText = "position: fixed; inset: 0; height: 100dvh; overflow: hidden;";
const root = host.attachShadow({ mode: "open" });
const scroller = document.createElement("section");
scroller.style.cssText = "height: 100%; overflow: auto;";
const services = panelServices();
const panel = services.createPanel();
panel.backend = {
  machineId: "fixture",
  forScope: (scope) => ({
    async request(operation, input) {
      const response = await fetch(new URL("mcp-fixture", document.baseURI), { method: "POST", body: JSON.stringify({ scope, operation, input }) });
      const view = parseManagedMcpView(await response.json());
      return { ...view, servers: view.servers.map((server) => ({ ...server })) };
    },
  }),
};
panel.context = { machineId: "fixture", projectId: "project", workspaceId: "workspace", cwd: "/workspace", sessionId: "session-fixture" };
panel.machineLabel = "Build machine";
panel.sessionLabel = "Documentation review";
scroller.append(panel);
root.append(scroller);
document.body.append(host);
