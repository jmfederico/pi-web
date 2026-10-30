import { ProjectList } from "../../src/client/src/components/ProjectList";
import { WorkspaceList } from "../../src/client/src/components/WorkspaceList";
import { SessionList } from "../../src/client/src/components/SessionList";
import { trustApi, type SessionInfo } from "../../src/client/src/api";
import type { MachineStatusSnapshot } from "../../src/shared/machineStatus";

// Real components and deterministic local data; no app runtime or session daemon.
trustApi.workspaceTrust = () => Promise.resolve({ path: "/repo", decision: false, trusted: false });
const style = document.createElement("style");
style.textContent = `
  :root { --pi-bg: #161616; --pi-surface: #252525; --pi-surface-hover: #303030; --pi-text: #eee; --pi-text-bright: #fff; --pi-border: #555; --pi-border-muted: #444; --pi-muted: #aaa; --pi-success: #8cbd9b; --pi-warning: #d1b571; --pi-accent: #aaf; --pi-selection-bg: #303044; }
  body { margin: 0; background: var(--pi-bg); color: var(--pi-text); font-family: system-ui; }
  main { display: flex; flex-direction: column; inline-size: min(340px, 100%); block-size: min(690px, 95dvh); }
  project-list, workspace-list, session-list { flex: 1 1 0; min-block-size: 0; }
`;
document.head.append(style);
const main = document.createElement("main");
const result = document.createElement("output");
result.id = "last-selected";
const longName = "A long navigation label that must truncate without covering the secondary action";
const snapshot: MachineStatusSnapshot = {
  epochId: "fixture", revision: 1, generatedAt: "2026-10-01", machine: {}, unattributed: {},
  projects: { p1: { "core:working": true, "core:unread": true } },
  workspaces: { w1: { "core:terminal": true } },
};
const projects = new ProjectList();
projects.projects = [
  { id: "p1", name: longName, path: "/repo/very-long-project-path", createdAt: "2026-10-01" },
  { id: "p2", name: "Second project", path: "/repo/second", createdAt: "2026-10-01" },
];
const selectedProject = projects.projects[0];
if (selectedProject === undefined) throw new Error("Missing project fixture");
projects.selected = selectedProject;
projects.statusSnapshot = snapshot;
projects.onSelect = (project) => { projects.selected = project; result.textContent = `projects:${project.id}`; };
projects.onMove = () => undefined;
projects.collapsible = true;
projects.onToggleCollapsed = () => { projects.collapsed = !projects.collapsed; };

const workspaces = new WorkspaceList();
workspaces.workspaces = [
  { id: "w1", projectId: "p1", label: longName, path: "/repo/workspace", isMain: true, effectiveConfig: {} },
  { id: "w2", projectId: "p1", label: "Second workspace", path: "/repo/second", isMain: false, effectiveConfig: {} },
];
const selectedWorkspace = workspaces.workspaces[0];
if (selectedWorkspace === undefined) throw new Error("Missing workspace fixture");
workspaces.selected = selectedWorkspace;
workspaces.statusSnapshot = snapshot;
workspaces.workspaceLabelItems = () => [{ type: "text", text: "Branch and workspace details" }];
workspaces.onSelect = (workspace) => { workspaces.selected = workspace; result.textContent = `workspaces:${workspace.id}`; };
workspaces.onMove = () => undefined;
workspaces.collapsible = true;
workspaces.onToggleCollapsed = () => { workspaces.collapsed = !workspaces.collapsed; };

function session(id: string, firstMessage: string, extra: Partial<SessionInfo> = {}): SessionInfo {
  return { id, cwd: "/repo", path: `/sessions/${id}.jsonl`, created: "2026-10-01", modified: "2026-10-01", messageCount: 2, firstMessage, persisted: true, ...extra };
}
const sessions = new SessionList();
const parent = session("s1", longName);
sessions.sessions = [parent, session("s2", "Second session"), session("agent", "Agent child", { parentSessionPath: parent.path, agentSubsession: true })];
sessions.selected = parent;
sessions.sessionFlags = { s1: { "core:working": true } };
sessions.unreadSessionIds = new Set([parent.id]);
sessions.onSelect = (session) => { sessions.selected = session; result.textContent = `sessions:${session.id}`; };
sessions.collapsible = true;
sessions.onToggleCollapsed = () => { sessions.collapsed = !sessions.collapsed; };
main.append(projects, workspaces, sessions);
document.body.append(main, result);
await Promise.all([projects.updateComplete, workspaces.updateComplete, sessions.updateComplete]);

// Deliberately generic and less specific than legacy unread/session selectors.
// Supported hooks must still win over all base-layer defaults in each root.
const sheet = new CSSStyleSheet();
sheet.replaceSync(`
  .ui-nav-row-label { color: rgb(200, 210, 220); white-space: normal; }
  .ui-nav-row-main { padding-inline-start: 24px; }
`);
declare global {
  interface Window { navigationFixture: { applyTheme: () => void }; }
}
window.navigationFixture = {
  applyTheme: () => {
    for (const component of [projects, workspaces, sessions]) {
      const root = component.shadowRoot;
      if (!root) throw new Error("Missing navigation root");
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
    }
  },
};
document.body.dataset["ready"] = "true";
