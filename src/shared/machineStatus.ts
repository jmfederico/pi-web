/**
 * Internal per-machine status contract shared by sessiond, the web tier, and
 * the browser.
 *
 * sessiond resolves `cwd → workspace → project` and rolls status up, so the
 * browser never attributes anything itself: it renders whatever node flags the
 * snapshot carries. The types are deliberately internal — nothing here is
 * exported from the plugin API.
 */

/**
 * Status of a single node (machine, project, workspace, or the unattributed
 * bucket), as an open map keyed by qualified flag id.
 *
 * The map is open because PI WEB federates across machines running different
 * versions, so a browser regularly reads snapshots produced by a daemon that
 * knows flags it does not. Because parents are rolled up on the server, an
 * unrecognised flag id still produces correct parent state; the client only
 * loses per-flag styling. It is not a plugin extension point.
 *
 * Publishers emit only flags that are set, so an absent id means "not set",
 * never "unknown". Readers still tolerate an explicit `false`.
 */
export type StatusFlags = Readonly<Record<string, boolean>>;

/**
 * Complete status projection for one machine. There is no delta encoding:
 * every message carries the whole tree.
 */
export interface MachineStatusSnapshot {
  /** Daemon instance identity. A change means "discard everything you had". */
  epochId: string;
  /** Monotonic within an epoch. Higher wins; equal or lower is ignored. */
  revision: number;
  /** Roll-up of `projects`, `workspaces`, and `unattributed`. */
  machine: StatusFlags;
  /** Keyed by project id. */
  projects: Readonly<Record<string, StatusFlags>>;
  /** Keyed by workspace id. */
  workspaces: Readonly<Record<string, StatusFlags>>;
  /** Roll-up of active cwds that map to no known workspace. */
  unattributed: StatusFlags;
  generatedAt: string;
}

/**
 * Realtime frame carrying a complete snapshot. There is no delta frame, so a
 * receiver either accepts the whole tree or keeps the one it already had.
 */
export interface MachineStatusUiEvent {
  type: "machine.status";
  status: MachineStatusSnapshot;
}

/** The complete set of flags PI WEB itself publishes today. */
export const CORE_STATUS_FLAGS = {
  /** A session in the subtree has work in progress (`isSessionActive`). */
  working: "core:working",
  /** A live terminal in the subtree. */
  terminal: "core:terminal",
  /** An unread session completion in the subtree. */
  unread: "core:unread",
} as const;

/**
 * Combine child flags into a parent node. A flag is set on the parent when it
 * is set on any child, and unset flags are omitted so that two trees carrying
 * the same status compare equal by structure.
 */
export function rollUpStatusFlags(sources: Iterable<StatusFlags>): StatusFlags {
  const rolled = new Map<string, boolean>();
  for (const source of sources) {
    for (const [flagId, isSet] of Object.entries(source)) {
      if (isSet) rolled.set(flagId, true);
    }
  }
  return Object.fromEntries(rolled);
}

/**
 * Parse a snapshot received over HTTP or the realtime socket.
 *
 * Structural fields are required, because a snapshot missing them cannot be
 * ordered or rendered. Flag content is tolerated instead: an unrecognised flag
 * id is kept as-is so it still contributes an indicator, and an entry whose
 * value is not a boolean is dropped rather than failing the whole payload,
 * since a newer daemon adding flags must never blank a machine's status.
 */
export function parseMachineStatusSnapshot(value: unknown): MachineStatusSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  const epochId = value["epochId"];
  const revision = value["revision"];
  const generatedAt = value["generatedAt"];
  const machine = parseStatusFlags(value["machine"]);
  const unattributed = parseStatusFlags(value["unattributed"]);
  const projects = parseStatusFlagsByNodeId(value["projects"]);
  const workspaces = parseStatusFlagsByNodeId(value["workspaces"]);
  if (typeof epochId !== "string" || epochId === "") return undefined;
  if (typeof revision !== "number" || !Number.isFinite(revision)) return undefined;
  if (typeof generatedAt !== "string" || generatedAt === "") return undefined;
  if (machine === undefined || unattributed === undefined) return undefined;
  if (projects === undefined || workspaces === undefined) return undefined;
  return { epochId, revision, machine, projects, workspaces, unattributed, generatedAt };
}

/**
 * Flag ids arrive from another machine, so entries are collected through a map
 * and `Object.fromEntries`: a key such as `__proto__` then becomes an ordinary
 * own property instead of reassigning the result's prototype.
 */
function parseStatusFlags(value: unknown): StatusFlags | undefined {
  if (!isRecord(value)) return undefined;
  const flags = new Map<string, boolean>();
  for (const [flagId, isSet] of Object.entries(value)) {
    if (typeof isSet === "boolean") flags.set(flagId, isSet);
  }
  return Object.fromEntries(flags);
}

function parseStatusFlagsByNodeId(value: unknown): Readonly<Record<string, StatusFlags>> | undefined {
  if (!isRecord(value)) return undefined;
  const nodes = new Map<string, StatusFlags>();
  for (const [nodeId, nodeFlags] of Object.entries(value)) {
    const parsed = parseStatusFlags(nodeFlags);
    if (parsed !== undefined) nodes.set(nodeId, parsed);
  }
  return Object.fromEntries(nodes);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
