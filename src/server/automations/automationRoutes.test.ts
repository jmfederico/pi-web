import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { AutomationUsageSnapshot } from "../../shared/apiTypes.js";
import type { WorkspaceListing } from "../types.js";
import { registerAutomationRoutes } from "./automationRoutes.js";
import { AutomationService } from "./automationService.js";
import { AutomationStore } from "./automationStore.js";

const scope = { projectId: "project-1", workspaceId: "workspace-1" };
const workspace: WorkspaceListing = { id: scope.workspaceId, projectId: scope.projectId, path: "/repo", label: "repo", isMain: true, isGitRepo: true, isGitWorktree: false };
const stores: AutomationStore[] = [];

async function fixture() {
  const store = new AutomationStore(":memory:");
  stores.push(store);
  const unused = (): Promise<never> => Promise.reject(new Error("unused"));
  const service = new AutomationService(
    store,
    {
      requireWorkspace: (projectId, workspaceId) => projectId === scope.projectId && workspaceId === scope.workspaceId
        ? Promise.resolve(workspace)
        : Promise.reject(new Error("Workspace not found")),
    },
    {
      models: () => [{ provider: "test", id: "model", name: "Test Model" }],
      create: unused,
      run: unused,
      snapshot: (): Promise<AutomationUsageSnapshot | undefined> => Promise.resolve(undefined),
      abort: () => Promise.resolve(),
      forceStop: () => Promise.resolve(),
      release: () => undefined,
    },
  );
  const app = Fastify();
  registerAutomationRoutes(app, service);
  await app.ready();
  return app;
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe("automation routes", () => {
  it("rejects caller-provided cwd and requires registered stable scope ids", async () => {
    const app = await fixture();
    const response = await app.inject({
      method: "POST",
      url: "/automations",
      payload: {
        ...scope,
        cwd: "/tmp/escape",
        name: "Review",
        prompt: "Review",
        trigger: { type: "manual" },
        model: { mode: "fixed", provider: "test", id: "model" },
        thinking: { mode: "default" },
      },
    });

    const body: unknown = response.json();
    expect(response.statusCode).toBe(400);
    expect(readString(body, "error")).toContain("cwd is not accepted");
    await app.close();
  });

  it("creates disabled drafts and returns conflicts when enabling an untested revision", async () => {
    const app = await fixture();
    const created = await app.inject({
      method: "POST",
      url: "/automations",
      payload: {
        ...scope,
        name: "Review",
        prompt: "Review",
        trigger: { type: "manual" },
        model: { mode: "fixed", provider: "test", id: "model" },
        thinking: { mode: "fixed", level: "medium" },
        timeoutMs: 3_600_000,
      },
    });
    const createdBody: unknown = created.json();
    const automation = readRecord(createdBody, "automation");
    const enabled = await app.inject({
      method: "PATCH",
      url: `/automations/${encodeURIComponent(readString(automation, "id"))}`,
      payload: { ...scope, expectedRevision: readNumber(automation, "revision"), enabled: true },
    });
    const enabledBody: unknown = enabled.json();

    expect(created.statusCode).toBe(201);
    expect(automation).toMatchObject({ enabled: false, model: { provider: "test", id: "model" }, timeoutMs: 3_600_000 });
    expect(enabled.statusCode).toBe(409);
    expect(readString(enabledBody, "error")).toContain("successfully before enabling");
    await app.close();
  });
});

function readRecord(value: unknown, key?: string): Record<string, unknown> {
  const candidate = key === undefined ? value : isRecord(value) ? value[key] : undefined;
  if (!isRecord(candidate)) throw new Error(`Expected object${key === undefined ? "" : ` field ${key}`}`);
  return candidate;
}

function readString(value: unknown, key: string): string {
  const field = readRecord(value)[key];
  if (typeof field !== "string") throw new Error(`Expected string field ${key}`);
  return field;
}

function readNumber(value: unknown, key: string): number {
  const field = readRecord(value)[key];
  if (typeof field !== "number") throw new Error(`Expected number field ${key}`);
  return field;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
