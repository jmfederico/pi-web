import { existsSync } from "node:fs";
import { join } from "node:path";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { ProjectStore } from "./storage/projectStore.js";
import { ProjectService } from "./projects/projectService.js";
import { WorkspaceService } from "./workspaces/workspaceService.js";
import { listFileSuggestions, listPathSuggestions } from "./workspaces/fileSuggestions.js";
import { listDirectorySuggestions } from "./projects/directorySuggestions.js";
import { registerSessionProxyRoutes } from "./sessiond/sessionProxyRoutes.js";
import { registerWorkspaceExplorerRoutes } from "./workspaceExplorerRoutes.js";
import { registerGitRoutes } from "./gitRoutes.js";

const app = Fastify({ logger: true });
await app.register(fastifyWebsocket);

const projects = new ProjectService(new ProjectStore());
const workspaces = new WorkspaceService();

app.get("/api/projects", async () => projects.list());

app.post<{ Body: { name?: string; path: string; create?: boolean } }>("/api/projects", async (request, reply) => {
  try {
    return await projects.add(request.body);
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.delete<{ Params: { projectId: string } }>("/api/projects/:projectId", async (request, reply) => {
  try {
    await projects.close(request.params.projectId);
    return { closed: true };
  } catch (error) {
    return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get<{ Querystring: { q?: string } }>("/api/project-directories", async (request, reply) => {
  try {
    return await listDirectorySuggestions(request.query.q ?? "");
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/workspaces", async (request, reply) => {
  try {
    const project = await projects.requireProject(request.params.projectId);
    return await workspaces.list(project);
  } catch (error) {
    return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
  }
});

registerSessionProxyRoutes(app);
registerWorkspaceExplorerRoutes(app, projects, workspaces);
registerGitRoutes(app, projects, workspaces);

app.get<{ Querystring: { cwd?: string; q?: string; kind?: "tracked" | "untracked" | "other"; mode?: "file" | "path" } }>("/api/files", async (request, reply) => {
  if (request.query.cwd === undefined || request.query.cwd === "") return reply.code(400).send({ error: "cwd query parameter is required" });
  try {
    if (request.query.mode === "path") return await listPathSuggestions(request.query.cwd, request.query.q ?? "");
    return await listFileSuggestions(request.query.cwd, request.query.q ?? "", request.query.kind);
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
  }
});

const clientDist = join(process.cwd(), "dist", "client");
if (existsSync(clientDist)) {
  await app.register(fastifyStatic, { root: clientDist });
  app.setNotFoundHandler((_request, reply) => reply.sendFile("index.html"));
}

const port = Number(process.env["PI_WEB_PORT"] ?? process.env["PORT"] ?? 3000);
const host = process.env["PI_WEB_HOST"] ?? "127.0.0.1";
await app.listen({ port, host });
