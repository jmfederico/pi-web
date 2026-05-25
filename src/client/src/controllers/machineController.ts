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
      void this.refreshMachineHealthFor(machines);
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
      sessionStatuses: {},
      sessionActivities: {},
      workspaceActivities: {},
      workspacesByProjectId: {},
      ...resetWorkspaceScopedState(),
    });
    if (options.updateUrl !== false) this.updateUrl();
    await this.projects.loadProjects();
    void this.refreshMachineHealth(machine.id);
  }

  async addMachine(input: { name: string; baseUrl: string; token?: string }): Promise<void> {
    this.setState({ error: "" });
    try {
      const machine = await api.addMachine(input);
      this.setState({ machines: [...this.getState().machines.filter((candidate) => candidate.id !== machine.id), machine] });
      await this.selectMachine(machine);
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  async deleteMachine(machine: Machine | undefined = this.getState().selectedMachine): Promise<void> {
    if (machine === undefined) return;
    if (machine.kind === "local") {
      this.setState({ error: "The local machine cannot be removed." });
      return;
    }
    try {
      await api.deleteMachine(machine.id);
      const machines = this.getState().machines.filter((candidate) => candidate.id !== machine.id);
      const local = machines.find((candidate) => candidate.id === "local") ?? machines[0];
      this.setState({ machines, machineStatuses: omitKey(this.getState().machineStatuses, machine.id) });
      if (this.getState().selectedMachine?.id === machine.id && local !== undefined) await this.selectMachine(local);
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  async refreshMachineHealth(machineId = this.getState().selectedMachine?.id ?? "local"): Promise<void> {
    try {
      const health = await api.health(machineId);
      this.setState({ machineStatuses: { ...this.getState().machineStatuses, [health.machineId]: health } });
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  private async refreshMachineHealthFor(machines: Machine[]): Promise<void> {
    const results = await Promise.allSettled(machines.map((machine) => api.health(machine.id)));
    const health = Object.fromEntries(results.flatMap((result) => result.status === "fulfilled" ? [[result.value.machineId, result.value] as const] : []));
    if (Object.keys(health).length > 0) this.setState({ machineStatuses: { ...this.getState().machineStatuses, ...health } });
  }
}

function omitKey<T>(record: Record<string, T>, keyToOmit: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => key !== keyToOmit));
}
