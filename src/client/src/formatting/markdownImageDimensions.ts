import { validImageDimensions, type ImageDimensions } from "../../../shared/sessionMedia";

const storageKey = "pi-web:markdown-image-dimensions:v1";
const maxRecords = 128;
type DimensionStorage = Pick<Storage, "getItem" | "setItem">;
interface DimensionRecord extends ImageDimensions { source: string }

function browserStorage(): DimensionStorage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    // Privacy settings can throw even when accessing the localStorage getter.
    return undefined;
  }
}

/**
 * Geometry hints keyed by the caller's full resolved URL, including machine,
 * workspace and query. Reads neither refresh recency nor expire hints.
 * Missing, corrupt or unreadable storage is a cache miss, never a render error.
 */
export function readMarkdownImageDimensions(source: string, storage = browserStorage()): ImageDimensions | undefined {
  const record = loadRecords(storage).find((candidate) => candidate.source === source);
  return record === undefined ? undefined : { width: record.width, height: record.height };
}

/** Best-effort hint write: refresh recency even for unchanged dimensions; keep the newest 128 URLs. */
export function rememberMarkdownImageDimensions(source: string, dimensions: ImageDimensions, storage = browserStorage()): void {
  const valid = validImageDimensions(dimensions.width, dimensions.height);
  if (source === "" || valid === undefined) return;
  const records = loadRecords(storage).filter((candidate) => candidate.source !== source);
  records.push({ source, ...valid });
  try {
    storage?.setItem(storageKey, JSON.stringify(records.slice(-maxRecords)));
  } catch {
    // Reconstructible hints are expendable: quota/privacy failures must not affect rendering.
  }
}

function loadRecords(storage: DimensionStorage | undefined): DimensionRecord[] {
  try {
    const raw = storage?.getItem(storageKey);
    if (raw === undefined || raw === null) return [];
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    // Serialized order is oldest first. Keep the last valid occurrence of each URL.
    const records = new Map<string, DimensionRecord>();
    for (const candidate of value) {
      const record = parseRecord(candidate);
      if (record === undefined) continue;
      records.delete(record.source);
      records.set(record.source, record);
    }
    return [...records.values()].slice(-maxRecords);
  } catch {
    // Treat unreadable/corrupt snapshots as empty; a later write can replace them.
    return [];
  }
}

function parseRecord(value: unknown): DimensionRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || !("source" in value) || typeof value.source !== "string" || value.source === ""
    || !("width" in value) || !("height" in value)) return undefined;
  const dimensions = validImageDimensions(value.width, value.height);
  return dimensions === undefined ? undefined : { source: value.source, ...dimensions };
}
