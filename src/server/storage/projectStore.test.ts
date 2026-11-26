import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectStore, projectStorePath } from "./projectStore.js";

describe("projectStorePath", () => {
  it("uses PI_WEB_DATA_DIR by default", () => {
    expect(projectStorePath({ PI_WEB_DATA_DIR: "demo-data" }, "/tmp/pi-web")).toBe(resolve("/tmp/pi-web", "demo-data", "projects.json"));
  });

  it("uses PI_WEB_PROJECTS_FILE when configured", () => {
    expect(projectStorePath({ PI_WEB_PROJECTS_FILE: "demo/projects.json" }, "/tmp/pi-web")).toBe(resolve("/tmp/pi-web", "demo/projects.json"));
  });
});

describe("ProjectStore.rename", () => {
  let dir: string;
  let store: ProjectStore;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pi-web-project-store-"));
    store = new ProjectStore(join(dir, "projects.json"));
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("persists a trimmed display name without changing the project's identity", async () => {
    const project = await store.add({ path: "/srv/app" });
    const other = await store.add({ path: "/srv/other" });

    await expect(store.rename(project.id, "  Billing app  ")).resolves.toEqual({ ...project, name: "Billing app" });
    expect(await new ProjectStore(join(dir, "projects.json")).list()).toEqual([{ ...project, name: "Billing app" }, other]);
    // Re-adding the same folder keeps the chosen name.
    await expect(store.add({ path: "/srv/app" })).resolves.toMatchObject({ id: project.id, name: "Billing app" });
  });

  it("restores the folder name for a blank name", async () => {
    const project = await store.add({ name: "Custom", path: "/srv/app" });
    await expect(store.rename(project.id, "   ")).resolves.toMatchObject({ name: "app" });
  });

  it("reports an unknown project without writing", async () => {
    await expect(store.rename("missing", "Name")).resolves.toBeUndefined();
    expect(await store.list()).toEqual([]);
  });
});
