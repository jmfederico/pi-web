import { html, render } from "lit";
import type { Project } from "../../src/client/src/api";
import "../../src/client/src/components/ProjectList";

const style = document.createElement("style");
style.textContent = `
  :root { --pi-bg: #161616; --pi-surface: #252525; --pi-surface-hover: #2f2f2f; --pi-text: #eee; --pi-border: #555; --pi-border-muted: #444; --pi-muted: #aaa; --pi-selection-bg: #2b3b55; --pi-accent: #7aa7ff; }
  body { margin: 0; padding: 16px; width: 320px; background: var(--pi-bg); color: var(--pi-text); font-family: system-ui; }
  .frame { display: block; }
  .frame project-list { display: block; height: 100%; }
`;
document.head.append(style);

const params = new URLSearchParams(location.search);
const count = Number(params.get("count") ?? "4");
const frameHeight = params.get("height");

const project = (id: string): Project => ({ id, name: `Project ${id}`, path: `/repo/${id}`, createdAt: "2026-10-21T00:00:00Z" });
let projects: Project[] = Array.from({ length: count }, (_, index) => project(String.fromCharCode(65 + index)));
const selected = projects[0];
if (selected === undefined) throw new Error("Expected a seed project");

const host = document.createElement("div");
host.className = "frame";
if (frameHeight !== null) host.style.height = `${frameHeight}px`;
document.body.append(host);

const draw = () => {
  render(html`<project-list
    .projects=${projects}
    .selected=${selected}
    .onSelect=${() => undefined}
    .onMove=${(item: Project, direction: -1 | 1) => {
      const index = projects.indexOf(item);
      const next = [...projects];
      next.splice(index, 1);
      const moved = projects[index];
      if (moved === undefined) return;
      next.splice(index + direction, 0, moved);
      projects = next;
      draw();
    }}
    .onReorder=${(item: Project, neighbor: Project, position: "before" | "after") => {
      const next = projects.filter((candidate) => candidate !== item);
      const index = next.indexOf(neighbor);
      next.splice(index + (position === "after" ? 1 : 0), 0, item);
      projects = next;
      draw();
    }}
  ></project-list>`, host);
};

draw();

// The list body is the scroll container inside the component; give it a bounded
// height so drag autoscroll can be exercised without the whole page scrolling.
const internals = document.createElement("style");
internals.textContent = "section { box-sizing: border-box; height: 100%; display: flex; flex-direction: column; } h2 { flex: 0 0 auto; margin: 0; }";
host.querySelector("project-list")?.shadowRoot?.append(internals);
document.body.dataset["ready"] = "true";
