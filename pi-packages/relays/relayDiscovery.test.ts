import { describe, expect, it, vi } from "vitest";
import type { FileContentResponse, FileTreeEntry, FileTreeResponse } from "@jmfederico/pi-web/plugin-api";
import {
  ancestorDirectoryPaths,
  collectDirectoryPaths,
  defaultRelayDocument,
  flattenRelayTree,
  listRelayDocumentTree,
  listWorkspaceRelays,
  MAX_RELAY_DOCUMENTS,
  MAX_RELAY_DIRECTORIES,
  MAX_RELAY_TREE_DEPTH,
  readRelayDocument,
  RELAYS_ROOT,
  sortRelaysByRecency,
  type RelayDiscoveryFiles,
  type RelaySummary,
  type RelayTreeNode,
} from "./relayDiscovery";

const RELAY_PATH = `${RELAYS_ROOT}/my-relay`;

describe("listWorkspaceRelays", () => {
  it("lists relay directories through the workspace files helper, most recently modified first", async () => {
    const listFiles = vi.fn<RelayDiscoveryFiles["listFiles"]>(() => Promise.resolve(listing(RELAYS_ROOT, [
      directoryEntry("older", "2026-01-01T00:00:00.000Z"),
      fileEntry("stray-file.md", "2026-03-01T00:00:00.000Z"),
      directoryEntry("newer", "2026-02-01T00:00:00.000Z"),
      symlinkEntry("linked", "2026-04-01T00:00:00.000Z"),
    ])));
    const files = filesWith({ listFiles });

    const result = await listWorkspaceRelays(files);

    expect(listFiles).toHaveBeenCalledWith(RELAYS_ROOT);
    expect(result).toEqual({
      kind: "loaded",
      relays: [
        { name: "newer", path: `${RELAYS_ROOT}/newer`, modifiedAt: "2026-02-01T00:00:00.000Z" },
        { name: "older", path: `${RELAYS_ROOT}/older`, modifiedAt: "2026-01-01T00:00:00.000Z" },
      ],
    });
  });

  it("reports an empty relays directory as zero relays", async () => {
    const files = filesWith({ listFiles: () => Promise.resolve(listing(RELAYS_ROOT, [])) });

    await expect(listWorkspaceRelays(files)).resolves.toEqual({ kind: "loaded", relays: [] });
  });

  it("treats a missing relays directory as missing rather than a failure", async () => {
    const files = filesWith({ listFiles: () => Promise.reject(new Error("Path does not exist")) });

    await expect(listWorkspaceRelays(files)).resolves.toEqual({ kind: "missing" });
  });

  it("treats a relays root that is not a directory as missing rather than a failure", async () => {
    const files = filesWith({ listFiles: () => Promise.reject(new Error("Path is not a directory")) });

    await expect(listWorkspaceRelays(files)).resolves.toEqual({ kind: "missing" });
  });

  it("surfaces other listing failures as unavailable with the error detail", async () => {
    const files = filesWith({ listFiles: () => Promise.reject(new Error("connection lost")) });

    await expect(listWorkspaceRelays(files)).resolves.toEqual({ kind: "unavailable", detail: "connection lost" });
  });
});

describe("sortRelaysByRecency", () => {
  it("sorts undated and invalid-dated relays after dated ones, alphabetically", () => {
    const relays: RelaySummary[] = [
      { name: "zulu", path: "zulu" },
      { name: "middle", path: "middle", modifiedAt: "2026-02-01T00:00:00.000Z" },
      { name: "alpha", path: "alpha" },
      { name: "broken", path: "broken", modifiedAt: "not-a-date" },
      { name: "newest", path: "newest", modifiedAt: "2026-03-01T00:00:00.000Z" },
    ];

    expect(sortRelaysByRecency(relays).map((relay) => relay.name)).toEqual(["newest", "middle", "alpha", "broken", "zulu"]);
  });

  it("does not mutate the input array", () => {
    const relays: RelaySummary[] = [
      { name: "b", path: "b", modifiedAt: "2026-01-01T00:00:00.000Z" },
      { name: "a", path: "a", modifiedAt: "2026-02-01T00:00:00.000Z" },
    ];

    sortRelaysByRecency(relays);

    expect(relays.map((relay) => relay.name)).toEqual(["b", "a"]);
  });
});

describe("listRelayDocumentTree", () => {
  it("builds an ordered tree: anchors first at the root, then files, then directories, recursed depth-first", async () => {
    const fake = discoveryFake(new Map([
      [RELAY_PATH, listing(RELAY_PATH, [
        file("notes.md"),
        directory("notes"),
        file("log.md"),
        directory("assets"),
        file("status.md"),
        file("data.json"),
        file("operations.md"),
        file("charter.md"),
        symlink("linked"),
      ])],
      [`${RELAY_PATH}/assets`, listing(`${RELAY_PATH}/assets`, [file("assets/diagram.png")])],
      [`${RELAY_PATH}/notes`, listing(`${RELAY_PATH}/notes`, [file("notes/b.md"), directory("notes/deep"), file("notes/a.md")])],
      [`${RELAY_PATH}/notes/deep`, listing(`${RELAY_PATH}/notes/deep`, [file("notes/deep/c.md")])],
    ]));

    const result = await listRelayDocumentTree(fake, RELAY_PATH);

    expect(fake.listFiles).toHaveBeenCalledWith(RELAY_PATH);
    expect(result).toEqual({
      kind: "loaded",
      documentCount: 10,
      partial: false,
      tree: [
        fileNode("status.md", 0),
        fileNode("charter.md", 0),
        fileNode("operations.md", 0),
        fileNode("log.md", 0),
        fileNode("data.json", 0),
        fileNode("notes.md", 0),
        {
          kind: "directory", name: "assets", path: `${RELAY_PATH}/assets`, relativePath: "assets", depth: 0,
          children: [fileNode("assets/diagram.png", 1)],
        },
        {
          kind: "directory", name: "notes", path: `${RELAY_PATH}/notes`, relativePath: "notes", depth: 0,
          children: [
            fileNode("notes/a.md", 1),
            fileNode("notes/b.md", 1),
            {
              kind: "directory", name: "deep", path: `${RELAY_PATH}/notes/deep`, relativePath: "notes/deep", depth: 1,
              children: [fileNode("notes/deep/c.md", 2)],
            },
          ],
        },
      ],
    });
  });

  it("orders nested directories alphabetically without anchor ordering", async () => {
    const fake = discoveryFake(new Map([
      [RELAY_PATH, listing(RELAY_PATH, [directory("notes")])],
      [`${RELAY_PATH}/notes`, listing(`${RELAY_PATH}/notes`, [file("notes/status.md"), file("notes/alpha.md")])],
    ]));

    const result = await listRelayDocumentTree(fake, RELAY_PATH);

    const notes = result.kind === "loaded" ? result.tree[0] : undefined;
    expect(notes?.kind).toBe("directory");
    if (notes?.kind !== "directory") throw new Error("expected notes directory");
    expect(notes.children.map((child) => child.name)).toEqual(["alpha.md", "status.md"]);
  });

  it("never follows symlink entries", async () => {
    const fake = discoveryFake(new Map([
      [RELAY_PATH, listing(RELAY_PATH, [file("status.md"), symlink("escape")])],
    ]));

    const result = await listRelayDocumentTree(fake, RELAY_PATH);

    expect(result).toMatchObject({ kind: "loaded", documentCount: 1, tree: [{ kind: "file", name: "status.md" }] });
  });

  it("stops descending past the depth cap and flags the listing partial", async () => {
    // A chain one level deeper than the cap: the depth-cap directory is listed
    // but not walked, so the file inside it never appears.
    const listings = new Map<string, FileTreeResponse>();
    let path = RELAY_PATH;
    for (let depth = 0; depth <= MAX_RELAY_TREE_DEPTH; depth += 1) {
      const childPath = `${path}/level-${String(depth)}`;
      const childEntry: FileTreeEntry = { name: `level-${String(depth)}`, path: childPath, type: "directory" };
      const entries = depth === 0 ? [file("status.md"), childEntry] : [childEntry];
      listings.set(path, listing(path, entries));
      path = childPath;
    }
    listings.set(path, listing(path, [file("too-deep.md")]));
    const fake = discoveryFake(listings);

    const result = await listRelayDocumentTree(fake, RELAY_PATH);
    if (result.kind !== "loaded") throw new Error("expected a loaded listing");

    expect(result.partial).toBe(true);
    expect(result.documentCount).toBe(1);
    const deepest = findNode(result.tree, `${RELAY_PATH}/${chainNames(MAX_RELAY_TREE_DEPTH + 1)}`);
    expect(deepest).toMatchObject({ kind: "directory", depth: MAX_RELAY_TREE_DEPTH, children: [] });
    expect(findNode(result.tree, `${path}/too-deep.md`)).toBeUndefined();
  });

  it("caps the total document count and flags the listing partial", async () => {
    const entries = Array.from({ length: MAX_RELAY_DOCUMENTS + 5 }, (_, index) =>
      file(`file-${String(index).padStart(3, "0")}.md`));
    const fake = discoveryFake(new Map([[RELAY_PATH, listing(RELAY_PATH, entries)]]));

    const result = await listRelayDocumentTree(fake, RELAY_PATH);
    if (result.kind !== "loaded") throw new Error("expected a loaded listing");

    expect(result.partial).toBe(true);
    expect(result.documentCount).toBe(MAX_RELAY_DOCUMENTS);
    expect(flattenRelayTree(result.tree).map((node) => node.name)).not.toContain(`file-${String(MAX_RELAY_DOCUMENTS)}.md`);
  });

  it("caps the number of directories walked and flags the listing partial", async () => {
    const entries: FileTreeEntry[] = [file("status.md")];
    const listings = new Map<string, FileTreeResponse>();
    for (let index = 0; index < MAX_RELAY_DIRECTORIES + 3; index += 1) {
      const name = `dir-${String(index).padStart(3, "0")}`;
      entries.push(directory(name));
      listings.set(`${RELAY_PATH}/${name}`, listing(`${RELAY_PATH}/${name}`, [file(`${name}/inside.md`)]));
    }
    listings.set(RELAY_PATH, listing(RELAY_PATH, entries));
    const fake = discoveryFake(listings);

    const result = await listRelayDocumentTree(fake, RELAY_PATH);
    if (result.kind !== "loaded") throw new Error("expected a loaded listing");

    expect(result.partial).toBe(true);
    expect(result.documentCount).toBe(1 + MAX_RELAY_DIRECTORIES);
    const skipped = `dir-${String(MAX_RELAY_DIRECTORIES).padStart(3, "0")}`;
    expect(findNode(result.tree, `${RELAY_PATH}/${skipped}`)).toMatchObject({ kind: "directory", children: [] });
    expect(findNode(result.tree, `${RELAY_PATH}/${skipped}/inside.md`)).toBeUndefined();
  });

  it("flags the listing partial when the root listing is truncated", async () => {
    const fake = discoveryFake(new Map([
      [RELAY_PATH, listing(RELAY_PATH, [file("status.md")], { truncated: true })],
    ]));

    const result = await listRelayDocumentTree(fake, RELAY_PATH);

    expect(result).toMatchObject({ kind: "loaded", partial: true });
  });

  it("keeps an unreadable subdirectory as an empty node and flags the listing partial", async () => {
    const fake = discoveryFake(new Map([
      [RELAY_PATH, listing(RELAY_PATH, [file("status.md"), directory("broken"), directory("fine")])],
      [`${RELAY_PATH}/fine`, listing(`${RELAY_PATH}/fine`, [file("fine/ok.md")])],
    ]));
    fake.fail(`${RELAY_PATH}/broken`, new Error("boom"));

    const result = await listRelayDocumentTree(fake, RELAY_PATH);
    if (result.kind !== "loaded") throw new Error("expected a loaded listing");

    expect(result.partial).toBe(true);
    expect(result.documentCount).toBe(2);
    expect(findNode(result.tree, `${RELAY_PATH}/broken`)).toMatchObject({ kind: "directory", children: [] });
    expect(findNode(result.tree, `${RELAY_PATH}/fine/ok.md`)).toMatchObject({ kind: "file" });
  });

  it("treats a vanished relay directory as missing", async () => {
    const files = filesWith({ listFiles: () => Promise.reject(new Error("Path does not exist")) });

    await expect(listRelayDocumentTree(files, `${RELAYS_ROOT}/gone`)).resolves.toEqual({ kind: "missing" });
  });

  it("surfaces other listing failures as unavailable", async () => {
    const files = filesWith({ listFiles: () => Promise.reject(new Error("boom")) });

    await expect(listRelayDocumentTree(files, `${RELAYS_ROOT}/x`)).resolves.toEqual({ kind: "unavailable", detail: "boom" });
  });
});

describe("defaultRelayDocument", () => {
  it("picks status.md when present at the relay root", () => {
    // The tree arrives in discovery order: anchors lead at the root.
    const tree: RelayTreeNode[] = [
      fileNode("status.md", 0),
      fileNode("charter.md", 0),
      directoryNode("notes", [fileNode("notes/topic.md", 1)], 0),
    ];

    expect(defaultRelayDocument(tree)?.path).toBe(`${RELAY_PATH}/status.md`);
  });

  it("falls back to the depth-first first nested document when the root has no files", () => {
    // Children arrive in discovery order (nested files sort alphabetically).
    const tree: RelayTreeNode[] = [
      directoryNode("notes", [fileNode("notes/alpha.md", 1), fileNode("notes/charter.md", 1)], 0),
      directoryNode("zebra", [fileNode("zebra/z.md", 1)], 0),
    ];

    expect(defaultRelayDocument(tree)?.relativePath).toBe("notes/alpha.md");
  });

  it("returns undefined for a relay without documents", () => {
    expect(defaultRelayDocument([])).toBeUndefined();
    expect(defaultRelayDocument([directoryNode("notes", [], 0)])).toBeUndefined();
  });
});

describe("flattenRelayTree", () => {
  it("lists every file in depth-first tree order", () => {
    const tree: RelayTreeNode[] = [
      fileNode("status.md", 0),
      directoryNode("notes", [fileNode("notes/a.md", 1), directoryNode("notes/deep", [fileNode("notes/deep/b.md", 2)], 1)], 0),
      fileNode("z.md", 0),
    ];

    expect(flattenRelayTree(tree).map((node) => node.relativePath)).toEqual([
      "status.md", "notes/a.md", "notes/deep/b.md", "z.md",
    ]);
  });
});

describe("ancestorDirectoryPaths", () => {
  const tree: RelayTreeNode[] = [
    fileNode("status.md", 0),
    directoryNode("notes", [directoryNode("notes/deep", [fileNode("notes/deep/b.md", 2)], 1)], 0),
  ];

  it("returns the chain from the relay root down for a nested file", () => {
    expect(ancestorDirectoryPaths(tree, `${RELAY_PATH}/notes/deep/b.md`))
      .toEqual([`${RELAY_PATH}/notes`, `${RELAY_PATH}/notes/deep`]);
  });

  it("returns an empty chain for a root file", () => {
    expect(ancestorDirectoryPaths(tree, `${RELAY_PATH}/status.md`)).toEqual([]);
  });

  it("returns an empty chain for a file that is not in the tree", () => {
    expect(ancestorDirectoryPaths(tree, `${RELAY_PATH}/notes/gone.md`)).toEqual([]);
  });
});

describe("collectDirectoryPaths", () => {
  it("collects every directory path in the tree", () => {
    const tree: RelayTreeNode[] = [
      fileNode("status.md", 0),
      directoryNode("notes", [directoryNode("notes/deep", [], 1)], 0),
    ];

    expect(collectDirectoryPaths(tree)).toEqual(new Set([`${RELAY_PATH}/notes`, `${RELAY_PATH}/notes/deep`]));
  });
});

describe("readRelayDocument", () => {
  it("returns document content with its truncation and binary flags", async () => {
    const files = filesWith({
      readFile: () => Promise.resolve(fileContent({ content: "# Status", truncated: true, binary: false })),
    });

    await expect(readRelayDocument(files, `${RELAYS_ROOT}/r/log.md`)).resolves.toEqual({
      kind: "loaded",
      content: "# Status",
      truncated: true,
      binary: false,
    });
  });

  it("treats a vanished document as missing", async () => {
    const files = filesWith({ readFile: () => Promise.reject(new Error("Path does not exist")) });

    await expect(readRelayDocument(files, `${RELAYS_ROOT}/r/gone.md`)).resolves.toEqual({ kind: "missing" });
  });

  it("surfaces other read failures as unavailable", async () => {
    const files = filesWith({ readFile: () => Promise.reject(new Error("boom")) });

    await expect(readRelayDocument(files, `${RELAYS_ROOT}/r/x.md`)).resolves.toEqual({ kind: "unavailable", detail: "boom" });
  });
});

interface DiscoveryFake extends RelayDiscoveryFiles {
  listFiles: ReturnType<typeof vi.fn<RelayDiscoveryFiles["listFiles"]>>;
  fail(path: string, error: Error): void;
}

/** Path-keyed listing fake; unknown paths reject with "Path does not exist", like the real helper. */
function discoveryFake(listings: Map<string, FileTreeResponse>): DiscoveryFake {
  const failures = new Map<string, Error>();
  const listFiles = vi.fn<RelayDiscoveryFiles["listFiles"]>((path) => {
    const failure = failures.get(path);
    if (failure !== undefined) return Promise.reject(failure);
    const value = listings.get(path);
    if (value === undefined) return Promise.reject(new Error("Path does not exist"));
    return Promise.resolve(value);
  });
  return {
    listFiles,
    readFile: () => Promise.reject(new Error("readFile not expected")),
    fail: (path, error) => { failures.set(path, error); },
  };
}

function filesWith(overrides: Partial<RelayDiscoveryFiles>): RelayDiscoveryFiles {
  return {
    listFiles: () => Promise.reject(new Error("listFiles not expected")),
    readFile: () => Promise.reject(new Error("readFile not expected")),
    ...overrides,
  };
}

function listing(path: string, entries: FileTreeEntry[], overrides?: Partial<FileTreeResponse>): FileTreeResponse {
  return { path, entries, scannedAt: "2026-01-01T00:00:00.000Z", truncated: false, ...overrides };
}

/** Entry under the relay root: path and name derive from the relay-relative path. */
function file(relativePath: string): FileTreeEntry {
  return { name: baseName(relativePath), path: `${RELAY_PATH}/${relativePath}`, type: "file" };
}

function directory(relativePath: string): FileTreeEntry {
  return { name: baseName(relativePath), path: `${RELAY_PATH}/${relativePath}`, type: "directory" };
}

function symlink(relativePath: string): FileTreeEntry {
  return { name: baseName(relativePath), path: `${RELAY_PATH}/${relativePath}`, type: "symlink" };
}

function fileNode(relativePath: string, depth: number) {
  return {
    kind: "file" as const,
    name: baseName(relativePath),
    path: `${RELAY_PATH}/${relativePath}`,
    relativePath,
    depth,
    modifiedAt: undefined,
  };
}

function directoryNode(relativePath: string, children: RelayTreeNode[], depth: number) {
  return {
    kind: "directory" as const,
    name: baseName(relativePath),
    path: `${RELAY_PATH}/${relativePath}`,
    relativePath,
    depth,
    children,
  };
}

function findNode(tree: RelayTreeNode[], path: string): RelayTreeNode | undefined {
  for (const node of tree) {
    if (node.path === path) return node;
    if (node.kind === "directory") {
      const nested = findNode(node.children, path);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

/** level-0/level-1/... path segment chain of the given length. */
function chainNames(count: number): string {
  return Array.from({ length: count }, (_, index) => `level-${String(index)}`).join("/");
}

function baseName(relativePath: string): string {
  return relativePath.slice(relativePath.lastIndexOf("/") + 1);
}

function directoryEntry(name: string, modifiedAt?: string): FileTreeEntry {
  return { name, path: `${RELAYS_ROOT}/${name}`, type: "directory", ...(modifiedAt === undefined ? {} : { modifiedAt }) };
}

function fileEntry(name: string, modifiedAt?: string): FileTreeEntry {
  return { name, path: `${RELAYS_ROOT}/${name}`, type: "file", ...(modifiedAt === undefined ? {} : { modifiedAt }) };
}

function symlinkEntry(name: string, modifiedAt?: string): FileTreeEntry {
  return { name, path: `${RELAYS_ROOT}/${name}`, type: "symlink", ...(modifiedAt === undefined ? {} : { modifiedAt }) };
}

function fileContent(overrides: Partial<FileContentResponse>): FileContentResponse {
  return {
    path: `${RELAYS_ROOT}/r/log.md`,
    encoding: "utf8",
    size: 8,
    modifiedAt: "2026-01-01T00:00:00.000Z",
    content: "",
    truncated: false,
    binary: false,
    ...overrides,
  };
}
