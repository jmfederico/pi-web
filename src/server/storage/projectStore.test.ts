import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { projectStorePath } from "./projectStore.js";

describe("projectStorePath", () => {
  it("uses PI_WEB_DATA_DIR by default", () => {
    expect(projectStorePath({ PI_WEB_DATA_DIR: "demo-data" }, "/tmp/pi-web")).toBe(resolve("/tmp/pi-web", "demo-data", "projects.json"));
  });

  it("uses PI_WEB_PROJECTS_FILE when configured", () => {
    expect(projectStorePath({ PI_WEB_PROJECTS_FILE: "demo/projects.json" }, "/tmp/pi-web")).toBe(resolve("/tmp/pi-web", "demo/projects.json"));
  });
});
