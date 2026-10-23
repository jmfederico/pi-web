import { describe, expect, it } from "vitest";
import { findArchiveCandidateByExactId, planSessionArchiveTree, type SessionArchiveTreeCandidate } from "./sessionArchiveTree.js";

function candidate(id: string, options: Partial<SessionArchiveTreeCandidate> = {}): SessionArchiveTreeCandidate {
  return {
    id,
    path: `/sessions/${id}.jsonl`,
    archived: false,
    ...options,
  };
}

describe("session archive tree planning", () => {
  it("finds candidates only by full id equality", () => {
    const candidates = [candidate("abcdef"), candidate("abc"), candidate("xyz")];

    expect(findArchiveCandidateByExactId(candidates, "abc")?.id).toBe("abc");
    expect(findArchiveCandidateByExactId(candidates, "abcdef")?.id).toBe("abcdef");
    expect(findArchiveCandidateByExactId(candidates, "abcd")).toBeUndefined();
    expect(findArchiveCandidateByExactId(candidates, "")).toBeUndefined();
    expect(findArchiveCandidateByExactId(candidates, "missing")).toBeUndefined();
  });

  it("plans recursive descendants and separates already archived targets", () => {
    const root = candidate("root");
    const child = candidate("child", { parentSessionPath: root.path });
    const archivedChild = candidate("archived-child", { parentSessionPath: root.path, archived: true });
    const grandchild = candidate("grandchild", { parentSessionPath: archivedChild.path });
    const unrelated = candidate("unrelated");

    const plan = planSessionArchiveTree(root, [root, child, archivedChild, grandchild, unrelated]);

    expect(plan.targets.map((target) => target.id)).toEqual(["root", "child", "archived-child", "grandchild"]);
    expect(plan.unarchivedTargets.map((target) => target.id)).toEqual(["root", "child", "grandchild"]);
    expect(plan.skippedAlreadyArchivedCount).toBe(1);
  });

  it("stops traversal across cycles", () => {
    const root = candidate("root");
    const child = candidate("child", { parentSessionPath: root.path });
    const cycle = candidate("cycle", { path: root.path, parentSessionPath: child.path });

    const plan = planSessionArchiveTree(root, [root, child, cycle]);

    expect(plan.targets.map((target) => target.id)).toEqual(["root", "child"]);
  });
});
