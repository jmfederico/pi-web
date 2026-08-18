import type { SessionTreeNode, SessionTreeSnapshot, SessionTreeSummaryChoice } from "./api";
import { SESSION_TREE_CUSTOM_INSTRUCTIONS_MAX_LENGTH } from "../../shared/apiTypes";

export interface SessionTreeModel {
  readonly nodesById: ReadonlyMap<string, SessionTreeNode>;
  readonly orderedIds: readonly string[];
  readonly rootIds: readonly string[];
  readonly parentById: ReadonlyMap<string, string | null>;
  readonly childrenById: ReadonlyMap<string, readonly string[]>;
  readonly depthById: ReadonlyMap<string, number>;
  readonly branchDepthById: ReadonlyMap<string, number>;
  readonly activePathIds: ReadonlySet<string>;
  readonly activeLeafId: string | null;
}

export interface SessionTreeRow {
  readonly node: SessionTreeNode;
  readonly depth: number;
  readonly branchDepth: number;
  readonly parentId: string | null;
  readonly childIds: readonly string[];
  readonly activePath: boolean;
  readonly activeLeaf: boolean;
}

export interface SessionTreeKeyState {
  readonly selectedId: string | undefined;
  readonly foldedIds: ReadonlySet<string>;
}

export interface SessionTreeKeyTransition extends SessionTreeKeyState {
  readonly handled: boolean;
  readonly action?: "confirm" | "cancel";
}

export type SessionTreeSummaryValidation =
  | { readonly ok: true; readonly choice: SessionTreeSummaryChoice }
  | { readonly ok: false; readonly error: string };

/**
 * Turn the strict flat transport projection into a safe forest. Parent links to
 * missing nodes become roots, and the edge that would close a cycle is detached.
 */
export function buildSessionTreeModel(snapshot: SessionTreeSnapshot): SessionTreeModel {
  const nodesById = new Map<string, SessionTreeNode>();
  const orderedIds: string[] = [];
  for (const node of snapshot.nodes) {
    // Runtime projections use unique IDs. Keeping the first occurrence makes a
    // malformed duplicate deterministic without creating duplicate treeitems.
    if (nodesById.has(node.id)) continue;
    nodesById.set(node.id, node);
    orderedIds.push(node.id);
  }

  const parentById = normalizedSessionTreeParents(nodesById, orderedIds);

  const mutableChildren = new Map<string, string[]>();
  for (const id of orderedIds) mutableChildren.set(id, []);
  const rootIds: string[] = [];
  for (const id of orderedIds) {
    const parentId = parentById.get(id) ?? null;
    if (parentId === null) {
      rootIds.push(id);
      continue;
    }
    mutableChildren.get(parentId)?.push(id);
  }

  const depthById = new Map<string, number>();
  const branchDepthById = new Map<string, number>();
  const visited = new Set<string>();
  const stack = [...rootIds].reverse().map((id) => ({ id, depth: 0, branchDepth: 0 }));
  while (stack.length > 0) {
    const next = stack.pop();
    if (next === undefined || visited.has(next.id)) continue;
    visited.add(next.id);
    depthById.set(next.id, next.depth);
    branchDepthById.set(next.id, next.branchDepth);
    const children = mutableChildren.get(next.id) ?? [];
    // Session entries form very deep linear chains. Only forks need another
    // visual lane; indenting every parent would push ordinary history off-screen.
    const childBranchDepth = next.branchDepth + (children.length > 1 ? 1 : 0);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const childId = children[index];
      if (childId !== undefined) stack.push({ id: childId, depth: next.depth + 1, branchDepth: childBranchDepth });
    }
  }

  // The normalized parent map should already make every node reachable. This
  // fallback keeps the UI complete if future input violates that invariant.
  for (const id of orderedIds) {
    if (visited.has(id)) continue;
    rootIds.push(id);
    parentById.set(id, null);
    depthById.set(id, 0);
    branchDepthById.set(id, 0);
  }

  const childrenById = new Map<string, readonly string[]>();
  for (const [id, children] of mutableChildren) childrenById.set(id, children);
  const activeLeafId = snapshot.activeLeafId !== null && nodesById.has(snapshot.activeLeafId) ? snapshot.activeLeafId : null;
  // Re-derive the path from the normalized forest. A malformed remote snapshot
  // cannot badge an unrelated branch or keep a cycle-closing edge active.
  const activePathIds = activeLeafId === null ? new Set<string>() : sessionTreeAncestorIds(activeLeafId, parentById);

  return { nodesById, orderedIds, rootIds, parentById, childrenById, depthById, branchDepthById, activePathIds, activeLeafId };
}

export function visibleSessionTreeRows(model: SessionTreeModel, foldedIds: ReadonlySet<string>): SessionTreeRow[] {
  const rows: SessionTreeRow[] = [];
  const visited = new Set<string>();
  const stack = [...model.rootIds].reverse();

  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined || visited.has(id)) continue;
    const node = model.nodesById.get(id);
    if (node === undefined) continue;
    visited.add(id);
    const childIds = model.childrenById.get(id) ?? [];
    rows.push({
      node,
      depth: model.depthById.get(id) ?? 0,
      branchDepth: model.branchDepthById.get(id) ?? 0,
      parentId: model.parentById.get(id) ?? null,
      childIds,
      activePath: model.activePathIds.has(id),
      activeLeaf: model.activeLeafId === id,
    });
    if (foldedIds.has(id)) continue;
    for (let index = childIds.length - 1; index >= 0; index -= 1) {
      const childId = childIds[index];
      if (childId !== undefined) stack.push(childId);
    }
  }

  return rows;
}

export function initialSessionTreeSelection(model: SessionTreeModel): string | undefined {
  if (model.activeLeafId !== null) return model.activeLeafId;
  return model.orderedIds.at(-1);
}

export function transitionSessionTreeKey(model: SessionTreeModel, state: SessionTreeKeyState, key: string): SessionTreeKeyTransition {
  const rows = visibleSessionTreeRows(model, state.foldedIds);
  const visibleIds = rows.map((row) => row.node.id);
  const selectedId = normalizedVisibleSelection(visibleIds, state.selectedId);
  const selectedIndex = selectedId === undefined ? -1 : visibleIds.indexOf(selectedId);
  const unchanged = (): SessionTreeKeyTransition => ({ ...state, selectedId, handled: false });
  const select = (nextSelectedId: string | undefined): SessionTreeKeyTransition => ({ ...state, selectedId: nextSelectedId, handled: true });

  switch (key) {
    case "ArrowUp":
      return select(selectedIndex > 0 ? visibleIds[selectedIndex - 1] : selectedId);
    case "ArrowDown":
      return select(selectedIndex >= 0 && selectedIndex < visibleIds.length - 1 ? visibleIds[selectedIndex + 1] : selectedId);
    case "Home":
      return select(visibleIds[0]);
    case "End":
      return select(visibleIds.at(-1));
    case "ArrowLeft": {
      if (selectedId === undefined) return select(undefined);
      const children = model.childrenById.get(selectedId) ?? [];
      if (children.length > 0 && !state.foldedIds.has(selectedId)) {
        const foldedIds = new Set(state.foldedIds);
        foldedIds.add(selectedId);
        return { selectedId, foldedIds, handled: true };
      }
      return select(model.parentById.get(selectedId) ?? selectedId);
    }
    case "ArrowRight": {
      if (selectedId === undefined) return select(undefined);
      const children = model.childrenById.get(selectedId) ?? [];
      if (children.length === 0) return select(selectedId);
      if (state.foldedIds.has(selectedId)) {
        const foldedIds = new Set(state.foldedIds);
        foldedIds.delete(selectedId);
        return { selectedId, foldedIds, handled: true };
      }
      return select(children[0]);
    }
    case "Enter":
      return { ...state, selectedId, handled: true, ...(selectedId === undefined ? {} : { action: "confirm" }) };
    case "Escape":
      return { ...state, selectedId, handled: true, action: "cancel" };
    default:
      return unchanged();
  }
}

export function toggleSessionTreeFold(model: SessionTreeModel, state: SessionTreeKeyState, id: string): SessionTreeKeyState {
  const children = model.childrenById.get(id) ?? [];
  if (children.length === 0) return { ...state, selectedId: id };
  const foldedIds = new Set(state.foldedIds);
  if (foldedIds.has(id)) foldedIds.delete(id);
  else foldedIds.add(id);
  return { selectedId: id, foldedIds };
}

export function validateSessionTreeSummaryChoice(mode: SessionTreeSummaryChoice["mode"], customInstructions: string): SessionTreeSummaryValidation {
  if (mode === "none" || mode === "default") return { ok: true, choice: { mode } };
  if (customInstructions.trim() === "") return { ok: false, error: "Enter custom summary focus instructions." };
  if (customInstructions.length > SESSION_TREE_CUSTOM_INSTRUCTIONS_MAX_LENGTH) {
    return { ok: false, error: `Custom summary focus must be ${String(SESSION_TREE_CUSTOM_INSTRUCTIONS_MAX_LENGTH)} characters or fewer.` };
  }
  return { ok: true, choice: { mode: "custom", instructions: customInstructions.trim() } };
}

function normalizedSessionTreeParents(
  nodesById: ReadonlyMap<string, SessionTreeNode>,
  orderedIds: readonly string[],
): Map<string, string | null> {
  const parentById = new Map<string, string | null>();
  for (const id of orderedIds) {
    const candidate = nodesById.get(id)?.parentId ?? null;
    parentById.set(id, candidate !== null && candidate !== id && nodesById.has(candidate) ? candidate : null);
  }

  // Parent links form a functional graph. Resolve each chain once and detach
  // the edge that first closes a cycle, keeping normalization linear for large,
  // deeply nested histories.
  const stateById = new Map<string, "visiting" | "visited">();
  for (const startId of orderedIds) {
    if (stateById.has(startId)) continue;
    const path: string[] = [];
    let currentId: string | null = startId;
    while (currentId !== null && !stateById.has(currentId)) {
      stateById.set(currentId, "visiting");
      path.push(currentId);
      currentId = parentById.get(currentId) ?? null;
    }
    if (currentId !== null && stateById.get(currentId) === "visiting") {
      const cycleClosingId = path.at(-1);
      if (cycleClosingId !== undefined) parentById.set(cycleClosingId, null);
    }
    for (const id of path) stateById.set(id, "visited");
  }
  return parentById;
}

function sessionTreeAncestorIds(activeLeafId: string, parentById: ReadonlyMap<string, string | null>): Set<string> {
  const ids = new Set<string>();
  let currentId: string | null = activeLeafId;
  while (currentId !== null && !ids.has(currentId)) {
    ids.add(currentId);
    currentId = parentById.get(currentId) ?? null;
  }
  return ids;
}

function normalizedVisibleSelection(visibleIds: readonly string[], selectedId: string | undefined): string | undefined {
  if (selectedId !== undefined && visibleIds.includes(selectedId)) return selectedId;
  return visibleIds.at(-1);
}
