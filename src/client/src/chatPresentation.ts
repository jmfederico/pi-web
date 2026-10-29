import type { BackgroundTaskPresentation } from "./backgroundTaskNotification";
import type { CommandResultPresentation } from "../../shared/commandResultPresentation";
import type { CommandOutputPresentation } from "../../shared/commandOutputPresentation";

/** Generated prose keeps provenance separate from source/model text. */
export type ChatTextPresentation =
  | CommandOutputPresentation
  | CommandResultPresentation
  | BackgroundTaskPresentation
  | { kind: "modelError"; detail: string }
  | { kind: "imagePlaceholder" }
  | ArgumentSummaryPresentation
  | { kind: "bash"; command: string; output?: string; exitCode?: string; excluded: boolean; cancelled: boolean; truncated: boolean; fullOutputPath?: string }
  | LiveShellPresentation;

/** Live output remains separate from generated completion notes and their English fallback. */
export interface LiveShellPresentation {
  kind: "liveShell";
  command: string;
  excluded: boolean;
  output?: string;
  completion?: {
    noOutput: boolean;
    failed: boolean;
    failureOutput?: string;
    exitCode?: string;
    cancelled: boolean;
    truncated: boolean;
    fullOutputPath?: string;
  };
}

export interface ArgumentSummaryPresentation { kind: "arguments"; args: unknown }

export interface ArgumentSummaryLabels {
  replacement: () => string;
  edits: (count: number) => string;
  items: (count: number) => string;
  object: () => string;
}

const englishLabels: ArgumentSummaryLabels = {
  replacement: () => "edit text replacement",
  edits: (count) => `${String(count)} edit${count === 1 ? "" : "s"}`,
  items: (count) => `${String(count)} item${count === 1 ? "" : "s"}`,
  object: () => "object",
};

export function argumentSummaryPresentation(args: unknown): { summaryPresentation?: ArgumentSummaryPresentation } {
  if (!isRecord(args) || typeof args["command"] === "string" || typeof args["path"] === "string") return {};
  return { summaryPresentation: { kind: "arguments", args } };
}

export function summarizeArgs(args: unknown, labels: ArgumentSummaryLabels = englishLabels): string {
  if (!isRecord(args)) return stringifyPrimitive(args);
  const command = args["command"];
  if (typeof command === "string") return command;
  const path = args["path"];
  if (typeof path === "string") return path;
  if (typeof args["oldText"] === "string" && typeof args["newText"] === "string") return labels.replacement();
  const edits = args["edits"];
  if (Array.isArray(edits)) return labels.edits(edits.length);
  const entries = Object.entries(args).filter(([, value]) => value != null).slice(0, 3);
  return entries.map(([key, value]) => `${key}: ${shortValue(value, labels)}`).join(" · ");
}

function shortValue(value: unknown, labels: ArgumentSummaryLabels): string {
  if (typeof value === "string") return value.length > 80 ? `${value.slice(0, 77)}…` : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return labels.items(value.length);
  if (typeof value === "object" && value !== null) return labels.object();
  return "";
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function stringifyPrimitive(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return "";
}
