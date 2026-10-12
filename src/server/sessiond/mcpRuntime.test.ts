import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { Project, WorkspaceProviderAuthorityResolution } from "../../shared/apiTypes.js";
import { registerSessionDaemonMcpRoutes } from "./mcpRuntime.js";

describe("daemon MCP assembly", () => {
  it("uses the captured profile and resolves only the current managed workspace before persisting a toggle", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-mcp-runtime-"));
    const agentDir = join(root, "active-profile");
    const workspaceRoot = join(root, "managed-workspace");
    const userConfig = join(agentDir, "mcp.json");
    const projectConfig = join(workspaceRoot, ".pi", "mcp.json");
    const app = Fastify({ logger: false });
    try {
      await mkdir(agentDir);
      await mkdir(join(workspaceRoot, ".pi"), { recursive: true });
      await writeFile(userConfig, JSON.stringify({ mcpServers: { user_tools: { command: "must-not-run" } } }));
      await writeFile(projectConfig, JSON.stringify({ mcpServers: { project_tools: { command: "must-not-run", env: { SECRET: "private" } } } }));
      const project: Project = { id: "p1", name: "Repo", path: root, createdAt: "now" };
      let exists = true;
      registerSessionDaemonMcpRoutes(app, {
        agentDir,
        projects: { requireProject: (id) => id === project.id ? Promise.resolve(project) : Promise.reject(new Error("Project not found")) },
        workspaces: { resolve: () => Promise.resolve<WorkspaceProviderAuthorityResolution>({
          status: "folder", projectId: project.id, diagnostics: [],
          workspaces: exists ? [{ id: "w1", projectId: project.id, label: "Workspace", path: workspaceRoot, isMain: true }] : [],
        }) },
      });
      const machine = await app.inject({ method: "GET", url: "/mcp" });
      expect(machine.json()).toMatchObject({ userConfigPath: userConfig, servers: [{ name: "user_tools" }] });
      const toggled = await app.inject({ method: "PUT", url: "/projects/p1/workspaces/w1/mcp/servers/project_tools", payload: { scope: "project", enabled: false } });
      expect(toggled.statusCode).toBe(200);
      expect(toggled.json()).toMatchObject({ projectConfigPath: projectConfig });
      const persisted: unknown = JSON.parse(await readFile(projectConfig, "utf8"));
      expect(persisted).toEqual({ mcpServers: { project_tools: { command: "must-not-run", env: { SECRET: "private" }, enabled: false } } });
      expect(machine.body + toggled.body).not.toContain("private");
      exists = false;
      const staleWorkspace = await app.inject({ method: "GET", url: "/projects/p1/workspaces/w1/mcp" });
      expect(staleWorkspace.statusCode).toBe(404);
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
