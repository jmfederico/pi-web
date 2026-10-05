import type { ChatLine, ChatPart, ToolExecutionPart } from "./components/shared";

const MAX_STATUS_TEXT_LENGTH = 500;
const MAX_RESULT_TEXT_LENGTH = 4_000;
const MAX_FIELD_TEXT_LENGTH = 500;

export type BallastPressureLevel = "watch" | "warn" | "critical";
export type BallastToolName = "ballast_status" | "ballast_consumers" | "ballast_plan" | "ballast_relieve";

export interface BallastCurrentStatus {
  text: string;
  level?: BallastPressureLevel;
}

export interface BallastEvidenceField {
  label: string;
  value: string;
}

export interface BallastToolEvidence {
  toolName: BallastToolName;
  text: string;
  isError: boolean;
  fields: BallastEvidenceField[];
}

export function ballastCurrentStatus(statusText: string | undefined): BallastCurrentStatus | undefined {
  if (statusText === undefined || statusText.trim() === "") return undefined;
  const text = truncate(statusText, MAX_STATUS_TEXT_LENGTH);
  const match = /^ballast:\s+(watch|warn|critical)\b/iu.exec(statusText);
  const level = match?.[1]?.toLowerCase();
  if (level === "watch" || level === "warn" || level === "critical") return { text, level };
  return { text };
}

/** Selects only completed Ballast tool output from the supplied session messages. */
export function latestBallastToolEvidence(messages: readonly ChatLine[]): BallastToolEvidence | undefined {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
    const parts = messages[messageIndex]?.parts;
    if (parts === undefined) continue;
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex--) {
      const evidence = evidenceFromPart(parts[partIndex]);
      if (evidence !== undefined) return evidence;
    }
  }
  return undefined;
}

function evidenceFromPart(part: ChatPart | undefined): BallastToolEvidence | undefined {
  if (part === undefined) return undefined;
  if (part.type === "toolResult") {
    if (!isBallastToolName(part.toolName)) return undefined;
    return makeEvidence(part.toolName, part.text, part.details, part.isError);
  }
  if (part.type !== "toolExecution" || !isBallastToolName(part.toolName) || !isCompleted(part)) return undefined;
  return makeEvidence(part.toolName, part.resultText ?? "", part.details, part.status === "error");
}

function isCompleted(part: ToolExecutionPart): boolean {
  return part.status === "success" || part.status === "error";
}

function makeEvidence(toolName: BallastToolName, text: string, details: unknown, isError: boolean): BallastToolEvidence | undefined {
  const fields = evidenceFields(toolName, details);
  if (text === "" && fields.length === 0) return undefined;
  return { toolName, text: truncate(text, MAX_RESULT_TEXT_LENGTH), isError, fields };
}

function evidenceFields(toolName: BallastToolName, details: unknown): BallastEvidenceField[] {
  switch (toolName) {
    case "ballast_status": {
      const fields: BallastEvidenceField[] = [];
      const level = ownString(details, "level");
      if (level === "ok" || level === "watch" || level === "warn" || level === "critical") {
        fields.push({ label: "Reported pressure level", value: level });
      }
      const reason = ownString(details, "reason");
      if (reason !== undefined && reason !== "") fields.push({ label: "Reported reason", value: truncate(reason, MAX_FIELD_TEXT_LENGTH) });
      return fields;
    }
    case "ballast_plan":
      return numericFields(details, [
        ["safeBytes", "Reported safe plan bytes"],
        ["disruptiveBytes", "Reported disruptive plan bytes"],
      ]);
    case "ballast_relieve":
      return numericFields(details, [["bytesFreed", "Reported bytes freed"]]);
    case "ballast_consumers":
      return [];
  }
}

function numericFields(details: unknown, keys: readonly [string, string][]): BallastEvidenceField[] {
  const fields: BallastEvidenceField[] = [];
  for (const [key, label] of keys) {
    const value = ownValue(details, key);
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      fields.push({ label, value: `${String(value)} bytes` });
    }
  }
  return fields;
}

function isBallastToolName(value: string): value is BallastToolName {
  return value === "ballast_status"
    || value === "ballast_consumers"
    || value === "ballast_plan"
    || value === "ballast_relieve";
}

function ownString(value: unknown, key: string): string | undefined {
  const property = ownValue(value, key);
  return typeof property === "string" ? property : undefined;
}

function ownValue(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}… [truncated]`;
}
