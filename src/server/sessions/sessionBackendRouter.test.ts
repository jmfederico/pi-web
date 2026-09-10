import { describe, expect, it } from "vitest";
import type {
  SessionBulkArchiveResponse,
  SessionBulkFailure,
  SessionBulkMutationRef,
  SessionCleanupExecuteResponse,
  SessionCleanupPreviewResponse,
  SessionNotificationCatalogSnapshot,
  SessionUnreadAcknowledgeRequest,
  SessionUnreadCatalogSnapshot,
} from "../../shared/apiTypes.js";
import type { ClientSession } from "../types.js";
import type { SessionRouteRef, SessionRouteService } from "./sessionService.js";
import type { NormalizedSessionCleanupRequest } from "./sessionCleanup.js";
import { OmpBackendUnavailableError, SessionBackendRouter, type SessionBackendEngine } from "./sessionBackendRouter.js";

const PI_REF: SessionRouteRef = { id: "11111111-1111-4111-8111-111111111111", cwd: "/workspace" };
const OMP_REF: SessionRouteRef = { id: "omp:22222222-2222-4222-8222-222222222222", cwd: "/workspace" };
const OMP_SESSION_ID = "omp:33333333-3333-4333-8333-333333333333";
const PI_SESSION_ID = "44444444-4444-4444-8444-444444444444";
const GENERATED_AT = "2026-01-01T00:00:00.000Z";

const PI_SESSION_INFO: ClientSession = {
  id: PI_SESSION_ID,
  cwd: "/workspace",
  path: "/workspace/.pi/sessions/pi-session.jsonl",
  created: GENERATED_AT,
  modified: GENERATED_AT,
  messageCount: 1,
  firstMessage: "hello from pi",
};

const OMP_SESSION_INFO: ClientSession = {
  id: OMP_SESSION_ID,
  cwd: "/workspace",
  path: "/home/test/.omp/agent/sessions/omp-session.jsonl",
  created: GENERATED_AT,
  modified: GENERATED_AT,
  messageCount: 1,
  firstMessage: "hello from omp",
  backend: "omp",
};

const EMPTY_CLEANUP_PREVIEW: SessionCleanupPreviewResponse = { generatedAt: GENERATED_AT, thresholds: {}, projects: [], totals: { archiveCount: 0, deleteCount: 0 } };
const EMPTY_CLEANUP_EXECUTE: SessionCleanupExecuteResponse = { ...EMPTY_CLEANUP_PREVIEW, archivedSessionIds: [], deletedSessionIds: [] };

interface BackendCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

interface RecordingBackend extends SessionBackendEngine {
  readonly calls: BackendCall[];
  setResult(method: string, value: unknown): void;
  setFailure(method: string, error: Error): void;
}

/**
 * A test double for one engine side of the router (pi or omp), never for the
 * router itself. Records every call generically so one fixture covers all
 * `SessionRouteService` members, and returns a per-call marker object by
 * default so a test can assert the router propagated the return value.
 */
function createRecordingBackend(label: string): RecordingBackend {
  const calls: BackendCall[] = [];
  const results: Record<string, unknown> = {};
  const failures: Record<string, Error> = {};
  const handler: ProxyHandler<object> = {
    get(target, prop, receiver): unknown {
      if (prop === "calls") return calls;
      if (prop === "setResult") return (method: string, value: unknown) => { results[method] = value; };
      if (prop === "setFailure") return (method: string, error: Error) => { failures[method] = error; };
      if (typeof prop !== "string") return Reflect.get(target, prop, receiver);
      return (...args: unknown[]) => {
        calls.push({ method: prop, args });
        const failure = failures[prop];
        if (failure !== undefined) throw failure;
        return prop in results ? results[prop] : { backend: label, method: prop, args };
      };
    },
  };
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- This recording Proxy supplies every engine method dynamically; each test configures the response for the method it exercises.
  return new Proxy({}, handler) as RecordingBackend;
}

/** Invokes a dynamically selected route method while preserving its receiver. */
function invokeRefMethod(target: SessionRouteService, method: string, ref: SessionRouteRef, args: readonly unknown[]): unknown {
  const fn: unknown = Reflect.get(target, method);
  if (typeof fn !== "function") throw new Error(`Unknown SessionRouteService method: ${method}`);
  return Reflect.apply(fn, target, [ref, ...args]);
}

type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown };

async function captureOutcome(run: () => unknown): Promise<Outcome> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, error };
  }
}

interface RefMethodCase {
  readonly method: string;
  readonly args: readonly unknown[];
}

// Every ref-scoped `SessionRouteService` member (sessionService.ts:48-101)
// except the cwd-scoped/global members covered in their own `describe`
// blocks below. Args are opaque payloads the router forwards without
// inspecting, so placeholder shapes are enough for a dispatch test.
const REF_METHOD_CASES: readonly RefMethodCase[] = [
  { method: "messages", args: [{ before: 40, limit: 20 }] },
  { method: "status", args: [] },
  { method: "streamSnapshot", args: [] },
  { method: "notificationInbox", args: [] },
  { method: "dismissNotification", args: [{ daemonInstanceId: "daemon-1", notificationId: "note-1" }] },
  { method: "dismissAllNotifications", args: [{ daemonInstanceId: "daemon-1", throughOrder: 4, throughOverflowWatermark: 0 }] },
  { method: "clearQueue", args: [] },
  { method: "submitAsk", args: ["ask-1", { answers: [] }] },
  { method: "cancelAsk", args: ["ask-1"] },
  { method: "answerDialog", args: ["dialog-1", "yes"] },
  { method: "cancelDialog", args: ["dialog-1"] },
  { method: "dismissWarning", args: ["warning-1"] },
  { method: "availableModels", args: [] },
  { method: "modelCatalog", args: [] },
  { method: "setModel", args: ["anthropic", "claude-test"] },
  { method: "setModelEnabled", args: ["anthropic", "claude-test", true] },
  { method: "setModelScope", args: ["all"] },
  { method: "cycleModel", args: ["forward"] },
  { method: "availableThinkingLevels", args: [] },
  { method: "setThinkingLevel", args: ["high"] },
  { method: "cycleThinkingLevel", args: [] },
  { method: "commands", args: [] },
  { method: "prompt", args: ["hello there", undefined, undefined] },
  { method: "saveAttachments", args: [[], "attachments-folder"] },
  { method: "shell", args: ["ls -la"] },
  { method: "runCommand", args: ["/help"] },
  { method: "respondToCommand", args: ["request-1", "value"] },
  { method: "navigateTree", args: [{ targetId: "entry-1", expectedLeafId: null }] },
  { method: "forkFromTree", args: [{ entryId: "entry-1", expectedLeafId: null }] },
  { method: "abort", args: [] },
  { method: "stop", args: [] },
  { method: "archive", args: [] },
  { method: "archiveTree", args: [] },
  { method: "restore", args: [] },
  { method: "reload", args: [] },
  { method: "detachParent", args: [] },
];

describe.each(REF_METHOD_CASES)("$method(ref, ...) prefix routing", ({ method, args }) => {
  it("routes to pi for a pi-shaped ref, and never touches omp", async () => {
    const pi = createRecordingBackend("pi");
    const omp = createRecordingBackend("omp");
    const router = new SessionBackendRouter({ pi, omp });

    await invokeRefMethod(router, method, PI_REF, args);

    expect(pi.calls).toEqual([{ method, args: [PI_REF, ...args] }]);
    expect(omp.calls).toEqual([]);
  });

  it("routes to omp for an omp-prefixed ref, and never touches pi (omp owns its own prefix normalization)", async () => {
    const pi = createRecordingBackend("pi");
    const omp = createRecordingBackend("omp");
    const router = new SessionBackendRouter({ pi, omp });

    await invokeRefMethod(router, method, OMP_REF, args);

    expect(omp.calls).toEqual([{ method, args: [OMP_REF, ...args] }]);
    expect(pi.calls).toEqual([]);
  });

  it("never falls through to pi when omp is unconfigured", async () => {
    const pi = createRecordingBackend("pi");
    const router = new SessionBackendRouter({ pi });

    const outcome = await captureOutcome(() => invokeRefMethod(router, method, OMP_REF, args));

    if (outcome.ok) throw new Error("expected the router to reject when omp is unconfigured");
    expect(outcome.error).toBeInstanceOf(OmpBackendUnavailableError);
    expect(pi.calls).toEqual([]);
  });
});

describe("ref-scoped failure propagation", () => {
  // A representative sample across arg shapes (0-arg, string args, an
  // object-shaped arg), not all 36 methods: the dispatch-then-propagate
  // mechanism is identical for every table entry above.
  const representativeCases: readonly RefMethodCase[] = [
    { method: "status", args: [] },
    { method: "setModel", args: ["anthropic", "claude-test"] },
    { method: "dismissNotification", args: [{ daemonInstanceId: "daemon-1", notificationId: "note-1" }] },
  ];

  it.each(representativeCases)("propagates a failure from the owning engine ($method) without invoking the other engine", async ({ method, args }) => {
    const pi = createRecordingBackend("pi");
    const omp = createRecordingBackend("omp");
    omp.setFailure(method, new Error(`omp ${method} failed`));
    const router = new SessionBackendRouter({ pi, omp });

    const outcome = await captureOutcome(() => invokeRefMethod(router, method, OMP_REF, args));

    if (outcome.ok) throw new Error("expected the router to reject when the owning engine fails");
    expect(outcome.error).toEqual(new Error(`omp ${method} failed`));
    expect(pi.calls).toEqual([]);
  });
});

describe("acknowledgeUnread(sessionId, request)", () => {
  const request: SessionUnreadAcknowledgeRequest = { cwd: "/workspace", catalogId: "catalog-1", throughCompletionOrder: 3 };

  it("routes to pi for a pi-shaped sessionId", async () => {
    const pi = createRecordingBackend("pi");
    const omp = createRecordingBackend("omp");
    const router = new SessionBackendRouter({ pi, omp });

    await router.acknowledgeUnread(PI_SESSION_ID, request);

    expect(pi.calls).toEqual([{ method: "acknowledgeUnread", args: [PI_SESSION_ID, request] }]);
    expect(omp.calls).toEqual([]);
  });

  it("routes to omp for an omp-prefixed sessionId, never touching pi", async () => {
    const pi = createRecordingBackend("pi");
    const omp = createRecordingBackend("omp");
    const router = new SessionBackendRouter({ pi, omp });

    await router.acknowledgeUnread(OMP_SESSION_ID, request);

    expect(omp.calls).toEqual([{ method: "acknowledgeUnread", args: [OMP_SESSION_ID, request] }]);
    expect(pi.calls).toEqual([]);
  });

  it("throws without touching pi when the sessionId is omp-prefixed and omp is unconfigured", async () => {
    const pi = createRecordingBackend("pi");
    const router = new SessionBackendRouter({ pi });

    await expect(router.acknowledgeUnread(OMP_SESSION_ID, request)).rejects.toBeInstanceOf(OmpBackendUnavailableError);
    expect(pi.calls).toEqual([]);
  });
});

describe("list(cwd)", () => {
  it("merges sessions from both engines when omp is configured", async () => {
    const pi = createRecordingBackend("pi");
    const omp = createRecordingBackend("omp");
    pi.setResult("list", [PI_SESSION_INFO]);
    omp.setResult("list", [OMP_SESSION_INFO]);
    const router = new SessionBackendRouter({ pi, omp });

    const result = await router.list("/workspace");

    expect(pi.calls).toEqual([{ method: "list", args: ["/workspace"] }]);
    expect(omp.calls).toEqual([{ method: "list", args: ["/workspace"] }]);
    expect(result).toHaveLength(2);
    expect(result).toEqual(expect.arrayContaining([PI_SESSION_INFO, OMP_SESSION_INFO]));
  });

  it("returns pi-only sessions and never calls omp when omp is not configured", async () => {
    const pi = createRecordingBackend("pi");
    pi.setResult("list", [PI_SESSION_INFO]);
    const router = new SessionBackendRouter({ pi });

    await expect(router.list("/workspace")).resolves.toEqual([PI_SESSION_INFO]);
  });

  it("propagates an omp failure instead of silently returning pi-only results", async () => {
    const pi = createRecordingBackend("pi");
    const omp = createRecordingBackend("omp");
    pi.setResult("list", [PI_SESSION_INFO]);
    omp.setFailure("list", new Error("omp transcript scan failed"));
    const router = new SessionBackendRouter({ pi, omp });

    await expect(router.list("/workspace")).rejects.toThrow("omp transcript scan failed");
    expect(pi.calls).toEqual([{ method: "list", args: ["/workspace"] }]);
  });
});

describe("start(cwd, options)", () => {
  it("defaults to pi when no backend option is given, forwarding startupToken unchanged", async () => {
    const pi = createRecordingBackend("pi");
    const omp = createRecordingBackend("omp");
    const router = new SessionBackendRouter({ pi, omp });

    await router.start("/workspace", { startupToken: "token-1" });

    expect(pi.calls).toEqual([{ method: "start", args: ["/workspace", { startupToken: "token-1" }] }]);
    expect(omp.calls).toEqual([]);
  });

  it("defaults to pi when options are omitted entirely", async () => {
    const pi = createRecordingBackend("pi");
    const router = new SessionBackendRouter({ pi });

    await router.start("/workspace");

    expect(pi.calls).toEqual([{ method: "start", args: ["/workspace", undefined] }]);
  });

  it("routes an explicit omp backend option to omp, stripping the dispatch-only backend key, never touching pi", async () => {
    const pi = createRecordingBackend("pi");
    const omp = createRecordingBackend("omp");
    const router = new SessionBackendRouter({ pi, omp });

    await router.start("/workspace", { startupToken: "token-1", backend: "omp" });

    expect(omp.calls).toEqual([{ method: "start", args: ["/workspace", { startupToken: "token-1" }] }]);
    expect(pi.calls).toEqual([]);
  });

  it("throws and never falls back to pi when omp is requested but unconfigured", async () => {
    const pi = createRecordingBackend("pi");
    const router = new SessionBackendRouter({ pi });

    await expect(router.start("/workspace", { backend: "omp" })).rejects.toBeInstanceOf(OmpBackendUnavailableError);
    expect(pi.calls).toEqual([]);
  });

  it("fails closed on an unrecognized backend value instead of silently defaulting to pi", async () => {
    const pi = createRecordingBackend("pi");
    const omp = createRecordingBackend("omp");
    const router = new SessionBackendRouter({ pi, omp });

    await expect(Reflect.apply(router.start.bind(router), undefined, ["/workspace", { backend: "bogus" }])).rejects.toThrow();
    expect(pi.calls).toEqual([]);
    expect(omp.calls).toEqual([]);
  });
});

describe("notificationCatalog()", () => {
  // Pi's notificationCatalog() is a synchronous read of in-memory store
  // state with no per-engine flush to coordinate (see piSessionService.ts),
  // so querying omp too would be redundant.
  it("delegates to pi only", async () => {
    const pi = createRecordingBackend("pi");
    const omp = createRecordingBackend("omp");
    const snapshot: SessionNotificationCatalogSnapshot = { daemonInstanceId: "daemon-1", catalogRevision: 3, sessions: [] };
    pi.setResult("notificationCatalog", snapshot);
    const router = new SessionBackendRouter({ pi, omp });

    const result = await router.notificationCatalog();

    expect(result).toBe(snapshot);
    expect(pi.calls).toEqual([{ method: "notificationCatalog", args: [] }]);
    expect(omp.calls).toEqual([]);
  });
});

describe("unreadCatalog()", () => {
  // Mirrors PiSessionService's own publishUnreadMutations([]) drain: flush
  // omp's pending writes to the shared store first, then read the durable
  // snapshot through pi.
  it("flushes omp before reading pi's durable snapshot", async () => {
    const pi = createRecordingBackend("pi");
    const omp = createRecordingBackend("omp");
    const snapshot: SessionUnreadCatalogSnapshot = { catalogId: "catalog-1", catalogRevision: 5, sessions: [] };
    pi.setResult("unreadCatalog", snapshot);
    const router = new SessionBackendRouter({ pi, omp });

    const result = await router.unreadCatalog();

    expect(omp.calls).toEqual([{ method: "unreadCatalog", args: [] }]);
    expect(pi.calls).toEqual([{ method: "unreadCatalog", args: [] }]);
    expect(result).toBe(snapshot);
  });

  it("skips the omp flush and reads only pi when omp is not configured", async () => {
    const pi = createRecordingBackend("pi");
    const snapshot: SessionUnreadCatalogSnapshot = { catalogId: "catalog-1", catalogRevision: 1, sessions: [] };
    pi.setResult("unreadCatalog", snapshot);
    const router = new SessionBackendRouter({ pi });

    await expect(router.unreadCatalog()).resolves.toBe(snapshot);
  });

  it("surfaces an omp flush failure instead of silently returning a possibly-stale pi snapshot", async () => {
    const pi = createRecordingBackend("pi");
    const omp = createRecordingBackend("omp");
    omp.setFailure("unreadCatalog", new Error("omp flush failed"));
    const router = new SessionBackendRouter({ pi, omp });

    await expect(router.unreadCatalog()).rejects.toThrow("omp flush failed");
    expect(pi.calls).toEqual([]);
  });
});

describe("archiveMany(refs)", () => {
  it("routes a pure-pi batch to pi only", async () => {
    const pi = createRecordingBackend("pi");
    const omp = createRecordingBackend("omp");
    const refs: SessionBulkMutationRef[] = [{ id: PI_SESSION_ID, cwd: "/workspace" }];
    const piResponse: SessionBulkArchiveResponse = { archived: true, archivedSessionIds: [PI_SESSION_ID], failures: [], generatedAt: GENERATED_AT };
    pi.setResult("archiveMany", piResponse);
    const router = new SessionBackendRouter({ pi, omp });

    const result = await router.archiveMany(refs);

    expect(pi.calls).toEqual([{ method: "archiveMany", args: [refs] }]);
    expect(omp.calls).toEqual([]);
    expect(result.archivedSessionIds).toEqual([PI_SESSION_ID]);
  });

  it("routes a pure-omp batch to omp only when configured", async () => {
    const pi = createRecordingBackend("pi");
    const omp = createRecordingBackend("omp");
    const refs: SessionBulkMutationRef[] = [{ id: OMP_SESSION_ID, cwd: "/workspace" }];
    const ompResponse: SessionBulkArchiveResponse = { archived: true, archivedSessionIds: [OMP_SESSION_ID], failures: [], generatedAt: GENERATED_AT };
    omp.setResult("archiveMany", ompResponse);
    const router = new SessionBackendRouter({ pi, omp });

    const result = await router.archiveMany(refs);

    expect(omp.calls).toEqual([{ method: "archiveMany", args: [refs] }]);
    expect(pi.calls).toEqual([]);
    expect(result.archivedSessionIds).toEqual([OMP_SESSION_ID]);
  });

  it("splits a mixed batch, calling each engine with only its own refs, and merges both responses", async () => {
    const pi = createRecordingBackend("pi");
    const omp = createRecordingBackend("omp");
    const piRef: SessionBulkMutationRef = { id: PI_SESSION_ID, cwd: "/workspace" };
    const ompRef: SessionBulkMutationRef = { id: OMP_SESSION_ID, cwd: "/workspace" };
    const piFailure: SessionBulkFailure = { sessionId: "unrelated-pi-id", error: "busy" };
    pi.setResult("archiveMany", { archived: true, archivedSessionIds: [PI_SESSION_ID], failures: [piFailure], generatedAt: GENERATED_AT });
    omp.setResult("archiveMany", { archived: true, archivedSessionIds: [OMP_SESSION_ID], failures: [], generatedAt: GENERATED_AT });
    const router = new SessionBackendRouter({ pi, omp });

    const result = await router.archiveMany([piRef, ompRef]);

    expect(pi.calls).toEqual([{ method: "archiveMany", args: [[piRef]] }]);
    expect(omp.calls).toEqual([{ method: "archiveMany", args: [[ompRef]] }]);
    expect(result.archivedSessionIds).toEqual(expect.arrayContaining([PI_SESSION_ID, OMP_SESSION_ID]));
    expect(result.archivedSessionIds).toHaveLength(2);
    expect(result.failures).toEqual([piFailure]);
    expect(result.archived).toBe(true);
  });

  it("produces an explicit per-ref failure instead of silently dropping an omp ref when omp is unconfigured", async () => {
    const pi = createRecordingBackend("pi");
    const piRef: SessionBulkMutationRef = { id: PI_SESSION_ID, cwd: "/workspace" };
    const ompRef: SessionBulkMutationRef = { id: OMP_SESSION_ID, cwd: "/workspace" };
    pi.setResult("archiveMany", { archived: true, archivedSessionIds: [PI_SESSION_ID], failures: [], generatedAt: GENERATED_AT });
    const router = new SessionBackendRouter({ pi });

    const result = await router.archiveMany([piRef, ompRef]);

    expect(pi.calls).toEqual([{ method: "archiveMany", args: [[piRef]] }]);
    expect(result.archivedSessionIds).toEqual([PI_SESSION_ID]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.sessionId).toBe(OMP_SESSION_ID);
  });
});

describe("deleteArchivedMany(refs)", () => {
  it("splits a mixed batch, calling each engine with only its own refs, and merges both responses", async () => {
    const pi = createRecordingBackend("pi");
    const omp = createRecordingBackend("omp");
    const piRef: SessionBulkMutationRef = { id: PI_SESSION_ID, cwd: "/workspace" };
    const ompRef: SessionBulkMutationRef = { id: OMP_SESSION_ID, cwd: "/workspace" };
    pi.setResult("deleteArchivedMany", { deleted: true, deletedSessionIds: [PI_SESSION_ID], failures: [], generatedAt: GENERATED_AT });
    omp.setResult("deleteArchivedMany", { deleted: true, deletedSessionIds: [OMP_SESSION_ID], failures: [], generatedAt: GENERATED_AT });
    const router = new SessionBackendRouter({ pi, omp });

    const result = await router.deleteArchivedMany([piRef, ompRef]);

    expect(pi.calls).toEqual([{ method: "deleteArchivedMany", args: [[piRef]] }]);
    expect(omp.calls).toEqual([{ method: "deleteArchivedMany", args: [[ompRef]] }]);
    expect(result.deletedSessionIds).toEqual(expect.arrayContaining([PI_SESSION_ID, OMP_SESSION_ID]));
    expect(result.deletedSessionIds).toHaveLength(2);
  });

  it("produces an explicit per-ref failure instead of silently dropping an omp ref when omp is unconfigured", async () => {
    const pi = createRecordingBackend("pi");
    const ompRef: SessionBulkMutationRef = { id: OMP_SESSION_ID, cwd: "/workspace" };
    pi.setResult("deleteArchivedMany", { deleted: true, deletedSessionIds: [], failures: [], generatedAt: GENERATED_AT });
    const router = new SessionBackendRouter({ pi });

    const result = await router.deleteArchivedMany([ompRef]);

    expect(pi.calls).toEqual([]);
    expect(result.deletedSessionIds).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.sessionId).toBe(OMP_SESSION_ID);
  });
});

describe("cleanupPreview(request) / cleanup(request)", () => {
  const request: NormalizedSessionCleanupRequest = { thresholds: { archiveIdleDays: 30 } };

  // A whole-instance cleanup UI must never silently omit OMP sessions, and
  // each engine scans against its own separate archive store (Pi's default
  // path, OMP's own subpath), so this is a real merge, not a pi-only
  // passthrough.
  it.each(["cleanupPreview", "cleanup"] as const)("calls both engines with the identical request when omp is configured", async (method) => {
    const pi = createRecordingBackend("pi");
    const omp = createRecordingBackend("omp");
    const response = method === "cleanup" ? EMPTY_CLEANUP_EXECUTE : EMPTY_CLEANUP_PREVIEW;
    pi.setResult(method, response);
    omp.setResult(method, response);
    const router = new SessionBackendRouter({ pi, omp });

    await router[method](request);

    expect(pi.calls).toEqual([{ method, args: [request] }]);
    expect(omp.calls).toEqual([{ method, args: [request] }]);
  });

  it.each(["cleanupPreview", "cleanup"] as const)("returns pi's response unchanged when omp is not configured", async (method) => {
    const pi = createRecordingBackend("pi");
    const base = method === "cleanup" ? EMPTY_CLEANUP_EXECUTE : EMPTY_CLEANUP_PREVIEW;
    const piResponse = { ...base, projects: [{ cwd: "/workspace", archiveCount: 2, deleteCount: 0 }] };
    pi.setResult(method, piResponse);
    const router = new SessionBackendRouter({ pi });

    await expect(router[method](request)).resolves.toEqual(piResponse);
  });

  it("sums project summary counts by cwd when both engines report the same project", async () => {
    const pi = createRecordingBackend("pi");
    const omp = createRecordingBackend("omp");
    pi.setResult("cleanupPreview", { ...EMPTY_CLEANUP_PREVIEW, projects: [{ cwd: "/workspace", archiveCount: 2, deleteCount: 1 }] });
    omp.setResult("cleanupPreview", { ...EMPTY_CLEANUP_PREVIEW, projects: [{ cwd: "/workspace", archiveCount: 1, deleteCount: 0 }] });
    const router = new SessionBackendRouter({ pi, omp });

    const result = await router.cleanupPreview(request);

    expect(result.projects).toEqual([{ cwd: "/workspace", archiveCount: 3, deleteCount: 1 }]);
  });

  it("keeps distinct cwd project summaries from each engine separate", async () => {
    const pi = createRecordingBackend("pi");
    const omp = createRecordingBackend("omp");
    pi.setResult("cleanupPreview", { ...EMPTY_CLEANUP_PREVIEW, projects: [{ cwd: "/workspace-a", archiveCount: 2, deleteCount: 0 }] });
    omp.setResult("cleanupPreview", { ...EMPTY_CLEANUP_PREVIEW, projects: [{ cwd: "/workspace-b", archiveCount: 1, deleteCount: 0 }] });
    const router = new SessionBackendRouter({ pi, omp });

    const result = await router.cleanupPreview(request);

    expect(result.projects).toEqual(expect.arrayContaining([
      { cwd: "/workspace-a", archiveCount: 2, deleteCount: 0 },
      { cwd: "/workspace-b", archiveCount: 1, deleteCount: 0 },
    ]));
    expect(result.projects).toHaveLength(2);
  });

  it("sums totals across both engines", async () => {
    const pi = createRecordingBackend("pi");
    const omp = createRecordingBackend("omp");
    pi.setResult("cleanupPreview", { ...EMPTY_CLEANUP_PREVIEW, totals: { archiveCount: 4, deleteCount: 2 } });
    omp.setResult("cleanupPreview", { ...EMPTY_CLEANUP_PREVIEW, totals: { archiveCount: 1, deleteCount: 3 } });
    const router = new SessionBackendRouter({ pi, omp });

    const result = await router.cleanupPreview(request);

    expect(result.totals).toEqual({ archiveCount: 5, deleteCount: 5 });
  });

  it("concatenates skippedBusySessionIds from both engines, and omits the field entirely when neither engine reports one (matches the single-engine response convention)", async () => {
    const pi = createRecordingBackend("pi");
    const omp = createRecordingBackend("omp");
    pi.setResult("cleanupPreview", { ...EMPTY_CLEANUP_PREVIEW, skippedBusySessionIds: [PI_SESSION_ID] });
    omp.setResult("cleanupPreview", { ...EMPTY_CLEANUP_PREVIEW, skippedBusySessionIds: [OMP_SESSION_ID] });
    const router = new SessionBackendRouter({ pi, omp });

    const result = await router.cleanupPreview(request);

    expect(result.skippedBusySessionIds).toEqual(expect.arrayContaining([PI_SESSION_ID, OMP_SESSION_ID]));

    const pi2 = createRecordingBackend("pi");
    const omp2 = createRecordingBackend("omp");
    pi2.setResult("cleanupPreview", EMPTY_CLEANUP_PREVIEW);
    omp2.setResult("cleanupPreview", EMPTY_CLEANUP_PREVIEW);
    const router2 = new SessionBackendRouter({ pi: pi2, omp: omp2 });

    const result2 = await router2.cleanupPreview(request);

    expect(result2).not.toHaveProperty("skippedBusySessionIds");
  });

  it("concatenates archivedSessionIds/deletedSessionIds from both engines for cleanup (execute)", async () => {
    const pi = createRecordingBackend("pi");
    const omp = createRecordingBackend("omp");
    pi.setResult("cleanup", { ...EMPTY_CLEANUP_EXECUTE, archivedSessionIds: [PI_SESSION_ID] });
    omp.setResult("cleanup", { ...EMPTY_CLEANUP_EXECUTE, deletedSessionIds: [OMP_SESSION_ID] });
    const router = new SessionBackendRouter({ pi, omp });

    const result = await router.cleanup(request);

    expect(result.archivedSessionIds).toEqual([PI_SESSION_ID]);
    expect(result.deletedSessionIds).toEqual([OMP_SESSION_ID]);
  });

  it.each(["cleanupPreview", "cleanup"] as const)("propagates an omp failure instead of silently returning a pi-only result", async (method) => {
    const pi = createRecordingBackend("pi");
    const omp = createRecordingBackend("omp");
    pi.setResult(method, EMPTY_CLEANUP_PREVIEW);
    omp.setFailure(method, new Error(`omp ${method} failed`));
    const router = new SessionBackendRouter({ pi, omp });

    await expect(router[method](request)).rejects.toThrow(`omp ${method} failed`);
    expect(pi.calls).toEqual([{ method, args: [request] }]);
  });
});

describe("activeCount()", () => {
  it("sums both engines when omp is configured", () => {
    const pi = createRecordingBackend("pi");
    pi.setResult("activeCount", 5);
    const omp = createRecordingBackend("omp");
    omp.setResult("activeCount", 3);
    const router = new SessionBackendRouter({ pi, omp });

    expect(router.activeCount()).toBe(8);
  });

  it("reflects pi alone when omp is not configured", () => {
    const pi = createRecordingBackend("pi");
    pi.setResult("activeCount", 5);
    const router = new SessionBackendRouter({ pi });

    expect(router.activeCount()).toBe(5);
  });
});

// dispose()/activeCount() are daemon lifecycle hooks, not part of
// `SessionRouteService` (mirroring how PiSessionService/OmpSessionService
// both already expose them). `applyAuthChange` deliberately has no router
// method at all: Pi auth/model global settings stay Pi-only, so sessiond.ts
// keeps a direct reference to the underlying Pi engine for that call instead
// of routing it through the composite surface.
describe("dispose()", () => {
  it("disposes both engines", async () => {
    const pi = createRecordingBackend("pi");
    const omp = createRecordingBackend("omp");
    const router = new SessionBackendRouter({ pi, omp });

    await router.dispose();

    expect(pi.calls).toEqual([{ method: "dispose", args: [] }]);
    expect(omp.calls).toEqual([{ method: "dispose", args: [] }]);
  });

  it("disposes pi alone when omp is not configured, without crashing on a missing engine", async () => {
    const pi = createRecordingBackend("pi");
    const router = new SessionBackendRouter({ pi });

    await expect(router.dispose()).resolves.toBeUndefined();
    expect(pi.calls).toEqual([{ method: "dispose", args: [] }]);
  });

  it("still disposes omp when pi's dispose fails, then surfaces the failure", async () => {
    const pi = createRecordingBackend("pi");
    pi.setFailure("dispose", new Error("pi dispose failed"));
    const omp = createRecordingBackend("omp");
    const router = new SessionBackendRouter({ pi, omp });

    await expect(router.dispose()).rejects.toThrow("pi dispose failed");
    expect(omp.calls).toEqual([{ method: "dispose", args: [] }]);
  });
});
