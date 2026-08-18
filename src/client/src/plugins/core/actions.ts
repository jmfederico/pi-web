import { isSessionActive } from "../../../../shared/activity";
import type { AppState } from "../../appState";
import { isArchivableSessionInfo, isTransientNewSessionInfo } from "../../sessionPersistence";
import { canDeleteWorkspace, isWorkspaceDeletionPending } from "../../workspaceDeletion";
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
      id: "workspace.delete",
      title: "Remove Workspace",
      description: "Run the owning provider's workspace removal operation",
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
      id: "model.select",
      title: "Select Model",
      description: "Choose the model for the selected session",
      group: "Session",
      enabled: hasSelectableSession,
      run: (context) => context.openModelPicker(),
    },
    {
      id: "thinking.select",
      title: "Select Thinking Level",
      description: "Choose the thinking level for the selected session",
      group: "Session",
      enabled: hasSelectableSession,
      run: (context) => context.openThinkingLevelPicker(),
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

function hasDeletableWorkspace(context: { state: AppState }): boolean {
  const workspace = context.state.selectedWorkspace;
  return canDeleteWorkspace(workspace) && !isWorkspaceDeletionPending(context.state, workspace);
}

function hasSelectableSession(context: { state: AppState }): boolean {
  const session = context.state.selectedSession;
  return session !== undefined && session.archived !== true;
}

function hasArchivableSession(context: { state: AppState }): boolean {
  return isArchivableSessionInfo(context.state.selectedSession, context.state.status);
}

function hasTransientNewSession(context: { state: AppState }): boolean {
  return isTransientNewSessionInfo(context.state.selectedSession, context.state.status);
}

function hasReloadableSession(context: { state: AppState }): boolean {
  if (!isArchivableSessionInfo(context.state.selectedSession, context.state.status)) return false;
  return !isSessionActive(context.state.status, context.state.activity);
}
