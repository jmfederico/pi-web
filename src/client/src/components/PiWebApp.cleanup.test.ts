// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { sessionsApi, type SessionCleanupExecuteResponse, type SessionCleanupPreviewResponse, type SessionCleanupRequest } from "../api";
import type { AppState } from "../appState";
import type { SessionController } from "../controllers/sessionController";
import type { AppAction } from "../actions";
import { localization } from "../localization/browser";
import { sessionCleanupMessages as messages } from "../sessionCleanupMessages";
import { PiWebApp } from "./PiWebApp";

afterEach(async () => {
  await localization.setPreferences({ language: "en", formatLocale: "en" });
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  document.body.replaceChildren(); localStorage.clear();
});
function createApp(): PiWebApp {
  vi.stubGlobal("window", { location: { search: "" }, localStorage });
  const app = new PiWebApp();
  cleanupInternals(app).openSessionCleanupDialog();
  return app;
}
function cleanupMethod(app: PiWebApp, name: "previewSessionCleanup" | "runSessionCleanup"): (request: SessionCleanupRequest) => Promise<void> {
  const method: unknown = Reflect.get(app, name);
  if (!isCleanupMethod(method)) throw new Error(`Missing ${name}`);
  return (request) => method.call(app, request);
}
function isCleanupMethod(value: unknown): value is (request: SessionCleanupRequest) => Promise<void> { return typeof value === "function"; }
function cleanupError(app: PiWebApp): () => string {
  const dialog: unknown = Reflect.get(app, "sessionCleanupDialog");
  if (typeof dialog !== "object" || dialog === null || !("error" in dialog) || !isErrorMessage(dialog.error)) throw new Error("Missing live cleanup error");
  const error = dialog.error;
  return error;
}
function isErrorMessage(value: unknown): value is () => string { return typeof value === "function"; }

it("keeps preview failures live across locale changes without repeating the request", async () => {
  const app = createApp();
  const preview = vi.spyOn(sessionsApi, "cleanupPreview").mockRejectedValue(new Error("Raw backend <b>diagnostic</b>"));
  await cleanupMethod(app, "previewSessionCleanup")({ archiveIdleDays: 30, deleteArchivedDays: null });
  const error = cleanupError(app);
  for (const language of ["en-XA", "ar-XB", "en"]) {
    await localization.setPreferences({ language, formatLocale: "de-DE" });
    expect(error()).toBe(messages.t("previewFailed", { error: "Raw backend <b>diagnostic</b>" }));
    expect(preview).toHaveBeenCalledOnce();
  }
});

it("localizes stale-preview validation without executing cleanup", async () => {
  const app = createApp();
  const cleanup = vi.spyOn(sessionsApi, "cleanup");
  await cleanupMethod(app, "runSessionCleanup")({ archiveIdleDays: 30, deleteArchivedDays: null });
  const error = cleanupError(app);
  await localization.setPreferences({ language: "en-XA", formatLocale: "en" });
  expect(error()).toBe(messages.t("previewRequired"));
  expect(cleanup).not.toHaveBeenCalled();
});

it("keeps execution errors and cleanup action metadata live", async () => {
  const app = createApp();
  const request = { archiveIdleDays: 30, deleteArchivedDays: null };
  Reflect.set(app, "sessionCleanupDialog", { preview: {}, previewRequest: request });
  const cleanup = vi.spyOn(sessionsApi, "cleanup").mockRejectedValue(new Error("Execution diagnostic"));
  await cleanupMethod(app, "runSessionCleanup")(request);
  const error = cleanupError(app);
  const method: unknown = Reflect.get(app, "sessionActions");
  if (!isActions(method)) throw new Error("Missing session actions");
  const action = method.call(app)[0];
  for (const language of ["en-XA", "ar-XB", "en"]) {
    await localization.setPreferences({ language, formatLocale: "en" });
    expect(error()).toBe(messages.t("runFailed", { error: "Execution diagnostic" }));
    expect(action?.title).toBe(messages.t("actionTitle"));
    expect(action?.description).toBe(messages.t("actionDescription"));
    expect(action?.group).toBe(messages.t("eyebrow"));
    expect(cleanup).toHaveBeenCalledOnce();
  }
});
function isActions(value: unknown): value is () => AppAction[] { return typeof value === "function"; }


// Exercise the app's async orchestration without mounting its unrelated services.
interface CleanupInternals {
    sessionCleanupDialog: {
      preview?: SessionCleanupPreviewResponse | undefined;
      previewRequest?: SessionCleanupRequest | undefined;
      result?: SessionCleanupExecuteResponse | undefined;
      error?: string | (() => string) | undefined;
    } | undefined;
    state: AppState;
    sessions: SessionController;
    realtime: { close(): void };
    connectRealtime(): void;
    loadPluginsForSelectedMachine(): Promise<void>;
    setState(state: Partial<AppState>): void;
    handleMachineChange(previous: AppState, next: AppState): void;
    openSessionCleanupDialog(): void;
    closeSessionCleanupDialog(): void;
}
function isCleanupInternals(value: unknown): value is CleanupInternals {
  return value instanceof PiWebApp;
}
function cleanupInternals(app: PiWebApp): CleanupInternals {
  if (!isCleanupInternals(app)) throw new Error("Missing cleanup app");
  return app;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const request: SessionCleanupRequest = { archiveIdleDays: 30, deleteArchivedDays: null };
const result: SessionCleanupExecuteResponse = {
  generatedAt: "2026-01-01T00:00:00Z", thresholds: { archiveIdleDays: 30 },
  projects: [], totals: { archiveCount: 1, deleteCount: 0 },
  archivedSessionIds: ["archived-session"], deletedSessionIds: [],
};

function startPendingCleanup(app: PiWebApp, operation: "preview" | "run") {
  const internals = cleanupInternals(app);
  const pending = deferred<SessionCleanupExecuteResponse>();
  if (operation === "run") {
    internals.sessionCleanupDialog = { preview: result, previewRequest: request };
    vi.spyOn(sessionsApi, "cleanup").mockReturnValue(pending.promise);
  } else {
    vi.spyOn(sessionsApi, "cleanupPreview").mockReturnValue(pending.promise);
  }
  const apply = vi.spyOn(internals.sessions, "applySessionCleanupResult").mockResolvedValue();
  const done = cleanupMethod(app, operation === "run" ? "runSessionCleanup" : "previewSessionCleanup")(request);
  return { pending, done, apply };
}

it.each([
  ["preview", false, false], ["preview", false, true],
  ["preview", true, false], ["preview", true, true],
  ["run", false, false], ["run", false, true],
  ["run", true, false], ["run", true, true],
] as const)("ignores stale %s responses after close (reopen=%s, failure=%s)", async (operation, reopen, failure) => {
  const app = createApp();
  const internals = cleanupInternals(app);
  const { pending, done, apply } = startPendingCleanup(app, operation);
  internals.closeSessionCleanupDialog();
  if (reopen) internals.openSessionCleanupDialog();
  const dialog = internals.sessionCleanupDialog;
  if (failure) pending.reject(new Error("Old request failed"));
  else pending.resolve(result);
  await done;
  expect(internals.sessionCleanupDialog).toBe(dialog);
  if (operation === "run" && !failure) expect(apply).toHaveBeenCalledWith(result, "local");
  else expect(apply).not.toHaveBeenCalled();
});

it.each([
  ["preview", false], ["preview", true], ["run", false], ["run", true],
] as const)("does not overwrite a newer preview with an older %s response (failure=%s)", async (operation, failure) => {
  const app = createApp();
  const { pending, done, apply } = startPendingCleanup(app, operation);
  const newerRequest = { archiveIdleDays: 60 };
  const newerPreview = { ...result, totals: { archiveCount: 2, deleteCount: 0 } };
  vi.spyOn(sessionsApi, "cleanupPreview").mockResolvedValue(newerPreview);
  await cleanupMethod(app, "previewSessionCleanup")(newerRequest);
  const dialog = cleanupInternals(app).sessionCleanupDialog;
  if (failure) pending.reject(new Error("Old request failed"));
  else pending.resolve(result);
  await done;
  expect(cleanupInternals(app).sessionCleanupDialog).toBe(dialog);
  expect(dialog?.preview).toBe(newerPreview);
  expect(dialog?.previewRequest).toBe(newerRequest);
  if (operation === "run" && !failure) expect(apply).toHaveBeenCalledWith(result, "local");
  else expect(apply).not.toHaveBeenCalled();
});

it.each(["preview", "run"] as const)("invalidates pending %s on machine changes, including switching back", async (operation) => {
  const app = createApp();
  const internals = cleanupInternals(app);
  const { pending, done, apply } = startPendingCleanup(app, operation);
  vi.spyOn(internals.sessions, "clearActiveSession").mockImplementation(() => undefined);
  vi.spyOn(internals.realtime, "close").mockImplementation(() => undefined);
  vi.spyOn(internals, "connectRealtime").mockImplementation(() => undefined);
  vi.spyOn(internals, "loadPluginsForSelectedMachine").mockResolvedValue();
  vi.spyOn(internals, "setState").mockImplementation(() => undefined);
  const local = internals.state;
  const remote: AppState = { ...local, selectedMachine: { id: "remote", name: "Remote", kind: "remote", baseUrl: "https://remote.invalid", createdAt: result.generatedAt, updatedAt: result.generatedAt } };
  internals.state = remote;
  internals.handleMachineChange(local, remote);
  internals.state = local;
  internals.handleMachineChange(remote, local);
  internals.openSessionCleanupDialog();
  const dialog = internals.sessionCleanupDialog;
  pending.resolve(result);
  await done;
  expect(internals.sessionCleanupDialog).toBe(dialog);
  if (operation === "run") expect(apply).toHaveBeenCalledWith(result, "local");
});

it("does not reconcile execution results into a different machine", async () => {
  const app = createApp();
  const internals = cleanupInternals(app);
  const { pending, done, apply } = startPendingCleanup(app, "run");
  internals.state = { ...internals.state, selectedMachine: { id: "remote", name: "Remote", kind: "remote", baseUrl: "https://remote.invalid", createdAt: result.generatedAt, updatedAt: result.generatedAt } };
  const dialog = internals.sessionCleanupDialog;
  pending.resolve(result);
  await done;
  expect(internals.sessionCleanupDialog).toBe(dialog);
  expect(apply).not.toHaveBeenCalled();
});

it("does not reopen a closed dialog from late preview or run callbacks", async () => {
  const app = createApp();
  cleanupInternals(app).closeSessionCleanupDialog();
  const preview = vi.spyOn(sessionsApi, "cleanupPreview");
  const run = vi.spyOn(sessionsApi, "cleanup");
  await cleanupMethod(app, "previewSessionCleanup")(request);
  await cleanupMethod(app, "runSessionCleanup")(request);
  expect(cleanupInternals(app).sessionCleanupDialog).toBeUndefined();
  expect(preview).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
});

it("does not overwrite a reopened dialog when result reconciliation fails", async () => {
  const app = createApp();
  const internals = cleanupInternals(app);
  const { pending, done, apply } = startPendingCleanup(app, "run");
  const reconciliation = deferred<undefined>();
  apply.mockImplementation(() => {
    internals.closeSessionCleanupDialog();
    internals.openSessionCleanupDialog();
    return reconciliation.promise;
  });
  pending.resolve(result);
  await Promise.resolve();
  const dialog = internals.sessionCleanupDialog;
  reconciliation.reject(new Error("Refresh failed"));
  await done;
  expect(apply).toHaveBeenCalledWith(result, "local");
  expect(internals.sessionCleanupDialog).toBe(dialog);
});

it("invalidates the preview after success so the same targets cannot be rerun", async () => {
  const app = createApp();
  const { pending, done, apply } = startPendingCleanup(app, "run");
  await cleanupMethod(app, "runSessionCleanup")(request);
  expect(sessionsApi.cleanup).toHaveBeenCalledOnce();
  pending.resolve(result);
  await done;
  expect(cleanupInternals(app).sessionCleanupDialog).toMatchObject({
    result, preview: undefined, previewRequest: undefined, running: false,
  });
  expect(apply).toHaveBeenCalledWith(result, "local");
  await cleanupMethod(app, "runSessionCleanup")(request);
  expect(sessionsApi.cleanup).toHaveBeenCalledOnce();
  expect(cleanupError(app)()).toBe(messages.t("previewRequired"));
});
