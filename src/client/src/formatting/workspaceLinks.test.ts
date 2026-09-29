import { describe, expect, it } from "vitest";
import { workspaceMarkdownFilePath } from "./workspaceLinks";

const workspace = { machineId: "local", projectId: "p", workspaceId: "w", root: "/work" };

describe("workspace Markdown path normalization", () => {
  it.each([".", "./", "././", "/work/./", "%2E/%2E"])("does not classify workspace-root reference %s as a file", (href) => {
    expect(workspaceMarkdownFilePath(href, workspace)).toBeUndefined();
  });

  it.each(["../secret", "./dir/../secret", "dir/%2E%2E/secret", "/work/dir/../secret"])("preserves traversal in %s for server rejection", (href) => {
    expect(workspaceMarkdownFilePath(href, workspace)?.split("/")).toContain("..");
  });

  it.each(["https://example.com/./file", "//example.com/./file", "mailto:a@example.com", "javascript:alert(1)", "#section", "?query", "/elsewhere/./file", "/work-other/file", "bad%ZZ", "dir%5Cfile", "file%00.txt"])("does not normalize excluded reference %s into a workspace file", (href) => {
    expect(workspaceMarkdownFilePath(href, workspace)).toBeUndefined();
  });

  it("decodes only once and preserves meaningful filename characters", () => {
    expect(workspaceMarkdownFilePath("./.hidden//%252E%252E/a%20%23%3F%25.txt", workspace)).toBe(".hidden/%2E%2E/a #?%.txt");
  });
});
