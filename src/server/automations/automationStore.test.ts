import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AutomationDefinition, AutomationUsageSnapshot } from "../../shared/apiTypes.js";
import { AutomationStore } from "./automationStore.js";

const stores: AutomationStore[] = [];
const tempRoots: string[] = [];

function store(): AutomationStore {
  const value = new AutomationStore(":memory:");
  stores.push(value);
  return value;
}

function definition(patch: Partial<AutomationDefinition> = {}): AutomationDefinition {
  return {
    id: "automation-1",
    projectId: "project-1",
    workspaceId: "workspace-1",
    workspacePath: "/repo",
    name: "Daily review",
    prompt: "Review the repository",
    enabled: false,
    revision: 1,
    trigger: { type: "cron", expression: "0 0 9 * * *", timeZone: "UTC" },
    model: { mode: "fixed", provider: "test", id: "model", name: "Test Model" },
    thinking: { mode: "fixed", level: "medium" },
    timeoutMs: 3_600_000,
    abortGraceMs: 15_000,
    createdAt: "2026-07-24T12:00:00.000Z",
    updatedAt: "2026-07-24T12:00:00.000Z",
    ...patch,
  };
}

afterEach(() => {
  for (const value of stores.splice(0)) value.close();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("AutomationStore", () => {
  it("fences the durable database to one runtime owner", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-web-automation-owner-"));
    tempRoots.push(root);
    const path = join(root, "automations.sqlite");
    const first = new AutomationStore(path);
    const second = new AutomationStore(path);
    stores.push(first, second);

    first.acquireRuntimeOwnership();
    expect(() => { second.acquireRuntimeOwnership(); }).toThrow(/already owned/u);

    first.close();
    expect(() => { second.acquireRuntimeOwnership(); }).not.toThrow();
  });

  it("persists scoped definitions and rejects duplicate active names", () => {
    const db = store();
    db.insertDefinition(definition());

    expect(db.listDefinitions("project-1", "workspace-1")).toEqual([definition()]);
    expect(() => db.insertDefinition(definition({ id: "automation-2" }))).toThrow("already exists");
    expect(db.listDefinitions("other", "workspace-1")).toEqual([]);
  });

  it("guards revisions and retains immutable run snapshots", () => {
    const db = store();
    const original = db.insertDefinition(definition({ testedRevision: 1 }));
    const run = db.createManualRun(original, "run-1", "2026-07-24T12:01:00.000Z");
    const updated = { ...original, prompt: "A changed prompt", revision: 2, enabled: false, updatedAt: "2026-07-24T12:02:00.000Z" };
    delete updated.testedRevision;
    db.replaceDefinition(updated, 1);

    expect(db.getRun(run.id)).toMatchObject({ automationRevision: 1, prompt: "Review the repository" });
    expect(() => db.replaceDefinition({ ...updated, revision: 3 }, 1)).toThrow("changed by another client");
  });

  it("forbids overlap and makes cancellation idempotent", () => {
    const db = store();
    const automation = db.insertDefinition(definition());
    const run = db.createManualRun(automation, "run-1", "2026-07-24T12:01:00.000Z");

    expect(() => db.createManualRun(automation, "run-2", "2026-07-24T12:01:01.000Z")).toThrow("active run");
    expect(db.requestCancellation(run.id, "user", "2026-07-24T12:01:02.000Z")).toMatchObject({ status: "cancelled", cancellationKind: "user" });
    expect(db.requestCancellation(run.id, "user", "2026-07-24T12:01:03.000Z")).toMatchObject({ status: "cancelled", completedAt: "2026-07-24T12:01:02.000Z" });
  });

  it("preserves the first cancellation intent when user cancel and timeout race", () => {
    const db = store();
    const automation = db.insertDefinition(definition());
    db.createManualRun(automation, "run-1", "2026-07-24T12:01:00.000Z");
    db.markRunStarting("run-1", "attempt-1", "2026-07-24T12:01:01.000Z");
    expect(db.markRunStarting("run-1", "attempt-duplicate", "2026-07-24T12:01:01.500Z")).toBeUndefined();
    db.markRunRunning("run-1", {
      sessionId: "session-1",
      startedAt: "2026-07-24T12:01:02.000Z",
      deadlineAt: "2026-07-24T13:01:02.000Z",
    });

    db.requestCancellation("run-1", "user", "2026-07-24T12:01:03.000Z");
    const raced = db.requestCancellation("run-1", "timeout", "2026-07-24T12:01:04.000Z");

    expect(raced).toMatchObject({ status: "cancelling", cancellationKind: "user", reason: "user", cancelRequestedAt: "2026-07-24T12:01:03.000Z" });
  });

  it("freezes terminal root usage and ignores late terminal rewrites", () => {
    const db = store();
    const automation = db.insertDefinition(definition());
    db.createManualRun(automation, "run-1", "2026-07-24T12:01:00.000Z");
    db.markRunStarting("run-1", "attempt-1", "2026-07-24T12:01:01.000Z");
    db.markRunRunning("run-1", {
      sessionId: "session-1",
      actualModel: { provider: "test", id: "model", name: "Test Model" },
      actualThinkingLevel: "medium",
      startedAt: "2026-07-24T12:01:02.000Z",
      deadlineAt: "2026-07-24T13:01:02.000Z",
    });
    const usage: AutomationUsageSnapshot = {
      scope: "root_session",
      quality: "estimated",
      tokens: { input: 10, output: 5, cacheRead: 2, cacheWrite: 0, total: 17 },
      estimatedCostMicros: 1234,
      capturedAt: "2026-07-24T12:02:00.000Z",
    };

    const completed = db.finishRun("run-1", { status: "completed", completedAt: "2026-07-24T12:02:00.000Z", usage });
    db.finishRun("run-1", { status: "failed", completedAt: "2026-07-24T12:03:00.000Z", error: "late" });

    expect(db.getRun("run-1")).toEqual(completed);
    expect(completed).toMatchObject({ status: "completed", usage, attempt: { status: "completed", usage } });
    expect(db.getDefinition(automation.id)).toMatchObject({ testedRevision: automation.revision });
  });

  it("recovers ambiguous in-flight attempts as unknown without rerunning queued work", () => {
    const db = store();
    const automation = db.insertDefinition(definition());
    db.createManualRun(automation, "running", "2026-07-24T12:01:00.000Z");
    db.markRunStarting("running", "attempt-1", "2026-07-24T12:01:01.000Z");
    const other = db.insertDefinition(definition({ id: "automation-2", name: "Other" }));
    db.createManualRun(other, "queued", "2026-07-24T12:01:00.000Z");

    expect(db.recoverInterruptedRuns("2026-07-24T12:05:00.000Z")).toMatchObject([{ id: "running", status: "unknown", reason: "daemon_restart" }]);
    expect(db.getRun("queued")).toMatchObject({ status: "queued" });
  });
});
