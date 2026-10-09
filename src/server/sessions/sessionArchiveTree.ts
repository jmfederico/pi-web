export interface SessionArchiveTreeCandidate {
  id: string;
  path: string;
  archived: boolean;
  parentSessionPath?: string;
}

export interface SessionArchiveTreePlan<T extends SessionArchiveTreeCandidate> {
  targets: T[];
  unarchivedTargets: T[];
  skippedAlreadyArchivedCount: number;
}

export function findArchiveCandidateByExactId<T extends SessionArchiveTreeCandidate>(candidates: readonly T[], sessionId: string): T | undefined {
  return candidates.find((candidate) => candidate.id === sessionId);
}

export function planSessionArchiveTree<T extends SessionArchiveTreeCandidate>(root: T, candidates: readonly T[]): SessionArchiveTreePlan<T> {
  const targets = sessionArchiveSubtree(root, candidates);
  const unarchivedTargets = targets.filter((target) => !target.archived);
  return {
    targets,
    unarchivedTargets,
    skippedAlreadyArchivedCount: targets.length - unarchivedTargets.length,
  };
}

function sessionArchiveSubtree<T extends SessionArchiveTreeCandidate>(root: T, candidates: readonly T[]): T[] {
  const childrenByParentPath = new Map<string, T[]>();
  for (const candidate of candidates) {
    if (candidate.parentSessionPath === undefined) continue;
    const children = childrenByParentPath.get(candidate.parentSessionPath) ?? [];
    children.push(candidate);
    childrenByParentPath.set(candidate.parentSessionPath, children);
  }

  const result: T[] = [];
  const visit = (candidate: T, seenPaths: Set<string>) => {
    if (seenPaths.has(candidate.path)) return;
    result.push(candidate);
    const nextSeenPaths = new Set(seenPaths);
    nextSeenPaths.add(candidate.path);
    for (const child of childrenByParentPath.get(candidate.path) ?? []) visit(child, nextSeenPaths);
  };
  visit(root, new Set());
  return result;
}
