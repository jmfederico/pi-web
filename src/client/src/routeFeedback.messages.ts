import { message } from "./localization/service";

export default {
  unknownView: message<{ view: string }>("Unknown view: {view}", "Requested route view is not supported; raw view identifier stays unchanged"),
  machineNotFound: message<{ id: string }>("Machine not found: {id}", "Requested route machine is unavailable; identifier stays unchanged"),
  projectNotFound: message<{ id: string }>("Project not found: {id}", "Requested route project is unavailable; identifier stays unchanged"),
  findingSession: message<{ id: string }>("Finding session {id}…", "Session area while a session-only link is matched to its project; identifier stays unchanged"),
  sessionNotFound: message<{ id: string; machines: string; hasUnchecked: string }>("Session {id} was not found in any open project.{hasUnchecked, select, yes { Could not check {machines}.} other {}}", "Session-only link matches no session in open projects; identifier and machine names stay unchanged"),
  remoteMachine: message("Remote machine", "Fallback machine name during route reconnection"),
  reconnecting: message<{ machine: string; detail: string; hasDetail: string }>("{machine} is unavailable; reconnecting…{hasDetail, select, yes { {detail}} other {}}", "Route reconnection banner; machine name and optional diagnostic stay unchanged"),
  exhausted: message<{ machine: string; detail: string; hasDetail: string }>("{machine} is still unavailable.{hasDetail, select, yes { {detail}} other {}}", "Route reconnection attempts exhausted; machine name and optional diagnostic stay unchanged"),
  loadingProjects: message("Loading projects…", "Session area while route projects load"),
  selectSession: message("Select or start a session.", "Session area with a selected workspace but no session"),
  selectWorkspace: message("Select a workspace to start a session.", "Session area with a selected project but no workspace"),
  addProject: message("Add a project to start a session.", "Session area with no projects"),
  selectProject: message("Select a project and workspace to start a session.", "Session area with projects but no selection"),
};
