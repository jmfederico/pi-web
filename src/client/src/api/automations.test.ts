import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { automationsApi, parseAutomationModelsResponse, parseAutomationRun } from "./automations";

const definition = {
  id: "job/a?",
  projectId: "project 1",
  workspaceId: "workspace/1",
  workspacePath: "/repo",
  name: "Review",
  prompt: "Review",
  enabled: false,
  revision: 1,
  trigger: { type: "manual" },
  model: { mode: "fixed", provider: "test", id: "model" },
  thinking: { mode: "fixed", level: "medium" },
  timeoutMs: 3_600_000,
  abortGraceMs: 15_000,
  createdAt: "2026-07-24T12:00:00.000Z",
  updatedAt: "2026-07-24T12:00:00.000Z",
};

beforeEach(() => {
  vi.stubGlobal("document", { baseURI: "https://pi.example.test/base/" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("automations API", () => {
  it("encodes machine and automation path segments exactly once", async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(new Response(JSON.stringify({ automation: definition }), { status: 200, headers: { "content-type": "application/json" } })));
    vi.stubGlobal("fetch", fetchMock);

    await automationsApi.update("job/a?", {
      projectId: "project 1",
      workspaceId: "workspace/1",
      expectedRevision: 1,
      enabled: false,
    }, "remote a");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://pi.example.test/api/machines/remote%20a/automations/job%2Fa%3F");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "PATCH" });
  });

  it("keeps missing usage and estimated cost unknown", () => {
    const run = parseAutomationRun({
      id: "run-1",
      automationId: definition.id,
      automationRevision: 1,
      automationName: definition.name,
      projectId: definition.projectId,
      workspaceId: definition.workspaceId,
      workspacePath: definition.workspacePath,
      source: "manual",
      scheduledFor: "2026-07-24T12:01:00.000Z",
      status: "completed",
      prompt: definition.prompt,
      trigger: definition.trigger,
      configuredModel: definition.model,
      configuredThinking: definition.thinking,
      timeoutMs: definition.timeoutMs,
      queuedAt: "2026-07-24T12:01:00.000Z",
      startedAt: "2026-07-24T12:01:01.000Z",
      completedAt: "2026-07-24T12:02:00.000Z",
    });

    expect(run.usage).toBeUndefined();
    expect(run.actualModel).toBeUndefined();
  });

  it("rejects fractional run counters and incomplete selectable models", () => {
    expect(() => parseAutomationRun({
      id: "run-1",
      automationId: definition.id,
      automationRevision: 1.5,
      automationName: definition.name,
      projectId: definition.projectId,
      workspaceId: definition.workspaceId,
      workspacePath: definition.workspacePath,
      source: "manual",
      scheduledFor: "2026-07-24T12:01:00.000Z",
      status: "queued",
      prompt: definition.prompt,
      trigger: definition.trigger,
      configuredModel: definition.model,
      configuredThinking: definition.thinking,
      timeoutMs: definition.timeoutMs,
      queuedAt: "2026-07-24T12:01:00.000Z",
    })).toThrow(/automationRevision/u);

    expect(() => parseAutomationModelsResponse({
      models: [{ name: "Missing identity" }],
      thinkingLevels: ["medium"],
      defaultTimeoutMs: 60_000,
      minTimeoutMs: 60_000,
      maxTimeoutMs: 86_400_000,
    })).toThrow(/provider and id/u);
  });

  it("parses per-model supported thinking levels when present", () => {
    const parsed = parseAutomationModelsResponse({
      models: [
        { provider: "opencode", id: "deepseek-v4-flash-free", thinkingLevels: ["off", "high", "max"] },
        { provider: "test", id: "model" },
      ],
      thinkingLevels: ["off", "medium", "high"],
      defaultTimeoutMs: 60_000,
      minTimeoutMs: 60_000,
      maxTimeoutMs: 86_400_000,
    });

    expect(parsed.models[0]?.thinkingLevels).toEqual(["off", "high", "max"]);
    expect(parsed.models[1]?.thinkingLevels).toBeUndefined();
  });
});
