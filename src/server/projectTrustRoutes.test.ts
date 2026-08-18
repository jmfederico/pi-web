import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import type { WorkspaceTrustResponse } from "../shared/apiTypes.js";
import { ProjectService } from "./projects/projectService.js";
import { ProjectStore } from "./storage/projectStore.js";
import type { Project, WorkspaceListing } from "./types.js";
import type { WorkspaceCatalog } from "./workspaces/workspaceCatalog.js";
import { registerProjectTrustRoutes } from "./projectTrustRoutes.js";

let app: FastifyInstance;
let agentDir: string;
let projectDir: string;
const cleanup: string[] = [];

const TRUST_URL = "/api/projects/p1/workspaces/w1/trust";

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
}

class FakeProjectService extends ProjectService {
  constructor(private readonly project: Project) {
    super(new ProjectStore("/dev/null"));
  }

  override requireProject(projectId: string): Promise<Project> {
    return projectId === this.project.id ? Promise.resolve(this.project) : Promise.reject(new Error("Project not found"));
  }
}

class FakeWorkspaceCatalog implements WorkspaceCatalog {
  constructor(private readonly workspaces: WorkspaceListing[]) {}

  resolveProject(): never {
    throw new Error("Workspace provider resolution is not used by the trust routes");
  }

  list(projectId: string): Promise<WorkspaceListing[]> {
    return Promise.resolve(this.workspaces.filter((workspace) => workspace.projectId === projectId));
  }

  resolve(projectId: string, workspaceId: string): Promise<WorkspaceListing> {
    const workspace = this.workspaces.find((entry) => entry.projectId === projectId && entry.id === workspaceId);
    return workspace === undefined
      ? Promise.reject(new Error("Workspace not found"))
      : Promise.resolve(workspace);
  }
}

beforeEach(async () => {
  agentDir = await tempDir("pi-web-trust-route-agent-");
  projectDir = await tempDir("pi-web-trust-route-project-");
  const project: Project = { id: "p1", name: "proj", path: projectDir, createdAt: "2026-01-01T00:00:00.000Z" };
  const workspace: WorkspaceListing = { id: "w1", projectId: project.id, path: projectDir, label: "main", isMain: true };
  app = Fastify({ logger: false });
  registerProjectTrustRoutes(app, new FakeProjectService(project), new FakeWorkspaceCatalog([workspace]), {
    agentDir: () => Promise.resolve(agentDir),
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("project trust routes", () => {
  it("reports untrusted with no saved decision when the default is not 'always'", async () => {
    const response = await app.inject({ method: "GET", url: TRUST_URL });

    expect(response.statusCode).toBe(200);
    const body = response.json<WorkspaceTrustResponse>();
    expect(body.decision).toBe(null);
    expect(body.trusted).toBe(false);
  });

  it("persists an explicit trust decision to the agent dir's trust.json", async () => {
    const put = await app.inject({ method: "PUT", url: TRUST_URL, payload: { trusted: true } });

    expect(put.statusCode).toBe(200);
    expect(put.json<WorkspaceTrustResponse>()).toMatchObject({ decision: true, trusted: true });
    // Written to the shared store, so a fresh reader (and the Pi CLI) sees it.
    expect(new ProjectTrustStore(agentDir).get(projectDir)).toBe(true);

    const get = await app.inject({ method: "GET", url: TRUST_URL });
    expect(get.json<WorkspaceTrustResponse>()).toMatchObject({ decision: true, trusted: true });
  });

  it("records an explicit untrusted decision distinct from unset", async () => {
    await app.inject({ method: "PUT", url: TRUST_URL, payload: { trusted: false } });

    expect(new ProjectTrustStore(agentDir).get(projectDir)).toBe(false);
    expect((await app.inject({ method: "GET", url: TRUST_URL })).json<WorkspaceTrustResponse>()).toMatchObject({ decision: false, trusted: false });
  });

  it("rejects a non-boolean trusted value", async () => {
    const response = await app.inject({ method: "PUT", url: TRUST_URL, payload: { trusted: "yes" } });

    expect(response.statusCode).toBe(400);
    expect(new ProjectTrustStore(agentDir).get(projectDir)).toBe(null);
  });

  it("returns 400 for an unknown workspace", async () => {
    const response = await app.inject({ method: "GET", url: "/api/projects/p1/workspaces/nope/trust" });

    expect(response.statusCode).toBe(400);
  });
});

describe("path-driven trust lookup (add-project dialog)", () => {
  it("reports the existing decision for the entered path", async () => {
    new ProjectTrustStore(agentDir).set(projectDir, true);

    const response = await app.inject({ method: "GET", url: `/api/projects/trust?path=${encodeURIComponent(projectDir)}` });

    expect(response.statusCode).toBe(200);
    expect(response.json<WorkspaceTrustResponse>()).toEqual({ path: projectDir, decision: true, trusted: true });
  });

  it("keeps an explicit untrusted decision distinct from unset", async () => {
    new ProjectTrustStore(agentDir).set(projectDir, false);

    const response = await app.inject({ method: "GET", url: `/api/projects/trust?path=${encodeURIComponent(projectDir)}` });

    expect(response.json<WorkspaceTrustResponse>()).toEqual({ path: projectDir, decision: false, trusted: false });
  });

  it("resolves the entered path to its canonical form before reading the store", async () => {
    const link = `${projectDir}-link`;
    cleanup.push(link);
    await symlink(projectDir, link);
    new ProjectTrustStore(agentDir).set(projectDir, true);

    const response = await app.inject({ method: "GET", url: `/api/projects/trust?path=${encodeURIComponent(link)}` });

    expect(response.statusCode).toBe(200);
    expect(response.json<WorkspaceTrustResponse>()).toEqual({ path: projectDir, decision: true, trusted: true });
  });

  it("reports the unset default for a path that does not exist yet", async () => {
    const missing = join(projectDir, "not-yet-created");

    const response = await app.inject({ method: "GET", url: `/api/projects/trust?path=${encodeURIComponent(missing)}` });

    expect(response.statusCode).toBe(200);
    expect(response.json<WorkspaceTrustResponse>()).toEqual({ path: missing, decision: null, trusted: false });
  });

  it("rejects a missing or empty path", async () => {
    expect((await app.inject({ method: "GET", url: "/api/projects/trust" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/projects/trust?path=" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/projects/trust?path=%20" })).statusCode).toBe(400);
  });
});
