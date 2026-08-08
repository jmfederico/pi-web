import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AutomationDraft, AutomationUsageSnapshot, SessionModel } from "../../shared/apiTypes.js";
import type { WorkspaceListing } from "../types.js";
import { AutomationService } from "./automationService.js";
import type { CreatedAutomationSession } from "./automationSessionRunner.js";
import { AutomationStore } from "./automationStore.js";

const scope = { projectId: "project-1", workspaceId: "workspace-1" };
const workspace: WorkspaceListing = { id: scope.workspaceId, projectId: scope.projectId, path: "/repo", label: "repo", isMain: true, isGitRepo: true, isGitWorktree: false };
const model: SessionModel = { provider: "test", id: "model", name: "Test Model", reasoning: true };
const usage: AutomationUsageSnapshot = {
  scope: "root_session",
  quality: "estimated",
  tokens: { input: 10, output: 5, cacheRead: 1, cacheWrite: 0, total: 16 },
  estimatedCostMicros: 2500,
  capturedAt: "2026-07-24T12:01:00.000Z",
};

class Deferred<T> {
  readonly promise: Promise<T>;
  private resolvePromise!: (value: T) => void;
  private rejectPromise!: (error: unknown) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolvePromise = resolve;
      this.rejectPromise = reject;
    });
  }

  resolve(value: T): void { this.resolvePromise(value); }
  reject(error: unknown): void { this.rejectPromise(error); }
}

class FakeRunner {
  readonly prompt = new Deferred<AutomationUsageSnapshot>();
  readonly created: CreatedAutomationSession = { sessionId: "session-1", cwd: workspace.path, actualModel: model, actualThinkingLevel: "medium" };
  createCalls = 0;
  abortCalls = 0;
  forceStopCalls = 0;
  releaseCalls = 0;

  models(): SessionModel[] { return [model]; }
  create(_input: unknown, onCreated: (session: CreatedAutomationSession) => void): Promise<CreatedAutomationSession> {
    this.createCalls += 1;
    onCreated(this.created);
    return Promise.resolve(this.created);
  }
  run(): Promise<AutomationUsageSnapshot> { return this.prompt.promise; }
  snapshot(): Promise<AutomationUsageSnapshot> { return Promise.resolve(usage); }
  abort(): Promise<void> { this.abortCalls += 1; this.prompt.reject(new Error("aborted")); return Promise.resolve(); }
  forceStop(): Promise<void> { this.forceStopCalls += 1; return Promise.resolve(); }
  release(): void { this.releaseCalls += 1; }
}

function draft(patch: Partial<AutomationDraft> = {}): AutomationDraft {
  return {
    ...scope,
    name: "Review",
    prompt: "Review the repository",
    trigger: { type: "manual" },
    model: { mode: "fixed", provider: "test", id: "model" },
    thinking: { mode: "fixed", level: "medium" },
    timeoutMs: 60_000,
    ...patch,
  };
}

const stores: AutomationStore[] = [];
const tempRoots: string[] = [];

function fixture(runner = new FakeRunner(), providedStore?: AutomationStore) {
  const store = providedStore ?? new AutomationStore(":memory:");
  stores.push(store);
  const events: unknown[] = [];
  const service = new AutomationService(
    store,
    { requireWorkspace: () => Promise.resolve(workspace) },
    runner,
    { publishRealtime: (event) => events.push(event) },
    undefined,
    () => new Date(Date.now()),
  );
  return { store, runner, service, events };
}

afterEach(() => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) store.close();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("AutomationService", () => {
  it("holds runtime ownership through stop until final disposal", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-web-automation-service-owner-"));
    tempRoots.push(root);
    const path = join(root, "automations.sqlite");
    const firstStore = new AutomationStore(path);
    const secondStore = new AutomationStore(path);
    stores.push(secondStore);
    const { service } = fixture(new FakeRunner(), firstStore);

    service.acquireOwnership();
    await service.stop();
    expect(() => { secondStore.acquireRuntimeOwnership(); }).toThrow(/already owned/u);

    service.dispose();
    expect(() => { secondStore.acquireRuntimeOwnership(); }).not.toThrow();
  });

  it("requires a successful manual run before enabling the exact revision", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T12:00:00.000Z"));
    const { service, runner } = fixture();
    const automation = await service.create(draft());

    await expect(service.update(automation.id, { ...scope, expectedRevision: 1, enabled: true })).rejects.toThrow("successfully before enabling");
    await service.runNow(automation.id, scope);
    await flushMicrotasks();
    runner.prompt.resolve(usage);
    await flushMicrotasks();

    const tested = (await service.list(scope))[0];
    expect(runner.releaseCalls).toBe(1);
    expect(tested).toMatchObject({ revision: 1, testedRevision: 1, enabled: false });
    const enabled = await service.update(automation.id, { ...scope, expectedRevision: 1, enabled: true });
    expect(enabled).toMatchObject({ enabled: true, testedRevision: 1 });
  });

  it("persists user cancellation before aborting the live session", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T12:00:00.000Z"));
    const { service, runner } = fixture();
    const automation = await service.create(draft());
    const queued = await service.runNow(automation.id, scope);
    await flushMicrotasks();

    const cancelling = await service.cancel(queued.id, scope);
    expect(cancelling).toMatchObject({ status: "cancelling", cancellationKind: "user" });
    await flushMicrotasks();

    expect(runner.abortCalls).toBe(1);
    expect((await service.listRuns(scope))[0]).toMatchObject({ status: "cancelled", usage });
  });

  it("force-stops and releases a run when soft abort never settles", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T12:00:00.000Z"));
    const runner = new FakeRunner();
    runner.abort = () => { runner.abortCalls += 1; return new Promise<void>(() => undefined); };
    const { service } = fixture(runner);
    const automation = await service.create(draft());
    const queued = await service.runNow(automation.id, scope);
    await flushMicrotasks();

    await service.cancel(queued.id, scope);
    await vi.advanceTimersByTimeAsync(15_000);
    await flushMicrotasks();

    expect(runner.abortCalls).toBe(1);
    expect(runner.forceStopCalls).toBe(1);
    expect((await service.listRuns(scope))[0]).toMatchObject({ status: "unknown", reason: "force_stop_unconfirmed", attempt: { forceStopped: true } });
    await service.stop();
  });

  it("force-stops a session exposed during setup when setup never settles", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T12:00:00.000Z"));
    const runner = new FakeRunner();
    runner.create = (_input, onCreated) => {
      runner.createCalls += 1;
      onCreated(runner.created);
      return new Promise<CreatedAutomationSession>(() => undefined);
    };
    runner.abort = () => { runner.abortCalls += 1; return new Promise<void>(() => undefined); };
    const { service } = fixture(runner);
    const automation = await service.create(draft());
    const queued = await service.runNow(automation.id, scope);
    await flushMicrotasks();

    await service.cancel(queued.id, scope);
    await vi.advanceTimersByTimeAsync(15_000);
    await flushMicrotasks();

    expect(runner.abortCalls).toBe(1);
    expect(runner.forceStopCalls).toBe(1);
    expect((await service.listRuns(scope))[0]).toMatchObject({ status: "unknown", reason: "force_stop_unconfirmed" });
    await service.stop();
  });

  it("uses the same durable cancellation path for execution timeouts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T12:00:00.000Z"));
    const { service, runner } = fixture();
    const automation = await service.create(draft({ timeoutMs: 60_000 }));
    await service.runNow(automation.id, scope);
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();

    expect(runner.abortCalls).toBe(1);
    expect((await service.listRuns(scope))[0]).toMatchObject({ status: "timed_out", cancellationKind: "timeout", usage });
  });
});

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}
