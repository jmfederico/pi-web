import { RestartDialog } from "../../src/client/src/components/RestartDialog";

const query = new URLSearchParams(location.search);
const style = document.createElement("style");
style.textContent = `
  :root { color-scheme: dark; --pi-bg: #161616; --pi-surface: #252525; --pi-text: #eee; --pi-text-bright: #fff; --pi-border: #555; --pi-border-muted: #444; --pi-muted: #aaa; --pi-accent: #aaf; --pi-overlay: #0008; }
  body { margin: 0; background: var(--pi-bg); color: var(--pi-text); font: 14px system-ui; }
`;
document.head.append(style);
const host = document.createElement("main");
host.style.cssText = "position: fixed; inset: 0; height: 100dvh; overflow: hidden;";
const root = host.attachShadow({ mode: "open" });
document.body.append(host);
const opener = document.createElement("button");
opener.textContent = "Open restart";
root.append(opener);

// Only capture the terminal handoff; never execute these commands or contact services.
const launches: { command: string; title: string }[] = [];
const dialog = new RestartDialog();
dialog.loadCommands = () => Promise.resolve({
  ...(query.has("missing-web") ? {} : { restartWeb: "pi-web-docker --dev restart-web" }),
  restartSessiond: "pi-web-docker --dev restart-sessiond",
  restart: "pi-web-docker --dev restart",
});
dialog.activity = query.has("idle") ? "idle" : query.has("unknown") ? "unknown" : "active";
dialog.onRun = (command, title) => {
  if (query.has("error")) return Promise.reject(new Error("Fixture terminal unavailable"));
  launches.push({ command, title });
  return Promise.resolve();
};
root.append(dialog);
opener.addEventListener("click", () => { dialog.show(); });

declare global {
  interface Window {
    restartFixture: { launches: () => { command: string; title: string }[] };
  }
}
window.restartFixture = { launches: () => launches };
window.addEventListener("pagehide", () => { dialog.remove(); }, { once: true });
