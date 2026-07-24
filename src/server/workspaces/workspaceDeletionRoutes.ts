import type { FastifyInstance } from "fastify";
import type { TerminalCommandRun, Workspace } from "../../shared/apiTypes.js";
import { workspaceDeletionMetadata } from "../../shared/workspaceDeletion.js";
import { isDeletableWorkspace } from "../../shared/workspaces.js";
import { SessionDaemonClient } from "../../sessiond/sessionDaemonClient.js";
import type { ProjectService } from "../projects/projectService.js";
import type { SessionProxyDaemon } from "../sessiond/sessionProxyRoutes.js";
import { validateWorkspaceDeletion, type WorkspaceDeletionValidationInput } from "./workspaceDeletionSafety.js";
import type { WorkspaceService } from "./workspaceService.js";

export interface WorkspaceDeletionRouteOptions {
  validateDeletion?: (input: WorkspaceDeletionValidationInput) => Promise<void>;
}

export function registerWorkspaceDeletionRoutes(app: FastifyInstance, projects: ProjectService, workspaces: WorkspaceService, daemon: SessionProxyDaemon = new SessionDaemonClient(), prefix = "/api", options: WorkspaceDeletionRouteOptions = {}): void {
  const validateDeletion = options.validateDeletion ?? validateWorkspaceDeletion;
  app.delete<{ Params: { projectId: string; workspaceId: string } }>(`${prefix}/projects/:projectId/workspaces/:workspaceId`, async (request, reply) => {
    try {
      return await deleteWorkspace(projects, workspaces, daemon, validateDeletion, request.params.projectId, request.params.workspaceId);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}

async function deleteWorkspace(projects: ProjectService, workspaces: WorkspaceService, daemon: SessionProxyDaemon, validateDeletion: (input: WorkspaceDeletionValidationInput) => Promise<void>, projectId: string, workspaceId: string): Promise<TerminalCommandRun> {
  const project = await projects.requireProject(projectId);
  const projectWorkspaces = await workspaces.list(project);
  const targetWorkspace = projectWorkspaces.find((workspace) => workspace.id === workspaceId);
  if (targetWorkspace === undefined) throw new Error("Workspace not found");
  if (!isDeletableWorkspace(targetWorkspace)) throw new Error("Only secondary Git worktrees or Jujutsu workspaces can be deleted");

  const commandWorkspace = projectWorkspaces.find((workspace) => workspace.isMain) ?? projectWorkspaces.find((workspace) => workspace.id !== targetWorkspace.id);
  if (commandWorkspace === undefined) throw new Error("Project main workspace not found");
  await validateDeletion({ projectPath: project.path, targetWorkspace, commandWorkspace });

  const closeResponse = await requestJson(daemon, "DELETE", `/terminals?cwd=${encodeURIComponent(targetWorkspace.path)}`);
  if (closeResponse.statusCode < 200 || closeResponse.statusCode >= 300) throw new Error(`Failed to close workspace terminals: ${responseError(closeResponse.body, closeResponse.statusCode)}`);

  const deleteResponse = await requestJson(daemon, "POST", "/terminal-command-runs", {
    origin: "core",
    projectId: project.id,
    workspaceId: commandWorkspace.id,
    cwd: commandWorkspace.path,
    title: `Delete workspace: ${workspaceLabel(targetWorkspace)}`,
    command: workspaceDeletionCommand(targetWorkspace, commandWorkspace),
    metadata: workspaceDeletionMetadata(targetWorkspace),
  });
  if (deleteResponse.statusCode < 200 || deleteResponse.statusCode >= 300) throw new Error(`Failed to start workspace deletion: ${responseError(deleteResponse.body, deleteResponse.statusCode)}`);
  return parseTerminalCommandRun(deleteResponse.body);
}

function workspaceDeletionCommand(workspace: Workspace, commandWorkspace: Workspace): string {
  if (workspace.vcs === "jj" && workspace.vcsWorkspaceName !== undefined) {
    return `jj -R ${shellQuote(commandWorkspace.path)} workspace forget ${shellQuote(workspace.vcsWorkspaceName)}`;
  }
  return `git worktree remove ${shellQuote(workspace.path)}`;
}

function workspaceLabel(workspace: Workspace): string {
  return workspace.branch ?? workspace.label;
}

async function requestJson(daemon: SessionProxyDaemon, method: string, path: string, body?: unknown): Promise<{ statusCode: number; body: unknown }> {
  const response = await daemon.request(method, path, body);
  return { statusCode: response.statusCode, body: response.body === "" ? undefined : parseJsonBody(response.body) };
}

function parseJsonBody(body: string): unknown {
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed;
  } catch (error) {
    throw new Error("Invalid JSON response from session daemon", { cause: error });
  }
}

function responseError(body: unknown, statusCode: number): string {
  if (isRecord(body) && typeof body["error"] === "string") return body["error"];
  return `HTTP ${String(statusCode)}`;
}

function parseTerminalCommandRun(value: unknown): TerminalCommandRun {
  if (!isRecord(value)) throw new Error("Invalid terminal command run response");
  const metadata = value["metadata"];
  if (!isRecord(metadata)) throw new Error("Invalid terminal command run response");
  const startedAt = optionalString(value, "startedAt");
  const exitCode = optionalNumber(value, "exitCode");
  const completedAt = optionalString(value, "completedAt");
  return {
    id: requireString(value, "id"),
    origin: requireString(value, "origin"),
    projectId: requireString(value, "projectId"),
    workspaceId: requireString(value, "workspaceId"),
    terminalId: requireString(value, "terminalId"),
    title: requireString(value, "title"),
    command: requireString(value, "command"),
    status: parseStatus(value["status"]),
    createdAt: requireString(value, "createdAt"),
    metadata: Object.fromEntries(Object.entries(metadata).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(completedAt === undefined ? {} : { completedAt }),
  };
}

function parseStatus(value: unknown): TerminalCommandRun["status"] {
  if (value === "queued" || value === "running" || value === "succeeded" || value === "failed") return value;
  throw new Error("Invalid terminal command run response");
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string") throw new Error("Invalid terminal command run response");
  return value;
}

function optionalString(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("Invalid terminal command run response");
  return value;
}

function optionalNumber(record: Record<string, unknown>, field: string): number | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== "number") throw new Error("Invalid terminal command run response");
  return value;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
