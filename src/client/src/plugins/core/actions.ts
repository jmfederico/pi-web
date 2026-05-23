import { isSessionActive } from "../../../../shared/activity";
import type { AppState } from "../../appState";
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
      group: "General",
      enabled: (context) => context.state.selectedSession !== undefined,
      run: (context) => { context.focusPrompt(); },
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
      id: "app.refresh-data",
      title: "Refresh App Data",
      description: "Refresh session, status, activity, and the current workspace surface without reloading the page",
      group: "General",
      run: (context) => context.refreshAppData(),
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
      run: (context) => { context.selectMainView("chat"); },
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
      enabled: (context) => context.state.selectedSession !== undefined && context.state.selectedSession.archived !== true,
      run: (context) => context.archiveSession(),
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
