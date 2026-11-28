import { MachineSwitcher } from "../../src/client/src/components/MachineSwitcher";
import { pluginStyles, stylesheetIntegrationCapability } from "../../src/client/src/plugins/styles";
import { localization } from "../../src/client/src/localization/browser";
import { createPluginLocalization } from "../../src/client/src/plugins/localization";
import { createPluginCatalog } from "../../src/client/src/plugins/catalog";
import { openWorktreeDialog } from "../../pi-packages/workflows/browser/worktreeDialog";
import worktreeMessages from "../../pi-packages/workflows/browser/workflows.messages";
import { ProjectList } from "../../src/client/src/components/ProjectList";
import { ProjectSettingsDialog } from "../../src/client/src/components/ProjectSettingsDialog";
import { WorkspaceList } from "../../src/client/src/components/WorkspaceList";
import { SessionList } from "../../src/client/src/components/SessionList";
import { trustApi, workspacesApi, type SessionInfo } from "../../src/client/src/api";
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
workspacesApi.workspaces = (projectId) => Promise.resolve(projects.projects
  .filter((project) => project.id === projectId)
  .map((project) => ({ id: `${projectId}-root`, projectId, path: project.path, label: "Root", isMain: true, effectiveConfig: {} })));
trustApi.setWorkspaceTrust = (_projectId, _workspaceId, trusted) => Promise.resolve({ path: "/repo", decision: trusted, trusted });
const selectedProject = projects.projects[0];
if (selectedProject === undefined) throw new Error("Missing project fixture");
projects.selected = selectedProject;
projects.statusSnapshot = snapshot;
projects.onSelect = (project) => { projects.selected = project; result.textContent = `projects:${project.id}`; };
projects.onProjectSettings = (project) => {
  const dialog = new ProjectSettingsDialog();
  dialog.loadSettings = () => Promise.resolve({
    project,
    worktreeFolder: { path: `/mnt/worktrees/${"long-directory-name-".repeat(6)}project`, source: "machine" },
  });
  dialog.onCancel = () => { dialog.remove(); };
  dialog.onSubmit = () => { dialog.remove(); return Promise.resolve(); };
  document.body.append(dialog);
};
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
const workflowLocalization = createPluginLocalization(localization, "workflows", "workflows", new AbortController().signal);
const workflowMessages = workflowLocalization.registerMessages("worktree", worktreeMessages);
workspaces.createAction = { title: workflowMessages.t("title"), run: () => {
  openWorktreeDialog({
    state: { selectedProject }, refreshAppData: () => undefined,
    catalog: createPluginCatalog("local", undefined, () => Promise.resolve(workspaces.workspaces)),
    navigate: ({ machineId, projectId, workspaceId, sessionId, view }) => {
      const workspace = workspaces.workspaces.find((entry) => entry.projectId === projectId && entry.id === workspaceId);
      if (machineId !== "local" || workspace === undefined || (sessionId !== undefined && view !== "chat")) {
        return Promise.reject(new Error("Unexpected navigation destination in fixture"));
      }
      workspaces.onSelect?.(workspace);
      if (typeof sessionId === "string") result.textContent = `sessions:${sessionId}`;
      return Promise.resolve();
    },
    projects: {
      machineId: "remote", listProjects: () => Promise.resolve([selectedProject]),
      suggestDirectories: (query) => Promise.resolve(query === "/mnt/" ? [{ path: "/mnt/team/" }] : []),
      getWorktreeFolder: () => Promise.resolve({ path: "/mnt/worktrees", configured: true }),
    },
  }, { request: (operation, input) => {
    if (operation === "prepare") return Promise.resolve({ workspacePath: "/repo", branches: ["main"], defaultBase: "main", manual: { startingRefs: ["refs/heads/main"] } });
    if (operation === "dispatch") return Promise.resolve({ workspaceId: selectedWorkspace.id, sessionId: "fresh-conversation" });
    if (operation !== "create-worktree" || input === null || typeof input !== "object" || Array.isArray(input)) return Promise.reject(new Error("Unexpected fixture request"));
    const path: unknown = Reflect.get(input, "destination");
    if (typeof path !== "string") return Promise.reject(new Error("Missing destination"));
    workspaces.workspaces = [...workspaces.workspaces, {
      id: "created-worktree", projectId: selectedProject.id, path, label: "Created worktree", isMain: false, effectiveConfig: {},
    }];
    return Promise.resolve({ path });
  } }, "manual", workflowLocalization, workflowMessages, stylesheetIntegrationCapability, () => undefined);
} };

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
const machines = new MachineSwitcher();
machines.machines = [
  { id: "local", name: "Local fixture", kind: "local", status: "online", createdAt: "", updatedAt: "" },
  { id: "remote", name: "Remote fixture", kind: "remote", baseUrl: "https://remote.invalid", status: "online", createdAt: "", updatedAt: "" },
];
const selectedMachine = machines.machines[0];
if (selectedMachine === undefined) throw new Error("Missing machine fixture");
machines.selected = selectedMachine;
machines.onSelect = (machine) => { machines.selected = machine; result.textContent = `machines:${machine.id}`; };
main.append(machines, projects, workspaces, sessions);
document.body.append(main, result);
await Promise.all([machines.updateComplete, projects.updateComplete, workspaces.updateComplete, sessions.updateComplete]);

declare global {
  interface Window {
    navigationFixture: {
      applyTheme: (url: string) => Promise<void>;
      clearTheme: () => void;
      intervention: (unread: boolean) => Promise<void>;
    };
  }
}
window.navigationFixture = {
  applyTheme: (url) => pluginStyles.setTheme([{ id: "fixture:theme", url }], () => undefined),
  clearTheme: () => { pluginStyles.clearTheme(); },
  intervention: async (unread) => {
    const flags = { "core:working": true, "core:intervention-required": true, "core:unread": unread };
    const interventionSnapshot = { ...snapshot, machine: flags, projects: { p1: flags }, workspaces: { w1: flags } };
    machines.statusSnapshots = { local: interventionSnapshot };
    projects.statusSnapshot = interventionSnapshot;
    workspaces.statusSnapshot = interventionSnapshot;
    sessions.sessionFlags = { s1: flags, agent: flags };
    sessions.unreadSessionIds = new Set(unread ? ["s1", "agent"] : []);
    await Promise.all([machines.updateComplete, projects.updateComplete, workspaces.updateComplete, sessions.updateComplete]);
  },
};
document.body.dataset["ready"] = "true";
