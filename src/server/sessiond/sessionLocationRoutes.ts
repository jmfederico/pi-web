import type { FastifyInstance } from "fastify";
import type { SessionLocation } from "../../shared/apiTypes.js";
import type { KnownWorkspace } from "../status/workspaceAttribution.js";
import { cwdPathsEqual } from "../workingDirectory.js";

const MAX_SESSION_ID_LENGTH = 512;

export interface SessionLocationDependencies {
  sessions: { findSession(sessionId: string, workspaceCwds: readonly string[]): Promise<{ id: string; cwd: string } | undefined> };
  workspaces: { knownWorkspaces(): Promise<readonly KnownWorkspace[]> };
}

/**
 * Answers which project and workspace list a session given only its id, so a
 * link such as `?session=<PI_SESSION_ID>` can redirect to its full route. Only
 * sessions a workspace of an open project lists are found; paths outside open
 * projects are never searched.
 */
export function registerSessionLocationRoutes(app: FastifyInstance, dependencies: SessionLocationDependencies): void {
  app.get<{ Params: { sessionId: string } }>("/sessions/:sessionId/location", async (request, reply) => {
    const sessionId = request.params.sessionId;
    if (sessionId === "" || sessionId.length > MAX_SESSION_ID_LENGTH) return reply.code(400).send({ error: "Invalid session id" });
    const workspaces = await dependencies.workspaces.knownWorkspaces();
    const session = await dependencies.sessions.findSession(sessionId, workspaces.map((workspace) => workspace.path));
    // Hosted and archived sessions are found by id first; they too must belong to a workspace.
    const workspace = session === undefined ? undefined : workspaces.find((candidate) => cwdPathsEqual(candidate.path, session.cwd));
    if (session === undefined || workspace === undefined) return reply.code(404).send({ error: "Session not found" });
    const location: SessionLocation = { sessionId: session.id, projectId: workspace.projectId, workspaceId: workspace.workspaceId };
    return reply.header("cache-control", "no-store").send(location);
  });
}
