import type { TaskOverview } from "./responses.js";

export function needsAttention(task: TaskOverview): boolean {
  return task.latestExecution !== null && ["failed", "errored", "uncertain"].includes(task.latestExecution.status);
}

/** Only explicit reports establish outcomes; session activity is not a task status. */
export function overviewGroups(tasks: TaskOverview[]) {
  const current = tasks.filter((task) => !task.archived);
  const latestFirst = (a: TaskOverview, b: TaskOverview) => Date.parse(b.latestExecution?.createdAt ?? "1970-01-01") - Date.parse(a.latestExecution?.createdAt ?? "1970-01-01");
  return {
    attention: current.filter(needsAttention).sort(latestFirst),
    awaiting: current.filter((task) => task.latestExecution?.status === "dispatched" || task.latestExecution?.status === "dispatching").sort(latestFirst),
    recent: current.filter((task) => task.latestExecution?.status === "completed").sort(latestFirst).slice(0, 5),
    upcoming: current.filter((task) => !task.paused && task.nextDue !== null).sort((a, b) => Date.parse(a.nextDue ?? "") - Date.parse(b.nextDue ?? "")).slice(0, 5),
  };
}
