import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isJjRepository, parseJjWorkspaceList } from "./jjWorkspaceDiscovery.js";

describe("Jujutsu workspace discovery", () => {
  it("does not require the jj executable for directories without Jujutsu metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-web-plain-"));
    try {
      await expect(isJjRepository(directory)).resolves.toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses the current root when legacy workspace metadata has no recorded path", () => {
    const raw = [
      '"feature"', "/repo-feature", "0",
      '"default"', "<Error: Workspace has no recorded path: default>", "1",
      '"stale"', "<Error: Workspace has no recorded path: stale>", "0",
      "",
    ].join("\0");

    expect(parseJjWorkspaceList(raw, "/repo")).toEqual([
      { name: "feature", path: "/repo-feature", isCurrent: false },
      { name: "default", path: "/repo", isCurrent: true },
    ]);
  });
});
