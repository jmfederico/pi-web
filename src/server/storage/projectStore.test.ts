import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ProjectStore, projectStorePath } from "./projectStore.js";

describe("projectStorePath", () => {
  it("uses PI_WEB_DATA_DIR by default", () => {
    expect(projectStorePath({ PI_WEB_DATA_DIR: "demo-data" }, "/tmp/pi-web")).toBe(resolve("/tmp/pi-web", "demo-data", "projects.json"));
  });

  it("uses PI_WEB_PROJECTS_FILE when configured", () => {
    expect(projectStorePath({ PI_WEB_PROJECTS_FILE: "demo/projects.json" }, "/tmp/pi-web")).toBe(resolve("/tmp/pi-web", "demo/projects.json"));
  });

  it("keeps registered projects available to a newly started store", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-web-project-store-"));
    const filePath = join(directory, "projects.json");
    try {
      const originalStore = new ProjectStore(filePath);
      const project = await originalStore.add({ path: "/workspaces/persistent" });

      await expect(new ProjectStore(filePath).list()).resolves.toEqual([project]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
