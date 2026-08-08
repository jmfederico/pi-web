import { describe, expect, it } from "vitest";
import type { AutomationDefinition, AutomationModelsResponse, AutomationRun } from "../api";
import { knownAutomationUsage, runDurationMs, snapshotAutomationEdit, supportedThinkingLevels, thinkingLevelForModel, thinkingLevelOptions } from "./AutomationsPanel";

const modelOptions: AutomationModelsResponse = {
  models: [
    { provider: "opencode", id: "deepseek-v4-flash-free", name: "DeepSeek V4 Flash Free", thinkingLevels: ["off", "high", "max"] },
    { provider: "test", id: "model", name: "Test" },
  ],
  thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  defaultTimeoutMs: 3_600_000,
  minTimeoutMs: 60_000,
  maxTimeoutMs: 86_400_000,
};

const deepseekKey = "fixed:opencode:deepseek-v4-flash-free";

const definition: AutomationDefinition = {
  id: "automation-1",
  projectId: "project-1",
  workspaceId: "workspace-1",
  workspacePath: "/workspace",
  name: "Review",
  prompt: "Review this workspace",
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

describe("AutomationsPanel", () => {
  it("captures the edit revision instead of following later polling updates", () => {
    const edit = snapshotAutomationEdit(definition);
    const refreshedDefinition = { ...definition, revision: 2 };

    expect(refreshedDefinition.revision).toBe(2);
    expect(edit).toMatchObject({ id: definition.id, expectedRevision: 1 });
  });

  it("keeps unknown-quality usage out of numeric totals", () => {
    const unknown = run({
      status: "completed",
      usage: {
        scope: "root_session",
        quality: "unknown",
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        capturedAt: "2026-07-24T12:05:00.000Z",
      },
    });

    expect(knownAutomationUsage(unknown)).toBeUndefined();
  });

  it("offers only the selected model's supported thinking levels", () => {
    expect(supportedThinkingLevels(deepseekKey, modelOptions)).toEqual(["off", "high", "max"]);
    expect(thinkingLevelOptions(deepseekKey, "default", modelOptions)).toEqual(["off", "high", "max"]);
  });

  it("falls back to the full known set when the concrete model is unknown", () => {
    expect(supportedThinkingLevels("default", modelOptions)).toBeUndefined();
    expect(thinkingLevelOptions("default", "default", modelOptions)).toEqual(modelOptions.thinkingLevels);
    // A model whose supported levels the server did not report also falls back.
    expect(thinkingLevelOptions("fixed:test:model", "default", modelOptions)).toEqual(modelOptions.thinkingLevels);
  });

  it("keeps a pinned level visible when editing even if the model would filter it out", () => {
    expect(thinkingLevelOptions(deepseekKey, "medium", modelOptions)).toEqual(["off", "high", "max", "medium"]);
  });

  it("clears a pinned level the newly selected model cannot honour", () => {
    expect(thinkingLevelForModel(deepseekKey, "medium", modelOptions)).toBe("default");
    expect(thinkingLevelForModel(deepseekKey, "high", modelOptions)).toBe("high");
    // Unknown concrete model: leave the pinned level untouched.
    expect(thinkingLevelForModel("default", "medium", modelOptions)).toBe("medium");
  });

  it("measures execution duration only after a run actually starts", () => {
    const queuedOnly = run({ status: "skipped", completedAt: "2026-07-24T12:05:00.000Z" });
    const executed = run({
      status: "completed",
      startedAt: "2026-07-24T12:02:00.000Z",
      completedAt: "2026-07-24T12:05:00.000Z",
    });

    expect(runDurationMs(queuedOnly)).toBeUndefined();
    expect(runDurationMs(executed)).toBe(180_000);
  });
});

function run(patch: Partial<AutomationRun>): AutomationRun {
  return {
    id: "run-1",
    automationId: definition.id,
    automationRevision: definition.revision,
    automationName: definition.name,
    projectId: definition.projectId,
    workspaceId: definition.workspaceId,
    workspacePath: definition.workspacePath,
    source: "manual",
    scheduledFor: "2026-07-24T12:00:00.000Z",
    status: "queued",
    prompt: definition.prompt,
    trigger: definition.trigger,
    configuredModel: definition.model,
    configuredThinking: definition.thinking,
    timeoutMs: definition.timeoutMs,
    queuedAt: "2026-07-24T12:00:00.000Z",
    ...patch,
  };
}
