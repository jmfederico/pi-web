import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo, Workspace } from "../api";
import { initialAppState, type AppState } from "../appState";
import type { WorkspacePanelContext } from "../plugins/types";
import { PiWebApp } from "./PiWebApp";

const workspace: Workspace = {
  id: "workspace-1",
  projectId: "project-1",
  path: "/repo",
  label: "main",
  isMain: true,
  effectiveConfig: {},
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PiWebApp workspace panel context review adapter", () => {
  it("exposes a review service that delegates to the shared ReviewController state", () => {
    const app = createApp();
    setAppState(app, { ...initialAppState(), selectedWorkspace: workspace, workspaces: [workspace] });

    const context = createWorkspacePanelContext(app, workspace);

    expect(context.review).toBeDefined();
    expect(context.review.total()).toBe(0);
    expect(context.review.canAuthor()).toBe(false); // no selected session yet

    setAppState(app, { ...appState(app), selectedSession: sessionInfo("session-1") });
    const authoring = createWorkspacePanelContext(app, workspace);
    expect(authoring.review.canAuthor()).toBe(true);

    authoring.review.beginSelection("src/a.ts", { side: "new", line: 3 });
    authoring.review.extendSelection({ side: "new", line: 5 });
    authoring.review.commitSelection("hash-1");

    const draft = authoring.review.draftForLine("src/a.ts", { side: "new", line: 4 });
    expect(draft).toEqual({ anchor: { filePath: "src/a.ts", range: { side: "new", start: 3, end: 5 } }, body: "" });

    authoring.review.setDraftBody("looks good");
    authoring.review.submitDraft();

    expect(authoring.review.total()).toBe(1);
    expect(authoring.review.countForFile("src/a.ts")).toBe(1);
    const comments = authoring.review.commentsForLine("src/a.ts", { side: "new", line: 4 });
    expect(comments).toHaveLength(1);
    const [comment] = comments;
    if (comment === undefined) throw new Error("Expected the submitted review comment to be present");
    expect(comment.body).toBe("looks good");

    authoring.review.updateComment(comment.id, "updated body", comment.anchor);
    const [updated] = authoring.review.commentsForLine("src/a.ts", { side: "new", line: 4 });
    expect(updated?.body).toBe("updated body");

    authoring.review.removeComment(comment.id);
    expect(authoring.review.total()).toBe(0);
  });

  it("exposes invalidateFile (core-only, for CodeViewer staleness invalidation) alongside the public review service", () => {
    const app = createApp();
    setAppState(app, { ...initialAppState(), selectedWorkspace: workspace, workspaces: [workspace], selectedSession: sessionInfo("session-1") });
    const context = createWorkspacePanelContext(app, workspace);

    context.review.beginSelection("src/a.ts", { side: "new", line: 1 });
    context.review.commitSelection("hash-1");
    context.review.setDraftBody("stale comment");
    context.review.submitDraft();
    expect(context.review.countForFile("src/a.ts")).toBe(1);

    const invalidateFile: unknown = Reflect.get(context.review, "invalidateFile");
    if (typeof invalidateFile !== "function") throw new Error("Expected the review adapter to expose invalidateFile");
    Reflect.apply(invalidateFile, context.review, ["src/a.ts", "different-hash"]);

    expect(context.review.countForFile("src/a.ts")).toBe(0);
  });
});

function createApp(): PiWebApp {
  const storage = {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  };
  vi.stubGlobal("window", { location: { search: "" }, localStorage: storage });
  return new PiWebApp();
}

function setAppState(app: PiWebApp, state: AppState): void {
  if (!Reflect.set(app, "state", state)) throw new Error("Could not set PiWebApp state");
}

function appState(app: PiWebApp): AppState {
  const state: unknown = Reflect.get(app, "state");
  if (!isAppState(state)) throw new Error("PiWebApp state was unavailable");
  return state;
}

function isAppState(value: unknown): value is AppState {
  return typeof value === "object" && value !== null && "reviewComments" in value;
}

function createWorkspacePanelContext(app: PiWebApp, ws: Workspace): WorkspacePanelContext {
  const create: unknown = Reflect.get(app, "createWorkspacePanelContext");
  if (typeof create !== "function") throw new Error("PiWebApp workspace panel context factory was unavailable");
  const context: unknown = Reflect.apply(create, app, [ws]);
  if (!isWorkspacePanelContext(context)) throw new Error("PiWebApp returned an invalid workspace panel context");
  return context;
}

function isWorkspacePanelContext(value: unknown): value is WorkspacePanelContext {
  return typeof value === "object" && value !== null && "review" in value;
}

describe("PiWebApp eager review element registration", () => {
  it("registers <pi-web-review-thread> as a side effect of loading PiWebApp, independent of the Files tab's lazy CodeViewer import", () => {
    // Regression test: the Git tab mounts `<pi-web-review-thread>` from its
    // own plugin package (which cannot import core source), relying on core
    // having already `customElements.define`d it. Core previously only did
    // so as a side effect of `WorkspaceFileViewer.ts`'s `import("./CodeViewer")`,
    // which only runs once the Files tab actually renders a raw file -- so
    // opening the Git tab first left the element unregistered (rendered
    // unupgraded: no content, minimal size) until the Files tab was later
    // visited. `PiWebApp` (this test file's only import at module scope) must
    // register the element unconditionally, before either tab is touched.
    expect(customElements.get("pi-web-review-thread")).toBeDefined();
  });
});

function sessionInfo(id: string): SessionInfo {
  return {
    id,
    cwd: "/repo",
    path: `/tmp/${id}.jsonl`,
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:00.000Z",
    messageCount: 0,
    firstMessage: "",
  };
}
