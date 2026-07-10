import { isSessionActive } from "../../../../shared/activity";
import { PI_WEB_CAPABILITIES, supportsPiWebCapability, type PiWebCapability } from "../../../../shared/capabilities";
import type { AppState } from "../../appState";
import { selectedMachineId } from "../../controllers/types";
import { isArchivableSessionInfo, isTransientNewSessionInfo, sessionPersistenceOptionsForRuntime } from "../../sessionPersistence";
import { isWorkspaceDeletionPending } from "../../workspaceDeletion";
import type { PluginAction } from "../types";

export function createCoreActions(): PluginAction[] {
  return [
    {
      id: "actions.show",
      title: "Show Actions",
      description: "Open the command palette",
      shortcut: "mod+k",
      group: "General",
      run: (context) => { context.openActionPalette(); },
    },
    {
      id: "prompt.focus",
      title: "Focus Prompt",
      description: "Move keyboard focus to the message composer",
      shortcut: "mod+g c",
      group: "General",
      run: (context) => { context.focusPrompt(); },
    },
    {
      id: "machine.add",
      title: "Add Machine",
      description: "Register another PI WEB runtime reachable from this gateway",
      group: "Machine",
      run: (context) => context.addMachine(),
    },
    {
      id: "machine.refresh",
      title: "Refresh Selected Machine",
      description: "Check whether the selected PI WEB runtime is online",
      group: "Machine",
      run: (context) => context.refreshSelectedMachine(),
    },
    {
      id: "machine.open",
      title: "Open Selected Machine PI WEB",
      description: "Open the selected remote PI WEB directly in a new tab",
      group: "Machine",
      enabled: (context) => context.state.selectedMachine?.kind === "remote" && context.state.selectedMachine.baseUrl !== undefined,
      run: (context) => context.openSelectedMachine(),
    },
    {
      id: "machine.remove",
      title: "Remove Selected Machine",
      description: "Remove the selected remote machine from this gateway",
      group: "Machine",
      enabled: (context) => context.state.selectedMachine?.kind === "remote",
      run: (context) => context.removeSelectedMachine(),
    },
    {
      id: "project.add",
      title: "Add Project",
      group: "Project",
      run: (context) => context.addProject(),
    },
    {
      id: "auth.login",
      title: "Configure Provider Authentication",
      description: "Run /login without tying authentication to a session",
      group: "General",
      run: (context) => context.configureAuth(),
    },
    {
      id: "auth.logout",
      title: "Remove Provider Authentication",
      description: "Run /logout for stored pi credentials",
      group: "General",
      run: (context) => context.logoutAuth(),
    },
    {
      id: "theme.select",
      title: "Select Theme",
      description: "Choose the PI WEB color theme",
      group: "Preferences",
      run: (context) => { context.openThemePicker(); },
    },
    {
      id: "settings.open",
      title: "Open Settings",
      description: "Manage PI WEB configuration and keyboard shortcuts",
      shortcut: "mod+,",
      group: "Preferences",
      run: (context) => { context.piWebUnstable?.openSettings?.(); },
    },
    {
      id: "app.reload-page",
      title: "Full Page Reload",
      description: "Reload the PI WEB browser page",
      group: "General",
      run: (context) => { context.reloadPage(); },
    },
    {
      id: "view.chat",
      title: "Go to Chat",
      shortcut: "mod+1",
      group: "Navigation",
      run: (context) => { context.focusPrompt(); },
    },
    {
      id: "view.files",
      title: "Go to Files",
      shortcut: "mod+2",
      group: "Navigation",
      enabled: hasWorkspace,
      run: (context) => { context.selectMainView("core:workspace.files"); },
    },
    {
      id: "view.git",
      title: "Go to Git",
      shortcut: "mod+3",
      group: "Navigation",
      enabled: hasGitWorkspace,
      run: (context) => { context.selectMainView("core:workspace.git"); },
    },
    {
      id: "view.terminal",
      title: "Go to Terminal",
      shortcut: "mod+4",
      group: "Navigation",
      enabled: hasWorkspace,
      run: (context) => { context.selectMainView("core:workspace.terminal"); },
    },
    {
      id: "workspace.refresh-files",
      title: "Refresh Files",
      shortcut: "mod+shift+f",
      group: "Workspace",
      enabled: hasWorkspace,
      run: (context) => context.refreshFiles(),
    },
    {
      id: "workspace.refresh-git",
      title: "Refresh Git",
      shortcut: "mod+shift+g",
      group: "Workspace",
      enabled: hasGitWorkspace,
      run: (context) => context.refreshGit(),
    },
    {
      id: "workspace.refresh-current",
      title: "Refresh Current Panel",
      shortcut: "mod+shift+r",
      group: "Workspace",
      enabled: hasWorkspace,
      run: (context) => context.state.workspaceTool === "core:workspace.git" && context.state.selectedWorkspace?.isGitRepo === true ? context.refreshGit() : context.refreshFiles(),
    },
    {
      id: "workspace.delete",
      title: "Delete Workspace",
      description: "Remove the selected Git worktree",
      group: "Workspace",
      enabled: hasDeletableWorkspace,
      run: (context) => context.deleteWorkspace(),
    },
    {
      id: "session.start",
      title: "Start Session",
      shortcut: "mod+enter",
      group: "Session",
      enabled: hasWorkspace,
      run: (context) => context.startSession(),
    },
    {
      id: "session.archive",
      title: "Archive Session",
      description: "Archive the selected session",
      group: "Session",
      enabled: hasArchivableSession,
      run: (context) => context.archiveSession(),
    },
    {
      id: "session.reload",
      title: "Reload Session from Disk",
      description: "Close and re-open the selected session from its session file. Use /reload in the prompt for Pi runtime resources.",
      group: "Session",
      enabled: hasReloadableSession,
      disabledReason: reloadSessionDisabledReason,
      run: (context) => context.reloadSession(),
    },
    {
      id: "session.delete",
      title: "Delete New Session",
      description: "Delete the selected transient new session",
      group: "Session",
      enabled: hasTransientNewSession,
      run: (context) => context.deleteCachedNewSession(),
    },
    {
      id: "session.stop",
      title: "Stop Active Work",
      shortcut: "mod+.",
      group: "Session",
      enabled: (context) => context.state.selectedSession !== undefined && isSessionActive(context.state.status, context.state.activity),
      run: (context) => context.stopActiveWork(),
    },
  ];
}

function hasWorkspace(context: { state: AppState }): boolean {
  return context.state.selectedWorkspace !== undefined;
}

function hasGitWorkspace(context: { state: AppState }): boolean {
  return context.state.selectedWorkspace?.isGitRepo === true;
}

function hasDeletableWorkspace(context: { state: AppState }): boolean {
  const workspace = context.state.selectedWorkspace;
  return workspace !== undefined && workspace.isGitWorktree && !workspace.isMain && !isWorkspaceDeletionPending(context.state, workspace);
}

function hasArchivableSession(context: { state: AppState }): boolean {
  return isArchivableSessionInfo(context.state.selectedSession, context.state.status, sessionPersistenceOptions(context.state));
}

function hasTransientNewSession(context: { state: AppState }): boolean {
  return isTransientNewSessionInfo(context.state.selectedSession, context.state.status, sessionPersistenceOptions(context.state));
}

function hasReloadableSession(context: { state: AppState }): boolean {
  if (!isArchivableSessionInfo(context.state.selectedSession, context.state.status, sessionPersistenceOptions(context.state))) return false;
  if (reloadSessionDisabledReason(context) !== undefined) return false;
  return !isSessionActive(context.state.status, context.state.activity);
}

function reloadSessionDisabledReason(context: { state: AppState }): string | undefined {
  if (!isArchivableSessionInfo(context.state.selectedSession, context.state.status, sessionPersistenceOptions(context.state))) return undefined;
  if (isSessionActive(context.state.status, context.state.activity)) return undefined;
  return missingCapabilityReason(context.state, PI_WEB_CAPABILITIES.sessionsReload, "reload sessions from disk");
}

function sessionPersistenceOptions(state: AppState) {
  return sessionPersistenceOptionsForRuntime(state.machineRuntimes[selectedMachineId(state)]);
}

function missingCapabilityReason(state: AppState, capability: PiWebCapability, action: string): string | undefined {
  const runtime = state.machineRuntimes[selectedMachineId(state)];
  if (runtime?.ok === true && supportsPiWebCapability(runtime, capability)) return undefined;
  return `Update and restart Pi-Web on ${state.selectedMachine?.name ?? "this machine"} to ${action}.`;
}
