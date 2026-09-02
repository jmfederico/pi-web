// @vitest-environment happy-dom

import { html, render, svg } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JsonValue, PluginRuntimeContext, Workspace, WorkspaceBackend, WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import { GIT_FILE_VIEW_STORAGE_KEY } from "./browser/gitFileViewPreference.js";
import plugin from "./browser/pi-web-plugin.js";

const projectId = "project-1";
const workspaceId = "workspace-1";

const gitWorkspace: Workspace = {
  id: workspaceId,
  projectId,
  path: "/repo",
  label: "main",
  isMain: true,
  provider: { pluginId: "git", capabilities: { request: true, remove: false } },
};

afterEach(() => {
  vi.useRealTimers();
  window.localStorage.clear();
  window.history.replaceState({}, "", "/");
  document.body.replaceChildren();
});

describe("bundled Git browser plugin", () => {
  it("contributes provider-owned actions and a panel that replacements suppress", async () => {
    const contributions = activate("git");
    const panel = contributions.workspacePanels?.[0];
    if (panel === undefined) throw new Error("Expected Git workspace panel");
    const backend = backendFixture();
    const context = panelContext(backend.request);

    expect(panel.id).toBe("workspace.git");
    expect(panel.order).toBe(20);
    expect(panel.icon).toBeDefined();
    expect(panel.visible?.(context)).toBe(true);
    expect(panel.visible?.(panelContext(backend.request, {
      ...gitWorkspace,
      // Legacy Git-shaped data must not override a declared replacement owner.
      provider: { pluginId: "jj", capabilities: { request: true, remove: false } },
    }))).toBe(false);

    const selectMainView = vi.fn<PluginRuntimeContext["selectMainView"]>();
    const refreshWorkspacePanels = vi.fn<PluginRuntimeContext["refreshWorkspacePanels"]>(() => panel.onInvalidate?.(context));
    const runtime = runtimeContext({ selectMainView, refreshWorkspacePanels });
    const goToGit = contributions.actions?.find((action) => action.id === "view.git");
    const refresh = contributions.actions?.find((action) => action.id === "workspace.refresh-git");

    expect(contributions.actions?.map(({ id }) => id)).toEqual(["view.git", "workspace.refresh-git"]);
    expect(panel.routeAliases).toEqual(["git", "core:workspace.git"]);
    expect(goToGit?.shortcut).toBe("mod+3");
    expect(goToGit?.shortcutAliases).toEqual(["core:view.git"]);
    expect(refresh?.shortcutAliases).toEqual(["core:workspace.refresh-git"]);
    expect(goToGit?.enabled?.(runtime)).toBe(true);
    await goToGit?.run(runtime);
    expect(selectMainView).toHaveBeenCalledWith("git:workspace.git");

    await refresh?.run(runtime);
    expect(refreshWorkspacePanels).toHaveBeenCalledWith("git:workspace.git");
    expect(backend.request).toHaveBeenCalledWith("status", null);

    backend.request.mockClear();
    await panel.onInvalidate?.(context);
    expect(backend.request).toHaveBeenCalledWith("status", null);
  });

  it("uses source identity for ownership and runtime identity for federated routes", async () => {
    const runtimePluginId = "machine.72656d6f74652d31.git";
    const contributions = activate("git", runtimePluginId);
    const panel = requiredPanel(contributions);
    const backend = backendFixture();

    expect(panel.visible?.(panelContext(backend.request))).toBe(true);
    expect(panel.visible?.(panelContext(backend.request, {
      ...gitWorkspace,
      provider: { pluginId: runtimePluginId, capabilities: { request: true, remove: false } },
    }))).toBe(false);

    const selectMainView = vi.fn<PluginRuntimeContext["selectMainView"]>();
    const action = contributions.actions?.find((candidate) => candidate.id === "view.git");
    await action?.run(runtimeContext({ selectMainView }));
    expect(selectMainView).toHaveBeenCalledWith(`${runtimePluginId}:workspace.git`);
  });

  it("keeps visibility checks free of route side effects", () => {
    window.history.replaceState({}, "", `/?project=${projectId}&workspace=${workspaceId}&core.workspace.git--diff=README.md`);
    const replaceState = vi.spyOn(window.history, "replaceState");
    const panel = requiredPanel(activate("git"));

    expect(panel.visible?.(panelContext(backendFixture().request))).toBe(true);

    expect(replaceState).not.toHaveBeenCalled();
    expect(new URL(window.location.href).searchParams.get("core.workspace.git--diff")).toBe("README.md");
  });

  it("uses the generic panel invalidation hook and reports an actionable error without a paired backend", async () => {
    const panel = requiredPanel(activate("git"));
    const context = panelContext(undefined);
    expect(panel.visible?.(context)).toBe(true);

    await panel.onInvalidate?.(context);
    const container = document.createElement("div");
    render(panel.render(context), container);

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Git workspace backend is unavailable. Update and restart PI WEB on this machine, then reload the browser.",
    );
  });

  it("loads status and diffs through context.backend, preserves URL selection, views, grouping, and rich diff rendering", async () => {
    window.history.replaceState({}, "", `/?project=${projectId}&workspace=${workspaceId}`);
    const backend = backendFixture({
      files: [
        changedFile("src/main.ts"),
        changedFile("vendor/harl", { submoduleFromCommit: "abc1234", submoduleToCommit: "def5678" }),
        changedFile("vendor/harl/lib.ts"),
      ],
      submodules: ["vendor/harl"],
    });
    const panel = requiredPanel(activate("git"));
    const context = panelContext(backend.request);
    expect(panel.visible?.(context)).toBe(true);

    const container = document.createElement("div");
    document.body.append(container);
    render(panel.render(context), container);
    await settleBackend();
    render(panel.render(context), container);

    expect(container.textContent).toContain("main");
    expect(button(container, "src/main.ts")).toBeDefined();
    expect(button(container, "harl").textContent).toContain("submodule");

    button(container, "harl").click();
    render(panel.render(context), container);
    expect(button(container, "abc1234 → def5678")).toBeDefined();
    expect(button(container, "lib.ts")).toBeDefined();

    button(container, "src/main.ts").click();
    expect(new URL(window.location.href).searchParams.get("git.workspace.git--diff")).toBe("src/main.ts");
    await settleBackend();
    render(panel.render(context), container);

    expect(backend.request).toHaveBeenCalledWith("diff", { path: "src/main.ts" });
    expect(backend.request).toHaveBeenCalledWith("diff", { path: "src/main.ts", staged: true });
    expect(container.textContent).toContain("staged");
    expect(container.textContent).toContain("unstaged");
    expect(container.querySelector(".git-panel")).not.toBeNull();
    expect(container.querySelector(".split")).toBeNull();
    const styleRules = (container.querySelector("style")?.textContent ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.includes("{"));
    expect(styleRules).toContainEqual(expect.stringContaining(".git-panel .git-row"));
    expect(styleRules.every((rule) => rule.startsWith(".git-panel"))).toBe(true);
    expect(container.querySelector('[role="table"][aria-label="Unified diff"]')).not.toBeNull();
    expect([...container.querySelectorAll(".inline-change")].map((entry) => entry.textContent)).toContain("new");

    button(container, "Tree").click();
    render(panel.render(context), container);
    expect(window.localStorage.getItem(GIT_FILE_VIEW_STORAGE_KEY)).toBe("tree");
    expect(findButton(container, "src/main.ts")).toBeUndefined();
    button(container, "src").click();
    render(panel.render(context), container);
    expect(button(container, "main.ts")).toBeDefined();

    render(null, container);
  });

  it("preserves a deep link when entering a fresh workspace after route initialization", async () => {
    window.history.replaceState({}, "", `/?project=${projectId}&workspace=${workspaceId}`);
    const panel = requiredPanel(activate("git"));
    const firstBackend = backendFixture();
    const firstContext = panelContext(firstBackend.request);
    const container = document.createElement("div");
    document.body.append(container);
    render(panel.render(firstContext), container);
    await settleBackend();
    render(null, container);

    const secondWorkspace = { ...gitWorkspace, id: "workspace-2" };
    const secondBackend = backendFixture({ files: [changedFile("README.md")] });
    const secondContext = panelContext(secondBackend.request, secondWorkspace);
    window.history.replaceState({}, "", `/?project=${projectId}&workspace=${secondWorkspace.id}&core.workspace.git--diff=README.md`);
    render(panel.render(secondContext), container);
    await settleBackend();

    expect(secondBackend.request).toHaveBeenCalledWith("diff", { path: "README.md" });
    expect(new URL(window.location.href).searchParams.get("git.workspace.git--diff")).toBe("README.md");
    render(null, container);
  });

  it("scopes cached state by machine and evicts old workspaces", async () => {
    const panel = requiredPanel(activate("git"));
    const localBackend = backendFixture({ branch: "local-main" });
    const remoteBackend = backendFixture({ branch: "remote-main" });
    const localContext = panelContext(localBackend.request, gitWorkspace, "local");
    const remoteContext = panelContext(remoteBackend.request, gitWorkspace, "remote-1");

    await panel.onInvalidate?.(localContext);
    await panel.onInvalidate?.(remoteContext);
    const container = document.createElement("div");
    document.body.append(container);
    render(panel.render(localContext), container);
    expect(container.textContent).toContain("local-main");
    render(panel.render(remoteContext), container);
    expect(container.textContent).toContain("remote-main");

    const oldestBackend = backendFixture({ branch: "oldest" });
    const oldestContext = panelContext(oldestBackend.request, { ...gitWorkspace, id: "bounded-0" });
    await panel.onInvalidate?.(oldestContext);
    // Traverse well beyond the intentionally small workspace-state cache.
    for (let index = 1; index <= 16; index += 1) {
      const backend = backendFixture({ branch: `bounded-${String(index)}` });
      await panel.onInvalidate?.(panelContext(backend.request, { ...gitWorkspace, id: `bounded-${String(index)}` }));
    }

    render(panel.render(oldestContext), container);
    await settleBackend();
    expect(oldestBackend.request.mock.calls.filter(([operation]) => operation === "status")).toHaveLength(2);
    render(null, container);
  });

  it("restores deep-linked selections, clears removed files, and polls only while mounted", async () => {
    vi.useFakeTimers();
    window.history.replaceState({}, "", `/?project=${projectId}&workspace=${workspaceId}&core.workspace.git--diff=README.md`);
    const backend = backendFixture({ files: [changedFile("README.md")] });
    const panel = requiredPanel(activate("git"));
    const context = panelContext(backend.request);
    panel.visible?.(context);
    const container = document.createElement("div");
    document.body.append(container);
    render(panel.render(context), container);
    await settleBackend();
    render(panel.render(context), container);

    expect(backend.request).toHaveBeenCalledWith("diff", { path: "README.md" });
    expect(new URL(window.location.href).searchParams.get("git.workspace.git--diff")).toBe("README.md");
    expect(new URL(window.location.href).searchParams.has("core.workspace.git--diff")).toBe(false);

    const statusCallsBeforePoll = backend.request.mock.calls.filter(([operation]) => operation === "status").length;
    await vi.advanceTimersByTimeAsync(8_000);
    await settleBackend();
    expect(backend.request.mock.calls.filter(([operation]) => operation === "status")).toHaveLength(statusCallsBeforePoll + 1);

    backend.status.files = [];
    await vi.advanceTimersByTimeAsync(8_000);
    await settleBackend();
    expect(new URL(window.location.href).searchParams.has("git.workspace.git--diff")).toBe(false);

    render(null, container);
    const callsAfterDisconnect = backend.request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(8_000);
    expect(backend.request).toHaveBeenCalledTimes(callsAfterDisconnect);
  });
});

describe("git tab review comments", () => {
  it("shows the shared session total as the tab badge, or nothing when zero", () => {
    const panel = requiredPanel(activate("git"));
    expect(panel.badge?.(panelContext(undefined, gitWorkspace, "local", { total: () => 0 }))).toBeUndefined();
    expect(panel.badge?.(panelContext(undefined, gitWorkspace, "local", { total: () => 3 }))).toBe(3);
  });

  it("shows a per-file comment-count badge in the file list", async () => {
    const panel = requiredPanel(activate("git"));
    const backend = backendFixture();
    const countForFile = vi.fn((path: string) => (path === "src/main.ts" ? 2 : 0));
    const context = panelContext(backend.request, gitWorkspace, "local", { countForFile });
    const container = document.createElement("div");
    document.body.append(container);
    render(panel.render(context), container);
    await settleBackend();
    render(panel.render(context), container);

    const badge = button(container, "src/main.ts").querySelector(".review-badge");
    expect(badge?.textContent).toBe("2");
    expect(countForFile).toHaveBeenCalledWith("src/main.ts");
  });

  it("maps add/context/remove diff rows to review refs and styles them from lineState", async () => {
    const panel = requiredPanel(activate("git"));
    const backend = backendFixture();
    const lineState = vi.fn((_path: string, ref: { side: "old" | "new"; line: number }) =>
      ref.side === "new" && ref.line === 1 ? { selected: true, commented: false } : { selected: false, commented: true });
    const context = panelContext(backend.request, gitWorkspace, "local", { lineState });
    const container = document.createElement("div");
    document.body.append(container);
    render(panel.render(context), container);
    await settleBackend();
    render(panel.render(context), container);
    button(container, "src/main.ts").click();
    render(panel.render(context), container);
    await settleBackend();
    render(panel.render(context), container);

    const addRow = container.querySelector(".git-diff-cell.git-line-number.add")?.closest(".git-diff-line");
    const removeRow = container.querySelector(".git-diff-cell.git-line-number.remove")?.closest(".git-diff-line");
    expect(addRow?.classList.contains("is-review-selected")).toBe(true);
    expect(removeRow?.classList.contains("has-review")).toBe(true);
  });

  it("wires mousedown/mousemove/mouseup on line-number cells to the selection state machine, including a plain click", async () => {
    const panel = requiredPanel(activate("git"));
    const backend = backendFixture();
    const beginSelection = vi.fn();
    const extendSelection = vi.fn();
    const commitSelection = vi.fn();
    const context = panelContext(backend.request, gitWorkspace, "local", { beginSelection, extendSelection, commitSelection });
    const container = document.createElement("div");
    document.body.append(container);
    render(panel.render(context), container);
    await settleBackend();
    render(panel.render(context), container);
    button(container, "src/main.ts").click();
    render(panel.render(context), container);
    await settleBackend();
    render(panel.render(context), container);

    const addCell = container.querySelector(".git-diff-cell.git-line-number.add");
    if (addCell === null) throw new Error("Expected an added-line cell");
    addCell.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true }));
    addCell.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

    expect(beginSelection).toHaveBeenCalledWith("src/main.ts", { side: "new", line: 1 });
    expect(extendSelection).toHaveBeenCalledWith({ side: "new", line: 1 });
    expect(commitSelection).toHaveBeenCalledTimes(1);

    const removeCell = container.querySelector(".git-diff-cell.git-line-number.remove");
    if (removeCell === null) throw new Error("Expected a removed-line cell");
    beginSelection.mockClear();
    extendSelection.mockClear();
    removeCell.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true }));
    removeCell.dispatchEvent(new MouseEvent("mousemove", { buttons: 1, bubbles: true }));
    removeCell.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

    expect(beginSelection).toHaveBeenCalledWith("src/main.ts", { side: "old", line: 1 });
    expect(extendSelection).toHaveBeenCalledWith({ side: "old", line: 1 });
  });

  it("ignores gestures on rows with no line, e.g. hunk headers", async () => {
    const panel = requiredPanel(activate("git"));
    const backend = backendFixture();
    const beginSelection = vi.fn();
    const context = panelContext(backend.request, gitWorkspace, "local", { beginSelection });
    const container = document.createElement("div");
    document.body.append(container);
    render(panel.render(context), container);
    await settleBackend();
    render(panel.render(context), container);
    button(container, "src/main.ts").click();
    render(panel.render(context), container);
    await settleBackend();
    render(panel.render(context), container);

    const hunkCell = container.querySelector(".git-diff-cell.git-line-number.hunk");
    if (hunkCell === null) throw new Error("Expected a hunk-header cell");
    hunkCell.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true }));
    hunkCell.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

    expect(beginSelection).not.toHaveBeenCalled();
  });

  it("mounts an inline review thread only for lines with comments or a draft, wired to the shared callbacks", async () => {
    const panel = requiredPanel(activate("git"));
    const backend = backendFixture();
    const comment = { id: "c1", anchor: { filePath: "src/main.ts", range: { side: "new" as const, start: 1, end: 1 } }, body: "hi", createdAt: 0, updatedAt: 0, sourceHash: "h" };
    const commentsForLine = vi.fn((_path: string, ref: { side: "old" | "new"; line: number }) =>
      ref.side === "new" && ref.line === 1 ? [comment] : []);
    const updateComment = vi.fn();
    const removeComment = vi.fn();
    const setDraftBody = vi.fn();
    const submitDraft = vi.fn();
    const cancelDraft = vi.fn();
    const context = panelContext(backend.request, gitWorkspace, "local", { commentsForLine, updateComment, removeComment, setDraftBody, submitDraft, cancelDraft });
    const container = document.createElement("div");
    document.body.append(container);
    render(panel.render(context), container);
    await settleBackend();
    render(panel.render(context), container);
    button(container, "src/main.ts").click();
    render(panel.render(context), container);
    await settleBackend();
    render(panel.render(context), container);

    // Both the staged and unstaged diff sections have a `new`-side line 1
    // (see `backendFixture`'s fixed diff text), so both mount a thread.
    const threads = [...container.querySelectorAll<ReviewThreadTestElement>("pi-web-review-thread")];
    expect(threads).toHaveLength(2);
    const thread = threads[0];
    if (thread === undefined) throw new Error("Expected a mounted review thread");
    expect(thread.comments).toEqual([comment]);

    thread.onUpdate?.("c1", "edited", comment.anchor);
    expect(updateComment).toHaveBeenCalledWith("c1", "edited", comment.anchor);
    thread.onRemove?.("c1");
    expect(removeComment).toHaveBeenCalledWith("c1");
    thread.onSubmitDraft?.("new body", comment.anchor);
    expect(setDraftBody).toHaveBeenCalledWith("new body");
    expect(submitDraft).toHaveBeenCalledWith(comment.anchor);
    thread.onCancelDraft?.();
    expect(cancelDraft).toHaveBeenCalledTimes(1);
  });

  it("mounts exactly one review thread for a multi-line comment/draft, at the range's last line", async () => {
    const panel = requiredPanel(activate("git"));
    // 3 added lines (new-side lines 1-3) in the unstaged diff, so a comment or
    // draft spanning all three must not mount a thread at every row.
    const backend = backendFixture({
      diffText: "@@ -0,0 +1,3 @@\n+new1\n+new2\n+new3",
    });
    const rangeComment = { id: "c1", anchor: { filePath: "src/main.ts", range: { side: "new" as const, start: 1, end: 3 } }, body: "spans three lines", createdAt: 0, updatedAt: 0, sourceHash: "h" };
    const commentsForLine = vi.fn((_path: string, ref: { side: "old" | "new"; line: number }) =>
      ref.side === "new" && ref.line >= 1 && ref.line <= 3 ? [rangeComment] : []);
    const context = panelContext(backend.request, gitWorkspace, "local", { commentsForLine });
    const container = document.createElement("div");
    document.body.append(container);
    render(panel.render(context), container);
    await settleBackend();
    render(panel.render(context), container);
    button(container, "src/main.ts").click();
    render(panel.render(context), container);
    await settleBackend();
    render(panel.render(context), container);

    // Only the unstaged section has this diff text (the staged section keeps
    // the default single-line diff and has no matching `new`-side lines 1-3
    // range end), so exactly one thread should mount across the whole panel.
    const threads = [...container.querySelectorAll<ReviewThreadTestElement>("pi-web-review-thread")];
    expect(threads).toHaveLength(1);
    expect(threads[0]?.comments).toEqual([rangeComment]);

    // It must be anchored at the row for new-side line 3 (the range's last
    // line), not line 1 or 2.
    const addRows = [...container.querySelectorAll(".git-diff-cell.git-line-number.add")].map((cell) => cell.closest(".git-diff-line"));
    const lastAddRow = addRows.at(-1);
    expect(lastAddRow?.nextElementSibling?.tagName.toLowerCase()).toBe("pi-web-review-thread");
  });

  it("draft-open range shows a `has-review` highlight on every line, not only the anchor line", async () => {
    const panel = requiredPanel(activate("git"));
    const draft = { anchor: { filePath: "src/main.ts", range: { side: "new" as const, start: 1, end: 1 } }, body: "" };
    const lineState = vi.fn((_path: string, ref: { side: "old" | "new"; line: number }) =>
      ref.side === "new" && ref.line === 1 ? { selected: false, commented: true } : { selected: false, commented: false });
    const context = panelContext(backendFixture().request, gitWorkspace, "local", { lineState, draftForLine: () => draft });
    const container = document.createElement("div");
    document.body.append(container);
    render(panel.render(context), container);
    await settleBackend();
    render(panel.render(context), container);
    button(container, "src/main.ts").click();
    render(panel.render(context), container);
    await settleBackend();
    render(panel.render(context), container);

    const addRow = container.querySelector(".git-diff-cell.git-line-number.add")?.closest(".git-diff-line");
    expect(addRow?.classList.contains("has-review")).toBe(true);
  });

  it("marks only reviewable line-number cells with is-reviewable (context/add/remove, not meta/hunk/marker)", async () => {
    const panel = requiredPanel(activate("git"));
    const backend = backendFixture();
    const context = panelContext(backend.request, gitWorkspace, "local");
    const container = document.createElement("div");
    document.body.append(container);
    render(panel.render(context), container);
    await settleBackend();
    render(panel.render(context), container);
    button(container, "src/main.ts").click();
    render(panel.render(context), container);
    await settleBackend();
    render(panel.render(context), container);

    const addCell = container.querySelector(".git-diff-cell.git-line-number.add");
    const removeCell = container.querySelector(".git-diff-cell.git-line-number.remove");
    const hunkCell = container.querySelector(".git-diff-cell.git-line-number.hunk");
    expect(addCell?.classList.contains("is-reviewable")).toBe(true);
    expect(removeCell?.classList.contains("is-reviewable")).toBe(true);
    expect(hunkCell?.classList.contains("is-reviewable")).toBe(false);

    // Both number cells of a context/add/remove row share the same handlers
    // wired to that row's single `ref` (see `reviewCellHandlers`), so both
    // cells of a reviewable row carry the class -- including the blank
    // "wrong side" cell (e.g. the old-number cell of an added line).
    const addRow = addCell?.closest(".git-diff-line");
    const numberCellsInAddRow = [...(addRow?.querySelectorAll(".git-line-number") ?? [])];
    expect(numberCellsInAddRow.every((cell) => cell.classList.contains("is-reviewable"))).toBe(true);
  });

  it("styles is-reviewable line-number cells with a hover affordance", () => {
    const panel = requiredPanel(activate("git"));
    const container = document.createElement("div");
    document.body.append(container);
    render(panel.render(panelContext(undefined)), container);

    const css = container.querySelector("style")?.textContent ?? "";
    expect(css).toContain(".git-line-number.is-reviewable:hover");
  });

  it("caps the review thread row's width to the diff scroller's visible width instead of the (potentially much wider) intrinsic diff-grid content width", () => {
    const panel = requiredPanel(activate("git"));
    const container = document.createElement("div");
    document.body.append(container);
    render(panel.render(panelContext(undefined)), container);

    const css = container.querySelector("style")?.textContent ?? "";
    // NOTE: unlike the Files tab's CM6 widget (a plain block-flow child, see
    // `reviewWidgetHostStyle`'s doc comment), `.git-review-thread` is a CSS
    // GRID item (`grid-column: 1 / -1` inside `.git-diff-grid`). For a grid
    // item, `justify-self: stretch` (the default) already determines its
    // width during grid track sizing -- to the grid's own `max-content`
    // track width, which is exactly the diff content's full (potentially
    // viewport-exceeding) width -- BEFORE `position: sticky`'s offsets are
    // even considered. Setting both `left: 0` and `right: 0` with no
    // explicit width (the Files-tab pattern) does NOT shrink a grid item's
    // already-stretched width the way it does a plain block box; live
    // verification confirmed the sticky offset doesn't even engage on
    // horizontal scroll in that configuration. `width: 100cqw` (against
    // `.git-diff-scroller`'s `container-type: inline-size`) explicitly caps
    // the width to the visible viewport instead, which does work correctly
    // here (confirmed live, at any scroll offset).
    expect(css).toContain(".git-diff-scroller");
    expect(css).toMatch(/\.git-diff-scroller\s*\{[^}]*container-type:\s*inline-size/);
    expect(css).toMatch(/\.git-review-thread\s*\{[^}]*width:\s*100cqw/);
    expect(css).toMatch(/\.git-review-thread\s*\{[^}]*position:\s*sticky/);
  });
});

interface ReviewThreadTestElement extends HTMLElement {
  comments?: unknown;
  onUpdate?: (id: string, body: string, anchor: unknown) => void;
  onRemove?: (id: string) => void;
  onSubmitDraft?: (body: string, anchor: unknown) => void;
  onCancelDraft?: () => void;
}

function activate(pluginId: string, runtimePluginId = pluginId) {
  return plugin.activate({ apiVersion: 2, pluginId, runtimePluginId, html, svg }).contributions;
}

function requiredPanel(contributions: ReturnType<typeof activate>) {
  const panel = contributions.workspacePanels?.[0];
  if (panel === undefined) throw new Error("Expected Git workspace panel");
  return panel;
}

function backendFixture(patch: { files?: ReturnType<typeof changedFile>[]; submodules?: string[]; branch?: string; diffText?: string } = {}) {
  const status = {
    isGitRepo: true,
    hash: `status-hash-${patch.branch ?? "main"}`,
    branch: patch.branch ?? "main",
    files: patch.files ?? [changedFile("src/main.ts")],
    submodules: patch.submodules ?? [],
  };
  const request = vi.fn((operation: string, input: JsonValue): Promise<JsonValue> => {
    if (operation === "status") return Promise.resolve({
      ...status,
      hash: `${status.hash}:${JSON.stringify(status.files)}`,
      files: [...status.files],
      submodules: [...status.submodules],
    });
    const staged = isRecord(input) && input["staged"] === true;
    const path = isRecord(input) && typeof input["path"] === "string" ? input["path"] : "diff";
    return Promise.resolve({
      path,
      staged,
      hash: staged ? "staged-hash" : "unstaged-hash",
      diff: staged ? "@@ -1 +1 @@\n-old value\n+new value" : (patch.diffText ?? "@@ -1 +1 @@\n-old work\n+new work"),
      truncated: false,
    });
  });
  return { request, status };
}

function changedFile(path: string, patch: Record<string, JsonValue> = {}) {
  return { path, index: "unmodified", workingTree: "modified", ...patch };
}

function panelContext(request: WorkspaceBackend["request"] | undefined, workspace = gitWorkspace, machineId = "local", reviewPatch: Partial<WorkspacePanelContext["review"]> = {}): WorkspacePanelContext {
  const noop = () => undefined;
  return {
    machine: { id: machineId, name: machineId, kind: machineId === "local" ? "local" : "remote" },
    workspace,
    state: { selectedWorkspace: workspace, workspaceTool: "git:workspace.git", mainView: "git:workspace.git" },
    files: {
      readFile: () => Promise.reject(new Error("not implemented")),
      listFiles: () => Promise.reject(new Error("not implemented")),
      writeFile: () => Promise.reject(new Error("not implemented")),
      deleteFile: () => Promise.reject(new Error("not implemented")),
      moveFile: () => Promise.reject(new Error("not implemented")),
    },
    ...(request === undefined ? {} : { backend: { request } }),
    host: { requestRender: noop },
    prompt: { insertText: noop, getText: () => "", getSelection: () => null },
    terminal: { open: noop, runCommand: () => Promise.reject(new Error("not implemented")) },
    review: {
      total: () => 0,
      countForFile: () => 0,
      commentsForLine: () => [],
      draftForLine: () => null,
      lineState: () => ({ selected: false, commented: false }),
      canAuthor: () => true,
      beginSelection: noop,
      extendSelection: noop,
      commitSelection: noop,
      cancelSelection: noop,
      setDraftBody: noop,
      submitDraft: noop,
      cancelDraft: noop,
      updateComment: noop,
      removeComment: noop,
      ...reviewPatch,
    },
  };
}

function runtimeContext(patch: Partial<PluginRuntimeContext> = {}): PluginRuntimeContext {
  const noop = () => undefined;
  return {
    state: { selectedWorkspace: gitWorkspace, workspaceTool: "git:workspace.git", mainView: "git:workspace.git" },
    prompt: { insertText: noop, getText: () => "", getSelection: () => null },
    openActionPalette: noop,
    focusPrompt: noop,
    addProject: noop,
    configureAuth: noop,
    logoutAuth: noop,
    openThemePicker: noop,
    selectMainView: noop,
    selectWorkspaceTool: noop,
    openTerminal: noop,
    refreshFiles: noop,
    refreshWorkspacePanels: noop,
    refreshAppData: noop,
    reloadPage: noop,
    startSession: noop,
    archiveSession: noop,
    stopActiveWork: noop,
    ...patch,
  };
}

function button(container: ParentNode, text: string): HTMLButtonElement {
  const found = findButton(container, text);
  if (found === undefined) throw new Error(`Expected button ${text}; rendered text: ${container.textContent ?? ""}`);
  return found;
}

function findButton(container: ParentNode, text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((candidate) => candidate.textContent.trim().includes(text));
}

async function settleBackend(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

function isRecord(value: JsonValue): value is Readonly<Record<string, JsonValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
