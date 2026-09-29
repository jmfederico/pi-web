import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_ATTACHMENT_FOLDER } from "../../config.js";
import { loadEffectiveProjectAttachmentsConfig, loadEffectiveProjectPathAccess, loadEffectiveProjectUploadsConfig, loadProjectPiWebConfig, mergePathAccessConfigs, PROJECT_PI_WEB_CONFIG_PATH } from "./projectPiWebConfig.js";

let tempDir: string;
let projectPath: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-web-project-config-test-"));
  projectPath = join(tempDir, "project");
  await mkdir(projectPath, { recursive: true });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("project PI WEB config", () => {
  it("returns an empty config when the project-local config is absent", async () => {
    await expect(loadProjectPiWebConfig(projectPath)).resolves.toEqual({
      path: join(projectPath, PROJECT_PI_WEB_CONFIG_PATH),
      exists: false,
      config: {},
    });
  });

  it("loads project-local path access and upload config", async () => {
    await writeProjectConfig({ version: 1, pathAccess: { allowedPaths: ["/tmp", "~/SDKs"] }, uploads: { defaultFolder: "manual\\incoming" } });

    await expect(loadProjectPiWebConfig(projectPath)).resolves.toEqual({
      path: join(projectPath, PROJECT_PI_WEB_CONFIG_PATH),
      exists: true,
      config: { version: 1, pathAccess: { allowedPaths: ["/tmp", "~/SDKs"] }, uploads: { defaultFolder: "manual/incoming" } },
    });
  });

  it("loads project-local attachment config", async () => {
    await writeProjectConfig({ version: 1, attachments: { defaultFolder: "agent\\dropped" } });

    await expect(loadProjectPiWebConfig(projectPath)).resolves.toEqual({
      path: join(projectPath, PROJECT_PI_WEB_CONFIG_PATH),
      exists: true,
      config: { version: 1, attachments: { defaultFolder: "agent/dropped" } },
    });
  });

  it("rejects unsupported project config versions", async () => {
    await writeProjectConfig({ version: 2 });

    await expect(loadProjectPiWebConfig(projectPath)).rejects.toThrow("PI WEB project config version must be 1");
  });

  it("reuses PI WEB path access schema validation", async () => {
    await writeProjectConfig({ version: 1, pathAccess: { allowedPaths: [""] } });

    await expect(loadProjectPiWebConfig(projectPath)).rejects.toThrow("PI WEB config pathAccess.allowedPaths must be an array of non-empty strings");
  });

  it("reuses PI WEB upload schema validation", async () => {
    await writeProjectConfig({ version: 1, uploads: { defaultFolder: "../outside" } });

    await expect(loadProjectPiWebConfig(projectPath)).rejects.toThrow("PI WEB config uploads.defaultFolder must not contain path traversal");
  });

  it("reuses PI WEB attachment schema validation", async () => {
    await writeProjectConfig({ version: 1, attachments: { defaultFolder: "../outside" } });

    await expect(loadProjectPiWebConfig(projectPath)).rejects.toThrow("PI WEB config attachments.defaultFolder must not contain path traversal");
  });

  it("merges global and project path access in order", async () => {
    await writeProjectConfig({ version: 1, pathAccess: { allowedPaths: ["/project-sdk", "/shared"] } });

    await expect(loadEffectiveProjectPathAccess(projectPath, { pathAccess: { allowedPaths: ["/global-sdk", "/shared"] } })).resolves.toEqual({
      allowedPaths: ["/global-sdk", "/shared", "/project-sdk"],
    });
  });

  it("lets project upload defaults override global upload defaults", async () => {
    await writeProjectConfig({ version: 1, uploads: { defaultFolder: "project-uploads" } });

    await expect(loadEffectiveProjectUploadsConfig(projectPath, { uploads: { defaultFolder: "global-uploads" } })).resolves.toEqual({
      defaultFolder: "project-uploads",
    });
  });

  it("lets project attachment defaults override global attachment defaults", async () => {
    await writeProjectConfig({ version: 1, attachments: { defaultFolder: "project-attachments" } });

    await expect(loadEffectiveProjectAttachmentsConfig(projectPath, { attachments: { defaultFolder: "global-attachments" } })).resolves.toEqual({
      defaultFolder: "project-attachments",
    });
  });

  it("falls back to the built-in attachment default when nothing is configured", async () => {
    await expect(loadEffectiveProjectAttachmentsConfig(projectPath, {})).resolves.toEqual({
      defaultFolder: DEFAULT_ATTACHMENT_FOLDER,
    });
  });
});

describe("mergePathAccessConfigs", () => {
  it("returns undefined when no roots are configured", () => {
    expect(mergePathAccessConfigs(undefined, {})).toBeUndefined();
  });

  it("deduplicates configured roots", () => {
    expect(mergePathAccessConfigs({ allowedPaths: ["/a", "/b"] }, { allowedPaths: ["/b", "/c"] })).toEqual({ allowedPaths: ["/a", "/b", "/c"] });
  });
});

async function writeProjectConfig(value: unknown): Promise<void> {
  const path = join(projectPath, PROJECT_PI_WEB_CONFIG_PATH);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
