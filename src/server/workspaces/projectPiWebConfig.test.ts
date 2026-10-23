import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, mkdtemp, open, rm, symlink, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ATTACHMENT_FOLDER } from "../../config.js";
import { loadEffectiveProjectAttachmentsConfig, loadEffectiveProjectPathAccess, loadEffectiveProjectUploadsConfig, loadProjectPiWebConfig, mergePathAccessConfigs, PROJECT_PI_WEB_CONFIG_PATH } from "./projectPiWebConfig.js";

// Node's ESM exports are not configurable; replace only the open boundary.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

let tempDir: string;
let projectPath: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-web-project-config-test-"));
  projectPath = join(tempDir, "project");
  await mkdir(projectPath, { recursive: true });
});

afterEach(async () => {
  vi.mocked(open).mockReset();
  vi.restoreAllMocks();
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

  it("rejects an already-cancelled load even when the config is absent", async () => {
    const controller = new AbortController();
    const reason = new Error("config load cancelled");
    controller.abort(reason);

    await expect(loadProjectPiWebConfig(projectPath, controller.signal)).rejects.toBe(reason);
  });

  it("passes cancellation to the descriptor read, preserves its reason, and closes the file", async () => {
    await writeProjectConfig({});
    const controller = new AbortController();
    const reason = new Error("config read cancelled");
    const handle = await open(join(projectPath, PROJECT_PI_WEB_CONFIG_PATH), "r");
    try {
      vi.mocked(open).mockResolvedValueOnce(handle);
      const close = vi.spyOn(handle, "close");
      const read = vi.spyOn(handle, "readFile").mockImplementationOnce(() => {
        controller.abort(reason);
        return Promise.reject(new DOMException("read aborted", "AbortError"));
      });
      await expect(loadProjectPiWebConfig(projectPath, controller.signal)).rejects.toBe(reason);
      expect(read).toHaveBeenCalledWith({ encoding: "utf8", signal: controller.signal });
      expect(close).toHaveBeenCalledOnce();
    } finally {
      await handle.close();
    }
  });

  it("follows symlinks to regular config files", async () => {
    const path = join(projectPath, PROJECT_PI_WEB_CONFIG_PATH);
    const target = join(tempDir, "shared-config.json");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(target, '{"version":1}');
    await symlink(target, path, "file");

    await expect(loadProjectPiWebConfig(projectPath)).resolves.toEqual({ path, exists: true, config: { version: 1 } });
  });

  it("rejects a directory instead of reading it as config", async () => {
    const path = join(projectPath, PROJECT_PI_WEB_CONFIG_PATH);
    await mkdir(path, { recursive: true });

    await expect(loadProjectPiWebConfig(projectPath)).rejects.toThrow(`must be a regular file: ${path}`);
  });

  // Windows does not support POSIX FIFOs, even when Git Bash supplies mkfifo.
  it.skipIf(process.platform === "win32").each(["direct", "symlink"])("rejects a %s FIFO before opening it", async (kind) => {
    const path = join(projectPath, PROJECT_PI_WEB_CONFIG_PATH);
    const fifo = kind === "direct" ? path : join(tempDir, "config-fifo");
    await mkdir(dirname(path), { recursive: true });
    execFileSync("mkfifo", [fifo]);
    if (kind === "symlink") await symlink(fifo, path, "file");

    await expect(loadProjectPiWebConfig(projectPath)).rejects.toThrow(`must be a regular file: ${path}`);
    expect(open).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")("rejects a FIFO swapped in after the regular-file check without blocking open", async () => {
    await writeProjectConfig({});
    const path = join(projectPath, PROJECT_PI_WEB_CONFIG_PATH);
    const { open: originalOpen } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let descriptor: FileHandle | undefined;
    vi.mocked(open).mockImplementationOnce(async (target, flags, mode) => {
      await unlink(path);
      execFileSync("mkfifo", [path]);
      descriptor = await originalOpen(target, flags, mode);
      return descriptor;
    });

    try {
      await expect(loadProjectPiWebConfig(projectPath)).rejects.toThrow(`must be a regular file: ${path}`);
      expect(open).toHaveBeenCalledWith(path, constants.O_RDONLY | constants.O_NONBLOCK);
      expect(descriptor?.fd).toBe(-1);
    } finally {
      if (descriptor !== undefined) await descriptor.close();
    }
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

  it("loads generic plugin settings without interpreting plugin-owned values", async () => {
    const plugins = {
      "example.plugin": { settings: { text: "value", count: 0, enabledFeature: false, optional: null, nested: { list: [1, "two", null] } } },
      "empty.plugin": {},
    };
    await writeProjectConfig({ version: 1, plugins });

    expect((await loadProjectPiWebConfig(projectPath)).config.plugins).toEqual(plugins);
  });

  it("continues to read live config edits when no snapshot service is used", async () => {
    await writeProjectConfig({ plugins: { example: { settings: { revision: 1 } } } });
    expect((await loadProjectPiWebConfig(projectPath)).config.plugins?.["example"]?.settings).toEqual({ revision: 1 });
    await writeProjectConfig({ plugins: { example: { settings: { revision: 2 } } } });
    expect((await loadProjectPiWebConfig(projectPath)).config.plugins?.["example"]?.settings).toEqual({ revision: 2 });
  });

  it.each([
    { plugins: [], message: "plugins must be an object" },
    { plugins: null, message: "plugins must be an object" },
    { plugins: { "Bad ID": {} }, message: "plugin ids must match" },
    { plugins: { example: [] }, message: "plugin entries must be objects" },
    { plugins: { example: null }, message: "plugin entries must be objects" },
    { plugins: { example: { settings: [] } }, message: "settings" },
    { plugins: { example: { settings: null } }, message: "settings" },
    { plugins: { example: { settings: "not an object" } }, message: "settings" },
  ])("rejects invalid project plugin shapes: $plugins", async ({ plugins, message }) => {
    await writeProjectConfig({ plugins });

    await expect(loadProjectPiWebConfig(projectPath)).rejects.toThrow(message);
    await expect(loadProjectPiWebConfig(projectPath)).rejects.toThrow(join(projectPath, PROJECT_PI_WEB_CONFIG_PATH));
  });

  it.each([true, false, null])("rejects project plugin enabled=%s instead of implying per-project activation", async (enabled) => {
    await writeProjectConfig({ plugins: { example: { enabled, settings: {} } } });

    await expect(loadProjectPiWebConfig(projectPath)).rejects.toThrow("plugins.example.enabled is not supported; plugin activation is global");
  });

  it("rejects non-finite numbers in parsed settings", async () => {
    const path = join(projectPath, PROJECT_PI_WEB_CONFIG_PATH);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '{"plugins":{"example":{"settings":{"nested":[1e999]}}}}');

    await expect(loadProjectPiWebConfig(projectPath)).rejects.toThrow("must contain only JSON values");
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
