import { describe, expect, it } from "vitest";
import type { GitStatusFile } from "./api";
import { buildGitFileList } from "./gitFileList";

describe("buildGitFileList", () => {
  it("leaves non-submodule files flat in their original order", () => {
    const model = buildGitFileList([changed("src/b.ts"), changed("a.txt"), changed("src/a.ts")], []);
    expect(model.submodules).toEqual([]);
    expect(model.files.map((file) => file.path)).toEqual(["src/b.ts", "a.txt", "src/a.ts"]);
  });

  it("groups submodule files flat with submodule-relative paths and the pointer first", () => {
    const pointer = submodulePointer("HARL", "1111111", "2222222");
    const model = buildGitFileList([changed("README.md"), pointer, changed("HARL/src/foo.ts"), changed("HARL/a.txt"), changed("HARL/b.txt")], ["HARL"]);

    expect(model.files.map((file) => file.path)).toEqual(["README.md"]);
    expect(model.submodules).toHaveLength(1);
    const group = model.submodules[0];
    expect(group?.path).toBe("HARL");
    expect(group?.name).toBe("HARL");
    expect(group?.pointer?.name).toBe("1111111 → 2222222");
    expect(group?.pointer?.file).toBe(pointer);
    // Flattened (no nesting) and sorted by relative path.
    expect(group?.files.map((entry) => entry.relativePath)).toEqual(["a.txt", "b.txt", "src/foo.ts"]);
    expect(group?.files.map((entry) => entry.path)).toEqual(["HARL/a.txt", "HARL/b.txt", "HARL/src/foo.ts"]);
  });

  it("places submodule groups first, sorted by name, ahead of the flat files", () => {
    const model = buildGitFileList([changed("root.txt"), changed("Zsub/x"), changed("Asub/y")], ["Zsub", "Asub"]);
    expect(model.submodules.map((group) => group.name)).toEqual(["Asub", "Zsub"]);
    expect(model.files.map((file) => file.path)).toEqual(["root.txt"]);
  });

  it("omits the pointer for a dirty submodule whose commit did not move", () => {
    const model = buildGitFileList([changed("HARL/x.txt")], ["HARL"]);
    expect(model.submodules[0]?.pointer).toBeUndefined();
    expect(model.submodules[0]?.files.map((entry) => entry.relativePath)).toEqual(["x.txt"]);
  });
});

function changed(path: string): GitStatusFile {
  return { path, index: "modified", workingTree: "modified" };
}

function submodulePointer(path: string, from: string, to: string): GitStatusFile {
  return { path, index: "unmodified", workingTree: "modified", submoduleFromCommit: from, submoduleToCommit: to };
}
