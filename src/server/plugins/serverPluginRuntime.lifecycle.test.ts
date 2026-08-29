import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PiWebServerPlugin, ServerPluginActivationContext } from "../../server-plugin-api.js";
import type { PiWebPluginCatalogEntry } from "../piWebPluginCatalog.js";
import { createServerPluginRuntime, preparePluginStateDirectory } from "./serverPluginRuntime.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function entry(id: string): PiWebPluginCatalogEntry {
  return {
    id,
    packageRoot: join("/plugins", id),
    browserRoot: { path: "browser", directoryPath: join("/plugins", id, "browser") },
    browserModule: { path: "browser/plugin.js", filePath: join("/plugins", id, "browser/plugin.js"), revision: "browser-r1" },
    serverModule: { path: "server.js", filePath: join("/plugins", id, "server.js"), revision: "server-r1" },
    source: "fixture",
    scope: "local",
    machineSpecific: true,
    enabled: true,
    settings: {},
    settingsRevision: "settings-r1",
  };
}

describe("server plugin late lifecycle and storage", () => {
  it("creates canonical private state, contains ready failure, publishes only ready backends, and quiesces in reverse", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-plugin-lifecycle-"));
    roots.push(root);
    const events: string[] = [];
    const contexts = new Map<string, ServerPluginActivationContext>();
    const importer = (url: string) => {
      const id = new URL(url).pathname.split("/").at(-2) ?? "";
      const plugin: PiWebServerPlugin = {
        apiVersion: 1,
        name: id,
        activate(context) {
          contexts.set(id, context);
          return {
            workspaceProvider: {
              probe: () => Promise.resolve("claim"),
              list: () => Promise.resolve([]),
            },
            workspaceBackend: { request: () => Promise.resolve(null) },
            ready: (_readyContext, signal) => {
              events.push(`ready:${id}:${String(signal.aborted)}`);
              if (id === "bad") throw new Error("ready exploded");
            },
            quiesce: () => {
              events.push(`quiesce:${id}`);
              if (id === "bad") throw new Error("quiesce exploded");
            },
            stop: () => { events.push(`stop:${id}`); },
          };
        },
      };
      return Promise.resolve({ default: plugin });
    };
    const runtime = await createServerPluginRuntime({
      catalog: { snapshot: () => Promise.resolve({ plugins: [entry("good"), entry("bad")], diagnostics: [] }) },
      importer,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      pluginStateRoot: join(root, "plugin-state"),
    });

    expect(runtime.workspaceBackendContributions()).toEqual([]);
    expect(runtime.providerContributions().map(({ pluginId }) => pluginId)).toEqual(["bad", "good"]);
    const cleanupFailedPlugin = vi.fn(() => Promise.resolve());
    await runtime.ready(
      () => Object.freeze({ backgroundSessions: Object.freeze({ listModels: () => [], create: () => Promise.reject(new Error("unused")) }) }),
      cleanupFailedPlugin,
    );

    expect(runtime.workspaceBackendContributions().map(({ pluginId }) => pluginId)).toEqual(["good"]);
    expect(runtime.providerContributions().map(({ pluginId }) => pluginId)).toEqual(["good"]);
    expect(cleanupFailedPlugin).toHaveBeenCalledExactlyOnceWith("bad");
    expect(runtime.healthRecords()).toContainEqual(expect.objectContaining({ pluginId: "bad", state: "failed", phase: "ready", message: "ready exploded" }));
    expect(contexts.get("good")?.stateDirectory).toBe(await realpath(join(root, "plugin-state", "good")));
    expect(Object.isFrozen(contexts.get("good"))).toBe(true);

    await runtime.quiesce();
    await runtime.quiesce();
    expect(runtime.healthRecords()).toContainEqual(expect.objectContaining({ pluginId: "bad", state: "failed", phase: "quiesce", message: "quiesce exploded" }));
    await runtime.stop();

    expect(events).toEqual([
      "ready:bad:false",
      "ready:good:false",
      "quiesce:good",
      "quiesce:bad",
      "stop:good",
      "stop:bad",
    ]);
  });

  it("records backend request capability separately from active server pairing", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-plugin-capability-"));
    roots.push(root);
    const importer = (url: string) => {
      const id = new URL(url).pathname.split("/").at(-2) ?? "";
      const workspaceProvider = {
        probe: () => Promise.resolve<"pass">("pass"),
        list: () => Promise.resolve([]),
      };
      const plugin: PiWebServerPlugin = {
        apiVersion: 1,
        name: id,
        activate: () => id === "lifecycle-only"
          ? { start: () => undefined }
          : id === "provider-only"
            ? { workspaceProvider }
            : id === "provider-request"
              ? { workspaceProvider: { ...workspaceProvider, request: () => Promise.resolve(null) } }
              : { workspaceBackend: { request: () => Promise.resolve(null) } },
      };
      return Promise.resolve({ default: plugin });
    };
    const runtime = await createServerPluginRuntime({
      catalog: {
        snapshot: () => Promise.resolve({
          plugins: [entry("lifecycle-only"), entry("provider-only"), entry("provider-request"), entry("auxiliary-backend")],
          diagnostics: [],
        }),
      },
      importer,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      pluginStateRoot: join(root, "plugin-state"),
    });

    expect(runtime.healthRecords().map(({ pluginId, backendAvailable }) => ({ pluginId, backendAvailable }))).toEqual([
      { pluginId: "auxiliary-backend", backendAvailable: true },
      { pluginId: "lifecycle-only", backendAvailable: undefined },
      { pluginId: "provider-only", backendAvailable: undefined },
      { pluginId: "provider-request", backendAvailable: true },
    ]);
    await runtime.stop();
  });

  it("rejects traversal and a symlinked plugin state directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-plugin-storage-"));
    const outside = await mkdtemp(join(tmpdir(), "pi-web-plugin-storage-outside-"));
    roots.push(root, outside);

    await expect(preparePluginStateDirectory(root, "../escape")).rejects.toThrow("escapes its root");
    await symlink(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    await expect(preparePluginStateDirectory(root, "linked")).rejects.toThrow(/not a directory|escapes its root/u);
  });
});
