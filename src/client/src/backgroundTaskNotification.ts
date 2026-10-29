export interface BackgroundTaskPresentation {
  kind: "backgroundTask";
  id: string;
  name: string;
  status: "running" | "completed" | "failed" | "killed";
  outputPath?: string;
  exitCode?: number | null;
  error?: string;
}

/** Only the extension's structured custom message can opt into task rendering. */
export function backgroundTaskPresentation(message: unknown): BackgroundTaskPresentation | undefined {
  if (!isRecord(message) || message["role"] !== "custom" || message["customType"] !== "background-task-notification") return undefined;
  const details = message["details"];
  if (!isRecord(details)) return undefined;
  const id = details["id"];
  const status = details["status"];
  if (typeof id !== "string" || id.trim() === "" || (status !== "running" && status !== "completed" && status !== "failed" && status !== "killed")) return undefined;
  const exitCode = details["exitCode"];
  if (exitCode !== undefined && exitCode !== null && (typeof exitCode !== "number" || !Number.isSafeInteger(exitCode))) return undefined;
  const name = nonemptyString(details["name"]) ?? nonemptyString(details["command"]) ?? id;
  const outputPath = nonemptyString(details["outputPath"]);
  const error = nonemptyString(details["error"]);
  return {
    kind: "backgroundTask", id, name, status,
    ...(outputPath === undefined ? {} : { outputPath }),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(error === undefined ? {} : { error }),
  };
}

export function backgroundTaskTone(task: BackgroundTaskPresentation): "success" | "danger" | "warning" {
  if (task.status === "failed" || (typeof task.exitCode === "number" && task.exitCode !== 0) || task.error !== undefined) return "danger";
  return task.status === "completed" ? "success" : "warning";
}

function nonemptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
