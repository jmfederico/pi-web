import { describe, expect, it, vi } from "vitest";
import { jjDiff, jjStatus } from "./gitService.js";

const result = (stdout: string) => ({ code: 0, stdout, stderr: "", truncated: false });

describe("Jujutsu workspace changes", () => {
  it("maps the working-copy summary into the existing changes contract", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce(result(["M", '"src/main.ts"', "0", "A", '"new file.txt"', "0", "D", '"old.ts"', "0", "M", '"conflicted.ts"', "1", ""].join("\0")))
      .mockResolvedValueOnce(result("abcdefgh\0describe jj support"));

    const status = await jjStatus("/repo", false, run);

    expect(status).toMatchObject({
      isGitRepo: false,
      vcs: "jj",
      branch: "abcdefgh · describe jj support",
      files: [
        { path: "src/main.ts", index: "unmodified", workingTree: "modified" },
        { path: "new file.txt", index: "unmodified", workingTree: "added" },
        { path: "old.ts", index: "unmodified", workingTree: "deleted" },
        { path: "conflicted.ts", index: "unmodified", workingTree: "conflicted" },
      ],
    });
    expect(status.hash).not.toBe("");
    expect(run).toHaveBeenNthCalledWith(1, "/repo", ["diff", "--color=never", "-T", 'status_char ++ "\\0" ++ json(path) ++ "\\0" ++ if(target.conflict(), "1", "0") ++ "\\0"']);
  });

  it("rejects a truncated Jujutsu status before parsing a partial path record", async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: 'M\0"partial', stderr: "", truncated: true });

    await expect(jjStatus("/repo", false, run)).rejects.toThrow("exceeds the 2 MiB output limit");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("returns a Git-format working-copy diff and an empty staged diff", async () => {
    const run = vi.fn().mockResolvedValue(result("diff --git a/file.ts b/file.ts\n"));

    await expect(jjDiff("/repo", { path: "file (1).ts" }, run)).resolves.toMatchObject({ vcs: "jj", staged: false, diff: "diff --git a/file.ts b/file.ts\n" });
    await expect(jjDiff("/repo", { path: "file (1).ts", staged: true }, run)).resolves.toMatchObject({ vcs: "jj", staged: true, diff: "" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("/repo", ["diff", "--git", "--color=never", "--", 'root-file:"file (1).ts"']);
  });
});
