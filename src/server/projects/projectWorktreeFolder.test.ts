import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import type { Project } from "../../shared/apiTypes.js";
import { resolveProjectWorktreeFolder } from "./projectWorktreeFolder.js";

const project: Project = { id: "project", path: resolve("repo"), name: "Display name", createdAt: "" };
const absoluteFolder = resolve("absolute-trees");

function config(folder: string) {
  return { effectiveConfig: { defaultWorktreeFolder: folder } };
}

it("anchors a relative deployment default at the registered project root", () => {
  expect(resolveProjectWorktreeFolder(project, { ...config("../trees"), configSources: { "/defaultWorktreeFolder": "defaults" } })).toEqual({
    path: resolve(project.path, "../trees"), source: "deployment",
  });
});

it("does not append the project folder name to an absolute project override", () => {
  expect(resolveProjectWorktreeFolder({ ...project, worktreeFolder: absoluteFolder }, config("relative"))).toEqual({
    path: absoluteFolder, source: "project",
  });
});

it("resolves enforcement ahead of a saved project override", () => {
  const enforcedBy = "PI_WEB_DEFAULT_WORKTREE_FOLDER";
  expect(resolveProjectWorktreeFolder({ ...project, worktreeFolder: "saved" }, {
    ...config(absoluteFolder), enforcedSettings: { "/defaultWorktreeFolder": enforcedBy },
  })).toEqual({ path: join(absoluteFolder, "repo"), source: "environment", enforcedBy });
});
