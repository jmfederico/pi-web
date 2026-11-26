import type { SessionTreeNode, SessionTreeNodeKind, SessionTreeSnapshot, SessionTreeSummaryField, SessionTreeSummaryPart, SessionTreeSummaryPresentation, SessionTreeSummaryStatus } from "../../shared/apiTypes.js";

const SUMMARY_MAX_LENGTH = 360;
const SUMMARY_SOURCE_MAX_LENGTH = SUMMARY_MAX_LENGTH * 2;
const LABEL_MAX_LENGTH = 160;
const NAMED_FIELD_MAX_LENGTH = 80;
const TIMESTAMP_MAX_LENGTH = 80;

/** Narrow structural view of the tree returned by Pi's SessionManager.getTree(). */
export interface ProjectableSessionTreeNode {
  readonly entry: unknown;
  readonly children: readonly ProjectableSessionTreeNode[];
  readonly label?: unknown;
}

interface ProjectableSessionEntry extends Record<string, unknown> {
  id: string;
  parentId: string | null;
  type: string;
}

interface EntryProjection {
  kind: SessionTreeNodeKind;
  presentation: SessionTreeSummaryPresentation;
}

/**
 * Project Pi's complete append-only session tree into the strict browser contract.
 * Only explicitly selected plain-text fields leave this boundary.
 */
export function projectSessionTree(
  roots: readonly ProjectableSessionTreeNode[],
  activeLeafId: string | null,
): SessionTreeSnapshot {
  const nodes: SessionTreeNode[] = [];
  const projectedIds = new Set<string>();
  const stack = [...roots].reverse();
  const visitedNodes = new WeakSet<ProjectableSessionTreeNode>();

  while (stack.length > 0) {
    const candidate = stack.pop();
    if (candidate === undefined) continue;
    if (!isProjectableSessionTreeNode(candidate)) throw new Error("Pi returned a malformed session-tree node");
    const node = candidate;
    if (visitedNodes.has(node)) continue;
    visitedNodes.add(node);

    if (!isProjectableSessionEntry(node.entry)) {
      throw new Error("Pi returned a malformed session-tree entry");
    }
    if (projectedIds.has(node.entry.id)) throw new Error("Pi returned duplicate session-tree entry IDs");
    projectedIds.add(node.entry.id);
    nodes.push(projectNode(node, node.entry));

    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const child = node.children[index];
      if (child !== undefined) stack.push(child);
    }
  }

  if (activeLeafId !== null && (activeLeafId.trim() === "" || !projectedIds.has(activeLeafId))) {
    throw new Error("Pi returned an invalid active session-tree leaf");
  }

  return {
    nodes,
    activeLeafId,
    activePathIds: buildActivePath(nodes, activeLeafId),
  };
}

function projectNode(node: ProjectableSessionTreeNode, entry: ProjectableSessionEntry): SessionTreeNode {
  const projection = projectEntry(entry);
  const timestamp = optionalPlainText(entry["timestamp"], TIMESTAMP_MAX_LENGTH);
  const label = optionalPlainText(node.label, LABEL_MAX_LENGTH);
  return {
    id: entry.id,
    parentId: entry.parentId,
    kind: projection.kind,
    summary: englishSummary(projection.presentation),
    summaryPresentation: projection.presentation,
    ...(timestamp === undefined ? {} : { timestamp }),
    ...(label === undefined ? {} : { label }),
  };
}

function projectEntry(entry: ProjectableSessionEntry): EntryProjection {
  switch (entry.type) {
    case "message": return projectMessage(entry["message"]);
    case "custom_message": return projectCustomMessage(entry);
    case "compaction": return contentProjection("compaction", entry["summary"], "compaction-summary");
    case "branch_summary": return contentProjection("branch-summary", entry["summary"], "branch-summary");
    case "model_change": {
      const provider = optionalPlainText(entry["provider"], NAMED_FIELD_MAX_LENGTH);
      const model = optionalPlainText(entry["modelId"], NAMED_FIELD_MAX_LENGTH);
      return namedProjection("model-change", "model", provider !== undefined && model !== undefined ? `${provider}/${model}` : model ?? provider);
    }
    case "thinking_level_change": return namedProjection("thinking-level-change", "thinking-level", entry["thinkingLevel"]);
    case "session_info": return namedProjection("session-info", "session-name", entry["name"]);
    case "label": return namedProjection("label", "label", entry["label"]);
    case "custom": return namedProjection("custom", "custom-entry", entry["customType"]);
    default: return namedProjection("other", "entry", entry.type);
  }
}

function projectMessage(value: unknown): EntryProjection {
  if (!isRecord(value)) return statusProjection("other", "message");
  switch (value["role"]) {
    case "user": return contentProjection("user", value["content"], "user-message");
    case "assistant": {
      const parts = contentParts(value["content"], false);
      if (parts.length > 0) return { kind: "assistant", presentation: { type: "content", parts, fallback: "assistant-response" } };
      const names = assistantToolNames(value["content"]);
      if (names.length > 0) return { kind: "assistant", presentation: { type: "assistant-tools", names } };
      return statusProjection("assistant", value["stopReason"] === "error" ? "assistant-error" : value["stopReason"] === "aborted" ? "assistant-aborted" : "assistant-response");
    }
    case "toolResult": {
      const toolName = optionalPlainText(value["toolName"], NAMED_FIELD_MAX_LENGTH);
      return { kind: "tool-result", presentation: {
        type: "tool-result", isError: value["isError"] === true,
        ...(toolName === undefined ? {} : { toolName }), parts: contentParts(value["content"], true),
      } };
    }
    case "bashExecution": return namedProjection("bash", "shell", value["command"]);
    case "custom": return projectCustomMessage(value);
    case "compactionSummary": return contentProjection("compaction", value["summary"], "compaction-summary");
    case "branchSummary": return contentProjection("branch-summary", value["summary"], "branch-summary");
    default: return statusProjection("other", "message");
  }
}

function projectCustomMessage(value: Record<string, unknown>): EntryProjection {
  if (value["display"] !== true) return statusProjection("custom-message", "hidden-custom-message");
  const customType = optionalPlainText(value["customType"], NAMED_FIELD_MAX_LENGTH);
  return { kind: "custom-message", presentation: {
    type: "custom-message", ...(customType === undefined ? {} : { customType }), parts: contentParts(value["content"], true),
  } };
}

function statusProjection(kind: SessionTreeNodeKind, status: SessionTreeSummaryStatus): EntryProjection {
  return { kind, presentation: { type: "status", status } };
}

function contentProjection(kind: SessionTreeNodeKind, content: unknown, fallback: SessionTreeSummaryStatus): EntryProjection {
  return { kind, presentation: { type: "content", parts: contentParts(content, true), fallback } };
}

function namedProjection(kind: SessionTreeNodeKind, field: SessionTreeSummaryField, raw: unknown): EntryProjection {
  // A combined provider/model value is already independently bounded.
  const value = optionalPlainText(raw, field === "model" ? NAMED_FIELD_MAX_LENGTH * 2 + 1 : NAMED_FIELD_MAX_LENGTH);
  return { kind, presentation: { type: "named", field, ...(value === undefined ? {} : { value }) } };
}

function assistantToolNames(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const names: string[] = [];
  for (const part of content) {
    if (!isRecord(part) || part["type"] !== "toolCall") continue;
    const name = optionalPlainText(part["name"], NAMED_FIELD_MAX_LENGTH);
    if (name !== undefined && !names.includes(name)) names.push(name);
    if (names.length === 3) break;
  }
  return names;
}

/** Bound both text and part count before transport; never retain SDK payloads. */
function contentParts(content: unknown, includeImages: boolean): SessionTreeSummaryPart[] {
  const parts: SessionTreeSummaryPart[] = [];
  let remaining = SUMMARY_SOURCE_MAX_LENGTH;
  const appendText = (raw: string): void => {
    const text = plainText(raw.slice(0, remaining));
    remaining -= Math.min(raw.length, remaining);
    if (text !== "") parts.push({ type: "text", text });
  };
  if (typeof content === "string") appendText(content);
  else if (Array.isArray(content)) {
    for (const part of content) {
      if (remaining <= 0) break;
      if (!isRecord(part)) continue;
      if (part["type"] === "text" && typeof part["text"] === "string") appendText(part["text"]);
      else if (includeImages && part["type"] === "image") {
        parts.push({ type: "image" });
        remaining -= "[image]".length;
      }
    }
  }
  return parts;
}

// Compatibility only: new clients render the semantic presentation in their locale.
function englishSummary(presentation: SessionTreeSummaryPresentation): string {
  const content = (parts: SessionTreeSummaryPart[]): string => parts.map((part) => part.type === "text" ? part.text : "[image]").join(" ");
  const statuses: Record<SessionTreeSummaryStatus, string> = {
    message: "Message", "user-message": "User message", "assistant-response": "Assistant response",
    "assistant-error": "Assistant error", "assistant-aborted": "Assistant response aborted",
    "hidden-custom-message": "Hidden custom message", "compaction-summary": "Compaction summary", "branch-summary": "Branch summary",
  };
  const fields: Record<SessionTreeSummaryField, [string, string]> = {
    shell: ["Shell", "Shell command"], model: ["Model", "Model changed"],
    "thinking-level": ["Thinking level", "Thinking level changed"], "session-name": ["Session name", "Session info changed"],
    label: ["Label", "Label removed"], "custom-entry": ["Custom entry", "Custom entry"], entry: ["Entry", "Other session entry"],
  };
  switch (presentation.type) {
    case "status": return statuses[presentation.status];
    case "content": return summary(content(presentation.parts), statuses[presentation.fallback]);
    case "named": {
      const [prefix, fallback] = fields[presentation.field];
      return presentation.value === undefined ? fallback : summary(`${prefix}: ${presentation.value}`, fallback);
    }
    case "assistant-tools": return summary(`Tool call: ${presentation.names.join(", ")}`, "Assistant tool call");
    case "tool-result":
    case "custom-message": {
      const name = presentation.type === "tool-result" ? presentation.toolName : presentation.customType;
      const label = presentation.type === "tool-result" ? presentation.isError ? "Tool error" : "Tool result" : "Custom message";
      const prefix = name === undefined ? label : `${label} (${name})`;
      const text = content(presentation.parts);
      return summary(text === "" ? prefix : `${prefix}: ${text}`, prefix);
    }
  }
}

function summary(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const normalized = plainText(value);
  return normalized === "" ? fallback : truncate(normalized, SUMMARY_MAX_LENGTH);
}

function optionalPlainText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = plainText(value);
  return normalized === "" ? undefined : truncate(normalized, maxLength);
}

function plainText(value: string): string {
  // Browser previews should not retain non-whitespace C0/C1 controls.
  // oxlint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").replace(/\s+/gu, " ").trim();
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  let end = maxLength - 1;
  const finalCodeUnit = value.charCodeAt(end - 1);
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) end -= 1;
  return `${value.slice(0, end)}…`;
}

function buildActivePath(nodes: readonly SessionTreeNode[], activeLeafId: string | null): string[] {
  if (activeLeafId === null) return [];
  const byId = new Map<string, SessionTreeNode>();
  for (const node of nodes) {
    if (!byId.has(node.id)) byId.set(node.id, node);
  }

  const path: string[] = [];
  const visitedIds = new Set<string>();
  let currentId: string | null = activeLeafId;
  while (currentId !== null && !visitedIds.has(currentId)) {
    const node = byId.get(currentId);
    if (node === undefined) break;
    visitedIds.add(currentId);
    path.push(currentId);
    currentId = node.parentId;
  }
  path.reverse();
  return path;
}

function isProjectableSessionTreeNode(value: unknown): value is ProjectableSessionTreeNode {
  return isRecord(value) && Array.isArray(value["children"]);
}

function isProjectableSessionEntry(value: unknown): value is ProjectableSessionEntry {
  return isRecord(value)
    && typeof value["id"] === "string"
    && value["id"].trim() !== ""
    && (value["parentId"] === null || (typeof value["parentId"] === "string" && value["parentId"].trim() !== ""))
    && typeof value["type"] === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
