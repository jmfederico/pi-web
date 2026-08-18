import type { SessionTreeNode, SessionTreeNodeKind, SessionTreeSnapshot } from "../../shared/apiTypes.js";

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
  summary: string;
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
    summary: projection.summary,
    ...(timestamp === undefined ? {} : { timestamp }),
    ...(label === undefined ? {} : { label }),
  };
}

function projectEntry(entry: ProjectableSessionEntry): EntryProjection {
  switch (entry.type) {
    case "message":
      return projectMessage(entry["message"]);
    case "custom_message":
      return projectCustomMessage(entry);
    case "compaction":
      return { kind: "compaction", summary: summary(entry["summary"], "Compaction summary") };
    case "branch_summary":
      return { kind: "branch-summary", summary: summary(entry["summary"], "Branch summary") };
    case "model_change":
      return { kind: "model-change", summary: modelChangeSummary(entry) };
    case "thinking_level_change":
      return { kind: "thinking-level-change", summary: namedSummary("Thinking level", entry["thinkingLevel"], "Thinking level changed") };
    case "session_info":
      return { kind: "session-info", summary: namedSummary("Session name", entry["name"], "Session info changed") };
    case "label":
      return { kind: "label", summary: namedSummary("Label", entry["label"], "Label removed") };
    case "custom":
      return { kind: "custom", summary: namedSummary("Custom entry", entry["customType"], "Custom entry") };
    default:
      return { kind: "other", summary: namedSummary("Entry", entry.type, "Other session entry") };
  }
}

function projectMessage(value: unknown): EntryProjection {
  if (!isRecord(value)) return { kind: "other", summary: "Message" };
  switch (value["role"]) {
    case "user":
      return { kind: "user", summary: summary(contentPreview(value["content"], true), "User message") };
    case "assistant":
      return { kind: "assistant", summary: assistantSummary(value) };
    case "toolResult":
      return { kind: "tool-result", summary: toolResultSummary(value) };
    case "bashExecution":
      return { kind: "bash", summary: namedSummary("Shell", value["command"], "Shell command") };
    case "custom":
      return projectCustomMessage(value);
    case "compactionSummary":
      return { kind: "compaction", summary: summary(value["summary"], "Compaction summary") };
    case "branchSummary":
      return { kind: "branch-summary", summary: summary(value["summary"], "Branch summary") };
    default:
      return { kind: "other", summary: "Message" };
  }
}

function projectCustomMessage(value: Record<string, unknown>): EntryProjection {
  if (value["display"] !== true) return { kind: "custom-message", summary: "Hidden custom message" };
  const customType = optionalPlainText(value["customType"], NAMED_FIELD_MAX_LENGTH);
  const content = contentPreview(value["content"], true);
  const prefix = customType === undefined ? "Custom message" : `Custom message (${customType})`;
  return { kind: "custom-message", summary: summary(content === "" ? prefix : `${prefix}: ${content}`, prefix) };
}

function assistantSummary(message: Record<string, unknown>): string {
  const text = contentPreview(message["content"], false);
  if (text !== "") return summary(text, "Assistant response");

  const toolNames = assistantToolNames(message["content"]);
  if (toolNames.length > 0) return summary(`Tool call: ${toolNames.join(", ")}`, "Assistant tool call");
  if (message["stopReason"] === "error") return "Assistant error";
  if (message["stopReason"] === "aborted") return "Assistant response aborted";
  return "Assistant response";
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

function toolResultSummary(message: Record<string, unknown>): string {
  const isError = message["isError"] === true;
  const toolName = optionalPlainText(message["toolName"], NAMED_FIELD_MAX_LENGTH);
  const prefix = toolName === undefined
    ? isError ? "Tool error" : "Tool result"
    : `${isError ? "Tool error" : "Tool result"} (${toolName})`;
  const content = contentPreview(message["content"], true);
  return summary(content === "" ? prefix : `${prefix}: ${content}`, prefix);
}

function modelChangeSummary(entry: Record<string, unknown>): string {
  const provider = optionalPlainText(entry["provider"], NAMED_FIELD_MAX_LENGTH);
  const modelId = optionalPlainText(entry["modelId"], NAMED_FIELD_MAX_LENGTH);
  if (provider !== undefined && modelId !== undefined) return summary(`Model: ${provider}/${modelId}`, "Model changed");
  return namedSummary("Model", modelId ?? provider, "Model changed");
}

function contentPreview(content: unknown, includeImageMarkers: boolean): string {
  const fragments: string[] = [];
  let remaining = SUMMARY_SOURCE_MAX_LENGTH;
  const append = (text: string): void => {
    if (remaining <= 0 || text === "") return;
    const fragment = text.slice(0, remaining);
    fragments.push(fragment);
    remaining -= fragment.length;
  };

  if (typeof content === "string") {
    append(content);
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (!isRecord(part)) continue;
      if (part["type"] === "text" && typeof part["text"] === "string") append(part["text"]);
      else if (includeImageMarkers && part["type"] === "image") append("[image]");
      if (remaining <= 0) break;
    }
  }
  return plainText(fragments.join(" "));
}

function namedSummary(prefix: string, value: unknown, fallback: string): string {
  const field = optionalPlainText(value, NAMED_FIELD_MAX_LENGTH);
  return field === undefined ? fallback : summary(`${prefix}: ${field}`, fallback);
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
  // eslint-disable-next-line no-control-regex
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
