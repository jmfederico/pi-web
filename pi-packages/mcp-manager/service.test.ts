import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { JsonValue, PiWebHostPiSessionConnection, PluginSessionSelection, ServerPluginPeerScope, SessionStateSnapshot } from "@jmfederico/pi-web/server-plugin-api";
import { createManagedMcpConfigService } from "./config.js";
import { McpManagerService, type McpManagerDependencies } from "./service.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mcp-manager-service-"));
  roots.push(root);
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  await mkdir(join(agentDir, "mcp-manager"), { recursive: true });
  await mkdir(join(cwd, ".pi"), { recursive: true });
  const globalPath = join(agentDir, "mcp-manager", "config.json");
  await writeFile(globalPath, JSON.stringify({ servers: { docs: { url: "https://private.example/mcp", headers: { Authorization: "secret-token" } } }, enabledServers: [] }));
  await writeFile(join(cwd, ".pi", "mcp-manager.json"), JSON.stringify({ servers: { local: { command: "private-command", args: ["secret-arg"] } }, enabledServers: [] }));
  let state: SessionStateSnapshot = { revision: "" };
  const refreshes: { selection: PluginSessionSelection; action: string }[] = [];
  const close = vi.fn();
  const write = vi.fn<McpManagerDependencies["states"]["write"]>((_selection, _namespace, input) => {
    if (input.revision !== state.revision) throw new Error("Stale state");
    state = { revision: "entry-1", value: input.value };
    return Promise.resolve(state);
  });
  const read = vi.fn<McpManagerDependencies["states"]["read"]>(() => Promise.resolve(state));
  const trust = vi.fn(() => Promise.resolve(true));
  const deps: McpManagerDependencies = {
    config: createManagedMcpConfigService({ agentDir, env: {} }), agentDir,
    states: { version: 1, read, write }, trust: { version: 1, get: trust },
    events: { version: 1, connect: vi.fn((selection: PluginSessionSelection): Promise<PiWebHostPiSessionConnection> => {
      let receive: ((value: unknown) => void | Promise<void>) | undefined;
      return Promise.resolve({
        signal: new AbortController().signal,
        on: (_channel, handler) => { receive = handler; return () => { receive = undefined; }; },
        emit: (_channel, input) => {
          if (typeof input !== "object" || input === null) throw new Error("Invalid fixture request");
          const action: unknown = Reflect.get(input, "action");
          if (typeof action !== "string") throw new Error("Missing action");
          refreshes.push({ selection, action });
          const id: unknown = Reflect.get(input, "id");
          void receive?.({ id, projectTrusted: true, state: { pending: false, servers: [], errors: [] } });
        },
        close,
      });
    }) },
    catalog: {
      version: 1,
      projects: { list: () => Promise.resolve([{ id: "project", name: "Project", path: cwd }]), get: () => Promise.reject(new Error("Unused")) },
      workspaces: { list: () => Promise.resolve([{ id: "workspace", projectId: "project", path: cwd, label: "Main", isMain: true }]), get: () => Promise.reject(new Error("Unused")) },
      sessions: { list: () => Promise.resolve([
        { id: "active", cwd, archived: false, created: null, modified: null, archivedAt: null, pinned: false, runtime: "busy" as const },
        { id: "saved", cwd, archived: false, created: null, modified: null, archivedAt: null, pinned: false, runtime: "not-hosted" as const },
      ]), get: () => Promise.reject(new Error("Unused")) },
    },
  };
  const scope: ServerPluginPeerScope = { kind: "workspace", project: { id: "project", name: "Project", path: cwd }, workspace: { id: "workspace", projectId: "project", path: cwd, label: "Main", isMain: true } };
  const service = new McpManagerService(deps);
  const request = (operation: string, input: JsonValue, target: ServerPluginPeerScope = scope) => service.request({ operation, input, scope: target, signal: new AbortController().signal });
  return { request, deps, trust, read, write, close, refreshes, agentDir, cwd, globalPath };
}

it("uses host workspace authority and exposes no MCP definitions or credentials", async () => {
  const f = await fixture();
  const view = await f.request("view", { sessionId: "selected" });
  expect(view.servers.map((row) => row.name)).toEqual(["docs", "local"]);
  const text = JSON.stringify(view);
  for (const secret of ["secret-token", "private.example", "private-command", "secret-arg"]) expect(text).not.toContain(secret);
  expect(f.read).toHaveBeenCalledWith({ projectId: "project", workspaceId: "workspace", sessionId: "selected" }, "mcp-manager", expect.anything());
  await expect(f.request("view", { cwd: "/outside" })).rejects.toThrow("Unknown MCP request field");
  await expect(f.request("view", { sessionId: "selected" }, { kind: "machine" })).rejects.toThrow("require a workspace");
  f.trust.mockResolvedValue(false);
  expect((await f.request("view", {})).servers.map((row) => row.name)).toEqual(["docs"]);
});

it("persists inheritable session choices with optimistic state revision and refreshes the companion", async () => {
  const f = await fixture();
  const before = await f.request("view", { sessionId: "selected" });
  const after = await f.request("update", { sessionId: "selected", scope: "session", serverName: "docs", enabled: true, revision: before.revision });
  expect(f.write).toHaveBeenCalledWith({ projectId: "project", workspaceId: "workspace", sessionId: "selected" }, "mcp-manager", {
    value: { version: 1, enabledServers: ["docs"] }, inherit: true, revision: "",
  }, expect.anything());
  expect(after.servers.find((row) => row.name === "docs")).toMatchObject({ enabled: { session: true }, effectiveEnabled: true });
  expect(f.refreshes.at(-1)).toMatchObject({ selection: { sessionId: "selected" }, action: "refresh" });
  await expect(f.request("update", { sessionId: "selected", scope: "session", serverName: "docs", enabled: false, revision: before.revision })).rejects.toThrow("changed");
  expect(f.write).toHaveBeenCalledOnce();
  expect(f.close).toHaveBeenCalledTimes(f.refreshes.length);
});

it("refreshes hosted sessions after file changes without starting saved conversations", async () => {
  const f = await fixture();
  const before = await f.request("view", {}, { kind: "machine" });
  const after = await f.request("update", { scope: "global", serverName: "docs", enabled: true, revision: before.revision }, { kind: "machine" });
  expect(JSON.parse(await readFile(f.globalPath, "utf8"))).toMatchObject({ enabledServers: ["docs"], servers: { docs: { headers: { Authorization: "secret-token" } } } });
  expect(after.servers[0]?.effectiveEnabled).toBe(true);
  expect(f.refreshes).toEqual([{ selection: { projectId: "project", workspaceId: "workspace", sessionId: "active" }, action: "refresh" }]);
  expect(f.read).not.toHaveBeenCalled();
});

it("keeps native authority and reports a missing companion instead of claiming a working loader", async () => {
  const f = await fixture();
  await writeFile(join(f.agentDir, "mcp.json"), JSON.stringify({ mcpServers: { docs: { enabled: false, url: "https://native.example" } } }));
  const view = await f.request("view", {}, { kind: "machine" });
  expect(view.servers[0]?.nativeConflict).toBe(true);
  await expect(f.request("update", { scope: "global", serverName: "docs", enabled: true, revision: view.revision }, { kind: "machine" })).rejects.toThrow("mcp.json");
  vi.mocked(f.deps.events.connect).mockRejectedValue(new Error("No runtime"));
  const unavailable = await f.request("view", { sessionId: "selected" });
  expect(unavailable.sessionWritable).toBe(false);
  expect(unavailable.issues.length).toBeGreaterThan(0);
});
