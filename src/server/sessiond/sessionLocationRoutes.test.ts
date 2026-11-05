import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerSessionLocationRoutes, type SessionLocationDependencies } from "./sessionLocationRoutes.js";

let app: FastifyInstance;

beforeEach(() => {
  app = Fastify({ logger: false });
});

afterEach(async () => {
  await app.close();
});

// "hosted-outside" models a running or archived session found by id whose folder no open project lists.
const sessions: Record<string, string> = { "in-project": "/repo/worktree", "hosted-outside": "/scratch" };
const searchedWorkspaces: (readonly string[])[] = [];

const dependencies: SessionLocationDependencies = {
  sessions: {
    findSession: (id, workspaceCwds) => {
      searchedWorkspaces.push(workspaceCwds);
      const cwd = sessions[id];
      return Promise.resolve(cwd === undefined ? undefined : { id, cwd });
    },
  },
  workspaces: { knownWorkspaces: () => Promise.resolve([{ path: "/repo", projectId: "p1", workspaceId: "w1" }, { path: "/repo/worktree", projectId: "p1", workspaceId: "w2" }]) },
};

describe("session location route", () => {
  it("names the project and workspace that list the session, searching only open workspaces", async () => {
    registerSessionLocationRoutes(app, dependencies);

    const response = await app.inject({ method: "GET", url: "/sessions/in-project/location" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ sessionId: "in-project", projectId: "p1", workspaceId: "w2" });
    expect(searchedWorkspaces.at(-1)).toEqual(["/repo", "/repo/worktree"]);
  });

  it.each(["hosted-outside", "missing"])("answers 404 for %s, which no open project lists", async (sessionId) => {
    registerSessionLocationRoutes(app, dependencies);

    const response = await app.inject({ method: "GET", url: `/sessions/${sessionId}/location` });

    expect(response.statusCode).toBe(404);
  });
});
