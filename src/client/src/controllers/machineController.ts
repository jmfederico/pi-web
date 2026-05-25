import { api, type Machine } from "../api";
import { resetWorkspaceScopedState } from "../appState";
import type { GetState, SetState, UpdateUrl } from "./types";
import type { ProjectController } from "./projectController";

export class MachineController {
  constructor(private readonly getState: GetState, private readonly setState: SetState, private readonly updateUrl: UpdateUrl, private readonly projects: ProjectController) {}

  async loadMachines(routeMachineId?: string): Promise<void> {
    this.setState({ error: "", isLoadingMachines: true });
    try {
      const machines = await api.machines();
      const selectedMachine = machines.find((machine) => machine.id === (routeMachineId ?? "local")) ?? machines.find((machine) => machine.id === "local") ?? machines[0];
      this.setState({ machines, selectedMachine });
    } catch (error) {
      this.setState({ error: String(error) });
    } finally {
      this.setState({ isLoadingMachines: false });
    }
  }

  async selectMachine(machine: Machine, options: { updateUrl?: boolean | undefined } = {}): Promise<void> {
    if (this.getState().selectedMachine?.id === machine.id) return;
    this.setState({
      selectedMachine: machine,
      projects: [],
      workspaces: [],
      selectedProject: undefined,
      selectedWorkspace: undefined,
      selectedSession: undefined,
      messages: [],
      messagePageStart: 0,
      messagePageTotal: 0,
      status: undefined,
      activity: undefined,
      ...resetWorkspaceScopedState(),
    });
    if (options.updateUrl !== false) this.updateUrl();
    await this.projects.loadProjects();
  }
}
