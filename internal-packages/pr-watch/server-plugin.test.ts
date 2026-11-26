import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginCapability, ServerPluginActivationContextV5 } from "@jmfederico/pi-web/server-plugin-api";
import { activatePrWatch } from "./server-plugin.js";
import { PR_URL, snapshot } from "./testSupport.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const project = { id: "project", name: "Project", path: "/work" };
const workspace = { id: "workspace", projectId: project.id, path: "/work", label: "main", isMain: true };

async function context(settings: ServerPluginActivationContextV5["settings"] = {}) {
  const root = await mkdtemp(join(tmpdir(), "pr-watch-plugin-"));
  roots.push(root);
  const lifetime = new AbortController();
  const value: ServerPluginActivationContextV5 = {
    apiVersion: 5, pluginId: "pr-watch", packageRoot: "/package", dataDirectory: root, settings,
    signal: new AbortController().signal, lifetimeSignal: lifetime.signal,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    execFile: () => Promise.reject(new Error("Unexpected command")),
  };
  return { value, lifetime, root };
}

describe("PR watch server plugin", () => {
  it("serves companion requests at machine scope and persists subscriptions until disposal", async () => {
    const { value, lifetime, root } = await context({ pollIntervalSeconds: 3600 });
    const activation = activatePrWatch(value, {
      github: {
        resolve: () => Promise.resolve({ host: "github.com", owner: "owner", repo: "repo", number: 7, url: PR_URL, title: "Add feature", state: "open" }),
        snapshot: () => Promise.resolve(snapshot()),
      },
    });
    await activation.start?.({ signal: new AbortController().signal, capabilities: {
      resolve<Value>(capability: PluginCapability<Value>): Value {
        if (capability.id === "catalog") return capability.parse({ version: 1,
          projects: { list: () => Promise.resolve([project]), get: () => Promise.resolve(project) },
          workspaces: { list: () => Promise.resolve([workspace]), get: () => Promise.resolve(workspace) },
          sessions: {
            list: () => Promise.resolve([]),
            get: () => Promise.resolve({ id: "session", cwd: "/work", archived: false, created: null, modified: null, archivedAt: null, pinned: false, runtime: "busy" }),
          },
        });
        if (capability.id === "session-state") return capability.parse({ version: 1, read: vi.fn(), write: vi.fn() });
        return capability.parse({ version: 1, connect: vi.fn() });
      },
    } });
    const peer = activation.peer;
    if (peer?.request === undefined) throw new Error("Missing request handler");
    const input = { sessionId: "session", cwd: "/work", pr: "7" };
    const signal = new AbortController().signal;
    await expect(Promise.resolve(peer.request({ scope: { kind: "project", project }, operation: "subscribe", input, signal }))).rejects.toThrow("machine scope");
    await expect(Promise.resolve(peer.request({ scope: { kind: "machine" }, operation: "subscribe", input, signal }))).resolves.toMatchObject({ subscription: { pullRequest: "owner/repo#7" } });
    expect(await activation.health?.(signal)).toEqual({ status: "healthy" });

    lifetime.abort();
    await activation.dispose?.(signal);
    const saved: unknown = JSON.parse(await readFile(join(root, "subscriptions.json"), "utf8"));
    expect(saved).toMatchObject({ version: 1, subscriptions: [{ sessionId: "session", projectId: "project", workspaceId: "workspace" }] });
  });

  it("fails activation on invalid settings instead of guessing", async () => {
    const { value } = await context({ pollIntervalSeconds: 1, unknownKey: true });
    expect(() => activatePrWatch(value)).toThrow("Unknown pr-watch settings: unknownKey");
  });
});
