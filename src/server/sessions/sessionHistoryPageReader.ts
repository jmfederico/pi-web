import type { FileHandle } from "node:fs/promises";
import type { ClientMessagePage } from "../types.js";
import { historyMessagesFromEntries } from "./transcriptMessages.js";
import { pageMessagesAtSafeBoundary, type MessagePageRequest } from "./messagePaging.js";
import { isRecord, tryParseEntry } from "./sessionFileFormat.js";

const READ_CHUNK_BYTES = 64 * 1024;
const MAX_ENTRY_BYTES = 16 * 1024 * 1024;
const DEFAULT_PAGE_SIZE = 100;
const MAX_SESSION_INDEX_ENTRIES = 250_000;
const MAX_SELECTED_BRANCH_ENTRIES = 10_000;

export interface SessionEntryAccessor {
  getLeafId(): string | null;
  getEntry(id: string): object | undefined;
}

interface IndexedEntry {
  readonly id: string;
  readonly parentId?: string;
  readonly offset: number;
  readonly length: number;
  readonly type: string;
  readonly role?: string;
  readonly display?: boolean;
}

/**
 * Stream-index a Pi JSONL transcript, then read only the active-branch entries
 * needed for one safe-boundary history page. The compact index scales with the
 * number of entries but intentionally omits message bodies; the file remains
 * untouched and the caller controls path authority before invoking this helper.
 */
export async function readSessionHistoryPage(file: FileHandle, page?: MessagePageRequest, signal?: AbortSignal): Promise<ClientMessagePage> {
  const index = new Map<string, IndexedEntry>();
  let leafId: string | undefined;
  let indexedEntryCount = 0;
  await scanLines(file, (line, offset, length) => {
    const entry = tryParseEntry(line.toString("utf8"));
    if (entry === undefined || entry["type"] === "session" || typeof entry["id"] !== "string") return;
    indexedEntryCount += 1;
    if (indexedEntryCount > MAX_SESSION_INDEX_ENTRIES) throw new Error(`Session history exceeds the ${String(MAX_SESSION_INDEX_ENTRIES)} entry inspection limit`);
    const id = entry["id"];
    const parentId = typeof entry["parentId"] === "string" ? entry["parentId"] : undefined;
    const message = entry["message"];
    index.set(id, {
      id, ...(parentId === undefined ? {} : { parentId }), offset, length,
      type: typeof entry["type"] === "string" ? entry["type"] : "",
      ...(isRecord(message) && typeof message["role"] === "string" ? { role: message["role"] } : {}),
      ...(typeof entry["display"] === "boolean" ? { display: entry["display"] } : {}),
    });
    leafId = id;
  }, signal);

  const branch: IndexedEntry[] = [];
  const visited = new Set<string>();
  let currentId = leafId;
  while (currentId !== undefined && !visited.has(currentId)) {
    visited.add(currentId);
    const entry = index.get(currentId);
    if (entry === undefined) break;
    branch.push(entry);
    currentId = entry.parentId;
  }
  branch.reverse();

  const visible = branch.flatMap((entry, branchIndex) => {
    const role = visibleRole(entry);
    return role === undefined ? [] : [{ branchIndex, role }];
  });
  const pageResult = pageMessagesAtSafeBoundary(visible.map(({ role }) => ({ role })), page ?? { limit: DEFAULT_PAGE_SIZE });
  const selected = visible.slice(pageResult.start, pageResult.start + pageResult.messages.length);
  const firstSelected = selected.at(0);
  const lastSelected = selected.at(-1);
  if (firstSelected === undefined || lastSelected === undefined) return { messages: [], start: pageResult.start, total: pageResult.total };

  const first = firstSelected.branchIndex;
  const last = lastSelected.branchIndex;
  let contextIndex: number | undefined;
  for (let branchIndex = first - 1; branchIndex >= 0; branchIndex -= 1) {
    if (branch[branchIndex]?.type === "thinking_level_change") {
      contextIndex = branchIndex;
      break;
    }
  }

  const records = new Map<string, Record<string, unknown>>();
  const selectedBranch = branch.slice(first, last + 1);
  const selectedBytes = selectedBranch.reduce((totalBytes, entry) => totalBytes + entry.length, 0)
    + (contextIndex === undefined ? 0 : branch[contextIndex]?.length ?? 0);
  if (page?.maxBytes !== undefined && selectedBytes > page.maxBytes) throw new Error(`Session history page exceeds ${String(page.maxBytes)} bytes; request a smaller or partial page`);
  const contextEntry = contextIndex === undefined ? undefined : branch[contextIndex];
  const readEntries = contextEntry === undefined ? selectedBranch : [contextEntry, ...selectedBranch];
  for (const entry of readEntries) {
    signal?.throwIfAborted();
    const line = Buffer.alloc(entry.length);
    const { bytesRead } = await file.read(line, 0, entry.length, entry.offset);
    if (bytesRead !== entry.length) throw new Error("Session transcript changed during history read");
    const parsed = tryParseEntry(line.toString("utf8"));
    if (parsed?.["id"] !== entry.id) throw new Error("Session transcript changed during history read");
    records.set(entry.id, parsed);
  }
  const entries = readEntries.flatMap(({ id }) => {
    const entry = records.get(id);
    return entry === undefined ? [] : [entry];
  });
  return { messages: historyMessagesFromEntries(entries), start: pageResult.start, total: pageResult.total };
}

/** Page an already-hosted Pi branch without copying its complete entry array. */
export function pageHostedSessionHistory(manager: SessionEntryAccessor, page?: MessagePageRequest, signal?: AbortSignal): ClientMessagePage {
  const branch: IndexedEntry[] = [];
  const visited = new Set<string>();
  let currentId = manager.getLeafId();
  while (currentId !== null && !visited.has(currentId)) {
    signal?.throwIfAborted();
    if (branch.length >= MAX_SESSION_INDEX_ENTRIES) throw new Error(`Session history exceeds the ${String(MAX_SESSION_INDEX_ENTRIES)} entry inspection limit`);
    visited.add(currentId);
    const entry = manager.getEntry(currentId);
    if (!isRecord(entry) || typeof entry["id"] !== "string") throw new Error("Hosted session history branch is inconsistent");
    const parentId = typeof entry["parentId"] === "string" ? entry["parentId"] : undefined;
    const message = entry["message"];
    branch.push({
      id: entry["id"], ...(parentId === undefined ? {} : { parentId }), offset: 0, length: 0,
      type: typeof entry["type"] === "string" ? entry["type"] : "",
      ...(isRecord(message) && typeof message["role"] === "string" ? { role: message["role"] } : {}),
      ...(typeof entry["display"] === "boolean" ? { display: entry["display"] } : {}),
    });
    currentId = parentId ?? null;
  }
  branch.reverse();

  const visible: { readonly branchIndex: number; readonly role: string }[] = [];
  branch.forEach((entry, branchIndex) => {
    const role = visibleRole(entry);
    if (role !== undefined) visible.push({ branchIndex, role });
  });
  const total = visible.length;
  const before = clampInteger(page?.before ?? total, 0, total);
  const limit = clampInteger(page?.limit ?? DEFAULT_PAGE_SIZE, 1, 500);
  let start = Math.max(0, before - limit);
  if (page?.allowPartialTurn !== true && start > 0 && visible[start]?.role !== "user") {
    let boundary = start - 1;
    while (boundary >= 0 && visible[boundary]?.role !== "user") boundary -= 1;
    start = boundary < 0 ? 0 : boundary;
  }
  const maxMessages = page?.maxMessages;
  if (maxMessages !== undefined && before - start > maxMessages) {
    throw new Error(`Session history turn exceeds the ${String(maxMessages)} message page limit; request a partial turn to inspect it`);
  }
  const selected = visible.slice(start, before);
  const first = selected.at(0);
  const last = selected.at(-1);
  if (first === undefined || last === undefined) return { messages: [], start, total };

  let contextIndex: number | undefined;
  for (let index = first.branchIndex - 1; index >= 0; index -= 1) {
    if (branch[index]?.type === "thinking_level_change") { contextIndex = index; break; }
  }
  const selectedStart = contextIndex ?? first.branchIndex;
  if (last.branchIndex - selectedStart + 1 > MAX_SELECTED_BRANCH_ENTRIES) {
    throw new Error(`Session history page exceeds the ${String(MAX_SELECTED_BRANCH_ENTRIES)} entry inspection limit`);
  }
  const entries: unknown[] = [];
  let selectedBytes = 0;
  for (let index = selectedStart; index <= last.branchIndex; index += 1) {
    signal?.throwIfAborted();
    const id = branch[index]?.id;
    if (id === undefined) continue;
    const entry = manager.getEntry(id);
    if (entry === undefined) throw new Error("Hosted session history entry disappeared during inspection");
    selectedBytes += Buffer.byteLength(JSON.stringify(entry));
    if (page?.maxBytes !== undefined && selectedBytes > page.maxBytes) {
      throw new Error(`Session history page exceeds ${String(page.maxBytes)} bytes; request a smaller or partial page`);
    }
    entries.push(entry);
  }
  const messages = historyMessagesFromEntries(entries);
  if (page?.maxBytes !== undefined && Buffer.byteLength(JSON.stringify(messages)) > page.maxBytes) {
    throw new Error(`Session history page exceeds ${String(page.maxBytes)} bytes; request a smaller or partial page`);
  }
  return { messages, start, total };
}

function visibleRole(entry: IndexedEntry): string | undefined {
  if (entry.type === "message") return entry.role ?? "";
  if (entry.type === "custom_message" && entry.display === true) return "custom";
  if (entry.type === "compaction" || entry.type === "branch_summary") return "system";
  return undefined;
}

async function scanLines(file: FileHandle, visit: (line: Buffer, offset: number, length: number) => void, signal?: AbortSignal): Promise<void> {
  const chunk = Buffer.alloc(READ_CHUNK_BYTES);
  let position = 0;
  let lineOffset = 0;
  let pending: Buffer[] = [];
  let pendingLength = 0;

  for (;;) {
    signal?.throwIfAborted();
    const { bytesRead } = await file.read(chunk, 0, chunk.length, position);
    if (bytesRead === 0) break;
    position += bytesRead;
    let start = 0;
    while (start < bytesRead) {
      const newline = chunk.indexOf(0x0a, start);
      if (newline < 0 || newline >= bytesRead) {
        const tail = chunk.subarray(start, bytesRead);
        if (tail.length > 0) {
          pending.push(Buffer.from(tail));
          pendingLength += tail.length;
          assertEntryLength(pendingLength);
        }
        break;
      }
      const fragment = chunk.subarray(start, newline);
      const length = pendingLength + fragment.length;
      assertEntryLength(length);
      const line = pending.length === 0 ? fragment : Buffer.concat([...pending, fragment], length);
      signal?.throwIfAborted();
      visit(line, lineOffset, length);
      lineOffset += length + 1;
      pending = [];
      pendingLength = 0;
      start = newline + 1;
    }
  }
  if (pendingLength > 0) {
    const line = pending.length === 1 ? (pending[0] ?? Buffer.alloc(0)) : Buffer.concat(pending, pendingLength);
    visit(line, lineOffset, pendingLength);
  }
}

function assertEntryLength(length: number): void {
  if (length > MAX_ENTRY_BYTES) throw new Error(`Session transcript entry exceeds ${String(MAX_ENTRY_BYTES)} bytes`);
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return max;
  return Math.max(min, Math.min(max, Math.floor(value)));
}
