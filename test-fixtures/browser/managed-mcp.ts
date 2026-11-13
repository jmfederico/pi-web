import { ManagedMcpPanel } from "../../src/client/src/components/ManagedMcpPanel";

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
const panel = new ManagedMcpPanel();
panel.context = { machineId: "fixture", cwd: "/workspace", sessionId: "session-fixture" };
panel.machineLabel = "Build machine";
panel.sessionLabel = "Documentation review";
scroller.append(panel);
root.append(scroller);
document.body.append(host);
