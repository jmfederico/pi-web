import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectStore } from "../storage/projectStore.js";

vi.mock("./gitClone.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./gitClone.js")>();
  return { ...actual, cloneGitRepository: vi.fn() };
});

import { cloneGitRepository } from "./gitClone.js";
import { ProjectService } from "./projectService.js";

let tempDir: string;
let projectService: ProjectService;
let projectStore: ProjectStore;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-web-project-clone-test-"));
  projectStore = new ProjectStore(join(tempDir, "projects.json"));
  vi.mocked(cloneGitRepository).mockReset();
  projectService = new ProjectService(projectStore);
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("ProjectService.cloneFromGit", () => {
  it("rejects a concurrent clone to the same destination", async () => {
    let signalCloneStarted: (() => void) | undefined;
    let finishClone: (() => void) | undefined;
    const cloneStarted = new Promise<void>((resolve) => { signalCloneStarted = resolve; });
    const cloneCanFinish = new Promise<void>((resolve) => { finishClone = resolve; });
    vi.mocked(cloneGitRepository).mockImplementation(async (_url, stagingPath) => {
      await mkdir(stagingPath);
      signalCloneStarted?.();
      await cloneCanFinish;
    });
    const input = {
      repositoryUrl: "https://git.example.com/team/project.git",
      destinationPath: join(tempDir, "project"),
    };
    const firstClone = projectService.cloneFromGit(input);
    await cloneStarted;

    await expect(projectService.cloneFromGit(input)).rejects.toThrow("A Git clone is already in progress for this destination");
    expect(cloneGitRepository).toHaveBeenCalledOnce();

    finishClone?.();
    const project = await firstClone;
    expect(project.path).toBe(await realpath(input.destinationPath));
  });

  it("rejects an existing destination without changing it", async () => {
    const destination = join(tempDir, "existing-project");
    await mkdir(destination);
    await writeFile(join(destination, "keep.txt"), "keep");

    await expect(projectService.cloneFromGit({ repositoryUrl: "https://git.example.com/team/project.git", destinationPath: destination }))
      .rejects.toThrow("Destination already exists");

    expect(await readFile(join(destination, "keep.txt"), "utf8")).toBe("keep");
    expect(cloneGitRepository).not.toHaveBeenCalled();
    expect(await projectStore.list()).toEqual([]);
  });

  it("removes staging and newly created parent folders when cloning fails", async () => {
    const destination = join(tempDir, "new-parent", "nested", "project");
    vi.mocked(cloneGitRepository).mockImplementation(async (_url, stagingPath) => {
      await mkdir(stagingPath);
      await writeFile(join(stagingPath, "partial.txt"), "partial");
      throw new Error("remote unavailable");
    });

    await expect(projectService.cloneFromGit({ repositoryUrl: "https://git.example.com/team/project.git", destinationPath: destination }))
      .rejects.toThrow("remote unavailable");

    await expect(lstat(join(tempDir, "new-parent"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await projectStore.list()).toEqual([]);
  });

  it("cleans the staging checkout when cancellation arrives after Git exits", async () => {
    const destination = join(tempDir, "new-parent", "project");
    const abortController = new AbortController();
    vi.mocked(cloneGitRepository).mockImplementation(async (_url, stagingPath) => {
      await mkdir(stagingPath);
      await writeFile(join(stagingPath, "README.md"), "cloned");
      abortController.abort();
    });

    await expect(projectService.cloneFromGit({ repositoryUrl: "https://git.example.com/team/project.git", destinationPath: destination }, abortController.signal))
      .rejects.toThrow("Git clone was cancelled");

    await expect(lstat(join(tempDir, "new-parent"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await projectStore.list()).toEqual([]);
  });
});
