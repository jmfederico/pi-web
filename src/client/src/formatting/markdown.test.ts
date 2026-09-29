// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { marked } from "marked";
import { toSafeMarkdownHtml } from "./markdown";
import { markdownWorkspaceContext, type MarkdownWorkspaceContext } from "./workspaceLinks";

const workspace: MarkdownWorkspaceContext = { machineId: "remote /1", projectId: "project /1", workspaceId: "work /1", root: "/srv/work" };

function render(text: string, context?: MarkdownWorkspaceContext): HTMLDivElement {
  const div = document.createElement("div");
  div.innerHTML = toSafeMarkdownHtml(text, context);
  return div;
}

function link(text: string, context?: MarkdownWorkspaceContext): HTMLAnchorElement {
  const anchor = render(text, context).querySelector("a");
  if (anchor === null) throw new Error("Expected a Markdown link");
  return anchor;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  document.body.replaceChildren();
  window.history.replaceState(null, "", "/");
});

describe("final Markdown HTML cache", () => {
  it("reuses sanitized HTML without parsing or rebuilding DOM, including across route query changes", () => {
    vi.stubEnv("BASE_URL", "./");
    window.history.replaceState(null, "", "/nested/pi/?view=chat");
    const parse = vi.spyOn(marked, "parse");
    const createElement = vi.spyOn(document, "createElement");
    const text = "[cache reuse](./cached.txt)\n\n| A |\n| - |\n| B |";
    const first = toSafeMarkdownHtml(text, workspace);
    expect(first).toContain('data-workspace-file="cached.txt"');
    expect(first).toContain('class="table-scroll"');
    parse.mockClear();
    createElement.mockClear();
    window.history.replaceState(null, "", "/nested/pi/?view=workspace");
    expect(toSafeMarkdownHtml(text, { ...workspace })).toBe(first);
    expect(parse).not.toHaveBeenCalled();
    expect(createElement).not.toHaveBeenCalled();
  });

  it("isolates effective application bases and ignores the base for context-free HTML", () => {
    vi.stubEnv("BASE_URL", "./");
    const text = "[base isolation](cached.txt)";
    window.history.replaceState(null, "", "/first/");
    expect(toSafeMarkdownHtml(text, workspace)).toContain("/first/api/");
    window.history.replaceState(null, "", "/second/");
    expect(toSafeMarkdownHtml(text, workspace)).toContain("/second/api/");
    vi.stubEnv("BASE_URL", "/fixed/");
    expect(toSafeMarkdownHtml(text, workspace)).toContain("/fixed/api/");

    const plain = toSafeMarkdownHtml(text);
    const parse = vi.spyOn(marked, "parse");
    vi.stubEnv("BASE_URL", "/elsewhere/");
    expect(toSafeMarkdownHtml(text)).toBe(plain);
    expect(parse).not.toHaveBeenCalled();
  });

  it("evicts old entries rather than growing without bound", () => {
    const text = "cache eviction sentinel";
    toSafeMarkdownHtml(text);
    for (let index = 0; index < 300; index++) toSafeMarkdownHtml(`cache eviction ${String(index)}`);
    const parse = vi.spyOn(marked, "parse");
    toSafeMarkdownHtml(text);
    expect(parse).toHaveBeenCalledOnce();
  });
});

describe("workspace Markdown downloads", () => {
  it.each([
    ["reports/result.zip", "reports/result.zip"],
    ["./reports/result.zip", "reports/result.zip"],
    ["././reports//./result.zip", "reports/result.zip"],
    ["/srv/work/./reports//result.zip", "reports/result.zip"],
    ["%2E/reports/%2E/result.zip", "reports/result.zip"],
    ["reports/../result.zip", "reports/../result.zip"],
    ["../outside.zip", "../outside.zip"],
    ["/srv/work/reports/result.zip", "reports/result.zip"],
    ["reports/a%20%231%3F%25.zip", "reports/a #1?%.zip"],
    ["report.pdf?version=2#page=3", "report.pdf"],
  ])("routes %s through the existing download endpoint", (destination, path) => {
    vi.stubEnv("BASE_URL", "/nested/pi/");
    const anchor = link(`[download](${destination})`, workspace);
    expect(anchor.getAttribute("data-workspace-file")).toBe(path);
    const url = new URL(anchor.href);
    expect(url.pathname).toBe("/nested/pi/api/machines/remote%20%2F1/projects/project%20%2F1/workspaces/work%20%2F1/file/preview");
    expect(url.searchParams.get("path")).toBe(path);
    expect(url.searchParams.get("download")).toBe("1");
  });

  it.each(["https://example.com/file", "http://example.com", "mailto:hello@example.com", "#section", "/api/status", "/srv/work-other/file", "//example.com/file"])("preserves browser link %s", (destination) => {
    const anchor = link(`[link](${destination})`, workspace);
    expect(anchor.getAttribute("href")).toBe(destination);
    expect(anchor.rel).toBe("noreferrer noopener");
  });

  it("does not share resolved links between workspaces, machines or context-free consumers", () => {
    const text = "[download](result.zip)";
    const first = link(text, workspace).href;
    for (const field of ["machineId", "projectId", "workspaceId"] as const) {
      const second = link(text, { ...workspace, [field]: "different" }).href;
      expect(second).not.toBe(first);
      expect(second).toContain("/different/");
    }
    expect(link(text).hasAttribute("href")).toBe(false);
    expect(link(text, workspace).href).toBe(first);
    const absolute = "[download](/srv/work/result.zip)";
    expect(link(absolute, workspace).href).toContain("download=1");
    expect(link(absolute, { ...workspace, root: "/another" }).getAttribute("href")).toBe("/srv/work/result.zip");
  });

  it("keeps unsafe schemes, images and literal HTML out of download resolution", () => {
    const result = render('[bad](javascript:alert%281%29) [bad](data:text/plain,hi) ![image](report.png) <a href="report.zip">raw</a>', workspace);
    expect([...result.querySelectorAll("a")].every((a) => !a.hasAttribute("href"))).toBe(true);
    expect(result.querySelector("pi-web-markdown-image")?.getAttribute("path")).toBe("report.png");
    expect(result.textContent).toContain('<a href="report.zip">raw</a>');
    expect(link("[bad](bad%ZZ.zip)", workspace).hasAttribute("href")).toBe(false);
  });

  it("only assigns context for the session's workspace", () => {
    const selected = { id: "w", projectId: "p", path: "/srv/work/", label: "work", isMain: true, effectiveConfig: { uploads: {}, attachments: {} } };
    // Only identity and path participate in context selection.
    expect(markdownWorkspaceContext("remote", undefined, { id: "s", cwd: "/srv/work" })).toBeUndefined();
    expect(markdownWorkspaceContext("remote", selected, { id: "s", cwd: "/different" })).toBeUndefined();
    expect(markdownWorkspaceContext("remote", selected, { id: "s", cwd: "/srv/work" })).toEqual({ machineId: "remote", projectId: "p", workspaceId: "w", root: "/srv/work/" });
  });
});
