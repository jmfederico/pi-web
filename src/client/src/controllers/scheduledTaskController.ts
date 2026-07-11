import { api, type ScheduledTask, type ScheduledTaskCreateRequest, type ScheduledTaskRun } from "../api";
import { selectedMachineId, type GetState, type SetState } from "./types";

/**
 * Owns the client's copy of scheduled tasks. Fetches the whole (machine-wide)
 * list once and re-fetches after mutations — simpler than mirroring the
 * per-selection fetch machinery `WorkspaceController`/`SessionController` use,
 * and the task count here is small enough that a full refetch is cheap.
 */
export class ScheduledTaskController {
  constructor(private readonly getState: GetState, private readonly setState: SetState) {}

  async loadScheduledTasks(): Promise<void> {
    const machineId = selectedMachineId(this.getState());
    this.setState({ isLoadingScheduledTasks: true });
    try {
      const scheduledTasks = await api.scheduledTasks(machineId);
      if (selectedMachineId(this.getState()) !== machineId) return;
      this.setState({ scheduledTasks });
    } catch (error) {
      if (selectedMachineId(this.getState()) === machineId) this.setState({ error: String(error) });
    } finally {
      if (selectedMachineId(this.getState()) === machineId) this.setState({ isLoadingScheduledTasks: false });
    }
  }

  openNewDialog(): void {
    this.setState({ scheduledTaskDialog: {} });
  }

  openEditDialog(task: ScheduledTask): void {
    this.setState({ scheduledTaskDialog: { task } });
  }

  closeDialog(): void {
    this.setState({ scheduledTaskDialog: undefined });
  }

  async save(input: ScheduledTaskCreateRequest): Promise<void> {
    const machineId = selectedMachineId(this.getState());
    const editing = this.getState().scheduledTaskDialog?.task;
    try {
      if (editing === undefined) await api.createScheduledTask(input, machineId);
      else await api.updateScheduledTask(editing.id, input, machineId);
      this.setState({ scheduledTaskDialog: undefined });
      await this.loadScheduledTasks();
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  async toggleEnabled(task: ScheduledTask): Promise<void> {
    try {
      await api.updateScheduledTask(task.id, { enabled: !task.enabled }, selectedMachineId(this.getState()));
      await this.loadScheduledTasks();
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  async remove(task: ScheduledTask): Promise<void> {
    try {
      await api.deleteScheduledTask(task.id, selectedMachineId(this.getState()));
      await this.loadScheduledTasks();
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  async runNow(task: ScheduledTask): Promise<void> {
    try {
      await api.runScheduledTaskNow(task.id, selectedMachineId(this.getState()));
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  async openHistory(task: ScheduledTask): Promise<void> {
    this.setState({ scheduledTaskHistoryDialog: { taskId: task.id, taskName: task.name, runs: [] } });
    try {
      const runs: ScheduledTaskRun[] = await api.scheduledTaskRuns(task.id, selectedMachineId(this.getState()));
      if (this.getState().scheduledTaskHistoryDialog?.taskId !== task.id) return;
      this.setState({ scheduledTaskHistoryDialog: { taskId: task.id, taskName: task.name, runs } });
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  closeHistory(): void {
    this.setState({ scheduledTaskHistoryDialog: undefined });
  }
}
