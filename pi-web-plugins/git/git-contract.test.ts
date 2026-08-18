import { describe, expect, it } from "vitest";
import { parseGitDiffResponse, parseGitStatusResponse } from "./browser/git-contract.js";

describe("Git browser backend contract", () => {
  it("parses status, submodule pointers, and diffs from JSON-only backend results", () => {
    const status = parseGitStatusResponse({
      isGitRepo: true,
      hash: "status-hash",
      branch: "main",
      files: [
        { path: "HARL", index: "unmodified", workingTree: "modified", submoduleFromCommit: "1111111", submoduleToCommit: "2222222" },
        { path: "HARL/inner.txt", index: "modified", workingTree: "modified" },
      ],
      submodules: ["HARL"],
    });
    const diff = parseGitDiffResponse({ path: "HARL/inner.txt", staged: false, hash: "diff-hash", diff: "@@ -1 +1 @@", truncated: false });

    expect(status.submodules).toEqual(["HARL"]);
    expect(status.files[0]).toMatchObject({ submoduleFromCommit: "1111111", submoduleToCommit: "2222222" });
    expect(diff).toMatchObject({ path: "HARL/inner.txt", staged: false, hash: "diff-hash" });
  });

  it("keeps the legacy missing-submodules response compatible while rejecting malformed provider data", () => {
    expect(parseGitStatusResponse({ isGitRepo: true, hash: "h", files: [] }).submodules).toEqual([]);
    expect(() => parseGitStatusResponse({ isGitRepo: true, hash: "h", files: [{ path: "a", index: "weird", workingTree: "modified" }] }))
      .toThrow("Invalid Git file state");
    expect(() => parseGitDiffResponse({ staged: false, hash: "h", diff: "" }))
      .toThrow("Expected boolean field: truncated");
  });
});
