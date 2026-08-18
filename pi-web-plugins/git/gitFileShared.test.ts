import { describe, expect, it } from "vitest";
import type { GitStatusFile } from "./browser/git-contract.js";
import { pointerName, segmentName } from "./browser/gitFileShared.js";

describe("pointerName", () => {
  it("renders the moved pointer as <from> → <to>", () => {
    expect(pointerName(pointer("1111111", "2222222"))).toBe("1111111 → 2222222");
  });

  it("falls back to a plain label when either end is unresolved", () => {
    expect(pointerName(pointer(undefined, "2222222"))).toBe("commit");
    expect(pointerName(pointer("1111111", undefined))).toBe("commit");
    expect(pointerName(pointer(undefined, undefined))).toBe("commit");
  });
});

describe("segmentName", () => {
  it("returns the final path segment", () => {
    expect(segmentName("deps/sub/module")).toBe("module");
  });

  it("returns the whole path when there is no separator", () => {
    expect(segmentName("HARL")).toBe("HARL");
  });
});

function pointer(from: string | undefined, to: string | undefined): GitStatusFile {
  return {
    path: "HARL",
    index: "unmodified",
    workingTree: "modified",
    ...(from === undefined ? {} : { submoduleFromCommit: from }),
    ...(to === undefined ? {} : { submoduleToCommit: to }),
  };
}
