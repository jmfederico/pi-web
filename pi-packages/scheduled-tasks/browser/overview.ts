import { ATTENTION_STATUSES } from "../attention.js";
import type { TaskOverview } from "./responses.js";

export function needsAttention(task: TaskOverview): boolean {
  return !task.archived && task.latestExecution !== null && ATTENTION_STATUSES.includes(task.latestExecution.status);
}

function nextDue(task: TaskOverview): number {
  return task.paused || task.nextDue === null ? Infinity : Date.parse(task.nextDue);
}

export function overviewGroups(tasks: TaskOverview[]) {
  const byName = (a: TaskOverview, b: TaskOverview) => a.name.localeCompare(b.name);
  const latestFirst = (a: TaskOverview, b: TaskOverview) =>
    Date.parse(b.latestExecution?.createdAt ?? "") - Date.parse(a.latestExecution?.createdAt ?? "") || byName(a, b);
  return {
    attention: tasks.filter(needsAttention).sort(latestFirst),
    current: tasks.filter((task) => !task.archived && !needsAttention(task)).sort((a, b) => nextDue(a) - nextDue(b) || byName(a, b)),
    archived: tasks.filter((task) => task.archived).sort(byName),
  };
}

/** Preview only the opening line; preserve the original text for the full report. */
export function reportPreview(summary: string): { text: string; truncated: boolean } {
  const report = summary.trim();
  const firstLine = report.split(/\r?\n/, 1)[0] ?? "";
  const characters = Array.from(firstLine);
  const limit = 160;
  const text = characters.length > limit ? characters.slice(0, limit).join("").trimEnd() : firstLine.trimEnd();
  return { text, truncated: text !== report };
}
