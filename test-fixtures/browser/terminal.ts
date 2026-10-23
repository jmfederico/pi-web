import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { TerminalPanel } from "../../pi-web-plugins/terminal/TerminalPanel";

customElements.define("fixture-terminal-panel", TerminalPanel);
const panel = new TerminalPanel();
panel.style.cssText = "width: 100%; height: 100%;";
document.body.style.cssText = "margin: 0; height: 100dvh;";
document.body.append(panel);
await panel.updateComplete;

// Exercise the real panel layout and xterm fitting without a daemon or shell.
const host = panel.shadowRoot?.querySelector<HTMLDivElement>(".terminal-host");
if (host === null || host === undefined) throw new Error("Missing terminal host");
const terminal = new Terminal({ fontSize: 13, convertEol: true });
const fit = new FitAddon();
terminal.loadAddon(fit);
terminal.open(host);
const observer = new ResizeObserver(() => { fit.fit(); });
observer.observe(host);
fit.fit();
terminal.write("Last row\r\n".repeat(200), () => { document.body.dataset["ready"] = "true"; });
