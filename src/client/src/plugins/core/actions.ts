import { restartMessages } from "../../restartMessages";
import { coreActionMessages as m } from "./messages";
import { isSessionActive } from "../../../../shared/activity";
import type { AppState } from "../../appState";
import { isArchivableSessionInfo, isTransientNewSessionInfo } from "../../sessionPersistence";
import { canDeleteWorkspace, isWorkspaceDeletionPending } from "../../workspaceDeletion";
import type { PluginAction } from "../types";

export function createCoreActions(): PluginAction[] {
  return [
    {
      id: "actions.show",
      get title() { return m.t("actions_show_title"); },
      get description() { return m.t("actions_show_description"); },
      shortcut: "mod+k",
      get group() { return m.t("groupGeneral"); },
      run: (context) => { context.openActionPalette(); },
    },
    {
      id: "prompt.focus",
      get title() { return m.t("prompt_focus_title"); },
      get description() { return m.t("prompt_focus_description"); },
      shortcut: "mod+g c",
      get group() { return m.t("groupGeneral"); },
      run: (context) => { context.focusPrompt(); },
    },
    {
      id: "machine.add",
      get title() { return m.t("machine_add_title"); },
      get description() { return m.t("machine_add_description"); },
      get group() { return m.t("groupMachine"); },
      run: (context) => context.addMachine(),
    },
    {
      id: "machine.refresh",
      get title() { return m.t("machine_refresh_title"); },
      get description() { return m.t("machine_refresh_description"); },
      get group() { return m.t("groupMachine"); },
      run: (context) => context.refreshSelectedMachine(),
    },
    {
      id: "machine.open",
      get title() { return m.t("machine_open_title"); },
      get description() { return m.t("machine_open_description"); },
      get group() { return m.t("groupMachine"); },
      enabled: (context) => context.state.selectedMachine?.kind === "remote" && context.state.selectedMachine.baseUrl !== undefined,
      run: (context) => context.openSelectedMachine(),
    },
    {
      id: "machine.remove",
      get title() { return m.t("machine_remove_title"); },
      get description() { return m.t("machine_remove_description"); },
      get group() { return m.t("groupMachine"); },
      enabled: (context) => context.state.selectedMachine?.kind === "remote",
      run: (context) => context.removeSelectedMachine(),
    },
    {
      id: "project.add",
      get title() { return m.t("project_add_title"); },
      get group() { return m.t("groupProject"); },
      run: (context) => context.addProject(),
    },
    {
      id: "auth.login",
      get title() { return m.t("auth_login_title"); },
      get description() { return m.t("auth_login_description", { command: "/login" }); },
      get group() { return m.t("groupGeneral"); },
      run: (context) => context.configureAuth(),
    },
    {
      id: "auth.logout",
      get title() { return m.t("auth_logout_title"); },
      get description() { return m.t("auth_logout_description", { command: "/logout" }); },
      get group() { return m.t("groupGeneral"); },
      run: (context) => context.logoutAuth(),
    },
    {
      id: "mcp.login",
      get title() { return m.t("mcp_login_title"); },
      get description() { return m.t("mcp_login_description"); },
      get group() { return m.t("groupMCP"); },
      enabled: (context) => hasSelectableSession(context) && context.piWebUnstable?.openMcpAuth !== undefined,
      disabledReason: (context) => hasSelectableSession(context) ? undefined : m.t("selectMcpSession"),
      run: (context) => context.piWebUnstable?.openMcpAuth?.("login"),
    },
    {
      id: "mcp.logout",
      get title() { return m.t("mcp_logout_title"); },
      get description() { return m.t("mcp_logout_description"); },
      get group() { return m.t("groupMCP"); },
      enabled: (context) => hasSelectableSession(context) && context.piWebUnstable?.openMcpAuth !== undefined,
      disabledReason: (context) => hasSelectableSession(context) ? undefined : m.t("selectMcpSession"),
      run: (context) => context.piWebUnstable?.openMcpAuth?.("logout"),
    },
    {
      id: "theme.select",
      get title() { return m.t("theme_select_title"); },
      get description() { return m.t("theme_select_description"); },
      get group() { return m.t("groupPreferences"); },
      run: (context) => { context.openThemePicker(); },
    },
    {
      id: "settings.open",
      get title() { return m.t("settings_open_title"); },
      get description() { return m.t("settings_open_description"); },
      shortcut: "mod+,",
      get group() { return m.t("groupPreferences"); },
      run: (context) => { context.piWebUnstable?.openSettings?.(); },
    },
    {
      id: "app.restart",
      get title() { return restartMessages.t("action"); },
      get description() { return restartMessages.t("actionDescription"); },
      get group() { return m.t("groupGeneral"); },
      run: (context) => { context.piWebUnstable?.openRestart?.(); },
    },
    {
      id: "app.reload-page",
      get title() { return m.t("app_reloadPage_title"); },
      get description() { return m.t("app_reloadPage_description"); },
      get group() { return m.t("groupGeneral"); },
      run: (context) => { context.reloadPage(); },
    },
    {
      id: "view.chat",
      get title() { return m.t("view_chat_title"); },
      shortcut: "mod+1",
      get group() { return m.t("groupNavigation"); },
      run: (context) => { context.focusPrompt(); },
    },
    {
      id: "workspace.delete",
      get title() { return m.t("workspace_delete_title"); },
      get description() { return m.t("workspace_delete_description"); },
      get group() { return m.t("groupWorkspace"); },
      enabled: hasDeletableWorkspace,
      run: (context) => context.deleteWorkspace(),
    },
    {
      id: "session.start",
      get title() { return m.t("session_start_title"); },
      shortcut: "mod+enter",
      get group() { return m.t("groupSession"); },
      enabled: hasWorkspace,
      run: (context) => context.startSession(),
    },
    {
      id: "model.select",
      get title() { return m.t("model_select_title"); },
      get description() { return m.t("model_select_description"); },
      get group() { return m.t("groupSession"); },
      enabled: hasSelectableSession,
      run: (context) => context.openModelPicker(),
    },
    {
      id: "thinking.select",
      get title() { return m.t("thinking_select_title"); },
      get description() { return m.t("thinking_select_description"); },
      get group() { return m.t("groupSession"); },
      enabled: hasSelectableSession,
      run: (context) => context.openThinkingLevelPicker(),
    },
    {
      id: "session.archive",
      get title() { return m.t("session_archive_title"); },
      get description() { return m.t("session_archive_description"); },
      get group() { return m.t("groupSession"); },
      enabled: hasArchivableSession,
      run: (context) => context.archiveSession(),
    },
    {
      id: "session.reload",
      get title() { return m.t("session_reload_title"); },
      get description() { return m.t("session_reload_description", { command: "/reload" }); },
      get group() { return m.t("groupSession"); },
      enabled: hasReloadableSession,
      run: (context) => context.reloadSession(),
    },
    {
      id: "session.delete",
      get title() { return m.t("session_delete_title"); },
      get description() { return m.t("session_delete_description"); },
      get group() { return m.t("groupSession"); },
      enabled: hasTransientNewSession,
      run: (context) => context.deleteCachedNewSession(),
    },
    {
      id: "session.stop",
      get title() { return m.t("session_stop_title"); },
      shortcut: "mod+.",
      get group() { return m.t("groupSession"); },
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
