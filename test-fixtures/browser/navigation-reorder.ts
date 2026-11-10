import { ProjectList } from "../../src/client/src/components/ProjectList";
import { WorkspaceList } from "../../src/client/src/components/WorkspaceList";
import { SessionList } from "../../src/client/src/components/SessionList";
import { MachineList } from "../../src/client/src/components/MachineList";
import { moveOrderedId, orderItems } from "../../src/client/src/navigationOrder";
import { pluginStyles } from "../../src/client/src/plugins/styles";
import { workspacesApi, trustApi, type SessionInfo } from "../../src/client/src/api";

// Exercise real shadow roots, containment, scroll geometry and menus without a daemon.
workspacesApi.workspaces = () => Promise.resolve([]);
trustApi.workspaceTrust = () => Promise.resolve({ path: "/repo", trusted: false, decision: false });
const style = document.createElement("style");
style.textContent = `
  :root { --pi-bg: #161616; --pi-surface: #252525; --pi-surface-hover: #303030; --pi-text: #eee; --pi-text-bright: #fff; --pi-border: #555; --pi-border-muted: #444; --pi-muted: #aaa; --pi-accent: #aaf; --pi-selection-bg: #303044; --pi-shadow: #0006; }
  body { margin: 0; background: var(--pi-bg); color: var(--pi-text); font-family: system-ui; }
  main { margin: 20px; display: flex; container-type: inline-size; inline-size: min(340px, calc(100vw - 40px)); block-size: min(460px, 80dvh); }
  project-list, workspace-list, session-list, machine-list { flex: 1; min-width: 0; }
`;
document.head.append(style);
const params = new URLSearchParams(location.search);
const kind = params.get("list") ?? "projects";
const count = params.has("long") ? 24 : 3;
const items = Array.from({ length: count }, (_, i) => ({ id: params.has("details") ? `01234567-89ab-cdef-0123-${String(i + 1).padStart(12, "0")}` : String(i + 1), name: `Item ${String(i + 1)} — a long label to verify the preview stays within its row` }));
const result = document.createElement("output");
result.id = "selected";
const list = kind === "workspaces" ? new WorkspaceList() : kind === "sessions" ? new SessionList() : kind === "machines" ? new MachineList() : new ProjectList();
const ids = () => items.map((item) => item.id);
if (list instanceof ProjectList) {
  list.projects = items.map((item) => ({ ...item, path: `/repo/${item.id}`, createdAt: "" }));
  workspacesApi.workspaces = (projectId) => Promise.resolve(list.projects.filter((project) => project.id === projectId).map((project) => ({ id: `${projectId}-root`, projectId, path: project.path, label: "Root", isMain: true, effectiveConfig: {} })));
  list.onSelect = (item) => { result.textContent = item.id; };
  list.onReorder = (item, neighbor, position) => {
    list.projects = orderItems(list.projects, moveOrderedId(list.projects.map((item) => item.id), ids(), item.id, neighbor.id, position));
  };
  list.onMove = (item, direction) => {
    const neighbor = list.projects[list.projects.indexOf(item) + direction];
    if (neighbor) list.onReorder?.(item, neighbor, direction < 0 ? "before" : "after");
  };
} else if (list instanceof WorkspaceList) {
  list.workspaces = items.map((item) => ({ id: item.id, label: item.name, path: `/repo/${item.id}`, projectId: "project", isMain: false, effectiveConfig: {} }));
  list.onSelect = (item) => { result.textContent = item.id; };
  list.onReorder = (item, neighbor, position) => {
    list.workspaces = orderItems(list.workspaces, moveOrderedId(list.workspaces.map((item) => item.id), ids(), item.id, neighbor.id, position));
  };
  if (!params.has("noactions")) list.onMove = (item, direction) => {
    const neighbor = list.workspaces[list.workspaces.indexOf(item) + direction];
    if (neighbor) list.onReorder?.(item, neighbor, direction < 0 ? "before" : "after");
  };
} else if (list instanceof MachineList) {
  list.machines = items.map((item) => ({ ...item, kind: params.has("noactions") ? "local" : "remote", baseUrl: "https://remote.invalid", createdAt: "", updatedAt: "" }));
  list.onEdit = () => undefined;
  list.onRemove = () => undefined;
} else {
  const session = (id: string, name: string): SessionInfo => ({ id, name, firstMessage: "", cwd: "/repo", path: `/sessions/${id}.jsonl`, created: "2026-10-01", modified: "2026-10-01", messageCount: 1, persisted: true });
  list.sessions = [...items.map((item) => session(item.id, item.name)),
    { ...session("child", "Child of item 2"), parentSessionPath: `/sessions/${items[1]?.id ?? "2"}.jsonl` },
    session("unpinned", "Unpinned session")];
  list.pinnedRootIds = ids();
  list.onSelect = (item) => { result.textContent = item.id; };
  list.onReorderPin = (item, neighbor, position) => {
    list.pinnedRootIds = moveOrderedId(list.pinnedRootIds, ids(), item.id, neighbor.id, position);
  };
  list.onPin = () => undefined;
}
const main = document.createElement("main");
main.append(list);
document.body.append(main, result);
await list.updateComplete;
declare global {
  interface Window {
    reorderFixture: { applyTheme: (url: string) => Promise<void> };
  }
}
window.reorderFixture = { applyTheme: (url) => pluginStyles.setTheme([{ id: "fixture:reorder-theme", url }], () => undefined) };
document.body.dataset["ready"] = "true";
