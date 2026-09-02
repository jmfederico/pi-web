// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import type { WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import { createGitDiffRoute } from "./browser/gitRoute.js";

afterEach(() => {
  window.history.replaceState({}, "", "/");
});

describe("Git selected-diff route", () => {
  it("keeps nested deployment paths and unrelated route fields while encoding the plugin namespace", () => {
    window.history.replaceState({}, "", "/test/ai/?machine=remote-1&project=project%2Fone&workspace=workspace+one&session=s1#panel");
    const route = createGitDiffRoute("machine.remote-1.git:workspace.git");
    const context = panelContext("remote-1", "project/one", "workspace one");

    expect(route.matches(context)).toBe(true);
    route.write("src/a file.ts");

    const url = new URL(window.location.href);
    expect(`${url.pathname}${url.hash}`).toBe("/test/ai/#panel");
    expect(url.searchParams.get("machine")).toBe("remote-1");
    expect(url.searchParams.get("session")).toBe("s1");
    expect(url.searchParams.get("machine.remote-1.git.workspace.git--diff")).toBe("src/a file.ts");
    expect(route.read()).toBe("src/a file.ts");
  });

  it("reads the former core namespace so the plugin can migrate existing deep links", () => {
    window.history.replaceState({}, "", "/?project=p1&workspace=w1&core.workspace.git--diff=README.md");

    expect(createGitDiffRoute("git:workspace.git").read()).toBe("README.md");
  });
});

function panelContext(machineId: string, projectId: string, workspaceId: string): WorkspacePanelContext {
  const noop = () => undefined;
  return {
    machine: { id: machineId, name: machineId, kind: machineId === "local" ? "local" : "remote" },
    workspace: { id: workspaceId, projectId, path: "/repo", label: "main", isMain: true },
    files: {
      readFile: () => Promise.reject(new Error("not implemented")),
      listFiles: () => Promise.reject(new Error("not implemented")),
      writeFile: () => Promise.reject(new Error("not implemented")),
      deleteFile: () => Promise.reject(new Error("not implemented")),
      moveFile: () => Promise.reject(new Error("not implemented")),
    },
    backend: { request: () => Promise.reject(new Error("not implemented")) },
    host: { requestRender: noop },
    prompt: { insertText: noop, getText: () => "", getSelection: () => null },
    terminal: { open: noop, runCommand: () => Promise.reject(new Error("not implemented")) },
    review: {
      total: () => 0,
      countForFile: () => 0,
      commentsForLine: () => [],
      draftForLine: () => null,
      lineState: () => ({ selected: false, commented: false }),
      canAuthor: () => false,
      beginSelection: noop,
      extendSelection: noop,
      commitSelection: noop,
      cancelSelection: noop,
      setDraftBody: noop,
      submitDraft: noop,
      cancelDraft: noop,
      updateComment: noop,
      removeComment: noop,
    },
  };
}
