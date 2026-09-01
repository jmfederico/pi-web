import { describe, expect, it } from "vitest";
import {
  WORKSPACE_CREATION_NAME_MAX_LENGTH,
  parseWorkspaceCreationRequest,
  requireWorkspaceCreationName,
  requireWorkspaceCreationParentPath,
  workspaceCreationMetadata,
} from "./workspaceCreation.js";

const nul = String.fromCharCode(0);

describe("parseWorkspaceCreationRequest", () => {
  it("trims the parent path and name", () => {
    expect(parseWorkspaceCreationRequest({ parentPath: " /work ", name: " My Feature " }))
      .toEqual({ parentPath: "/work", name: "My Feature" });
  });

  it("rejects non-object bodies", () => {
    expect(() => parseWorkspaceCreationRequest("nope")).toThrow(/must be an object/u);
  });
});

describe("requireWorkspaceCreationName", () => {
  it("keeps spaces, which providers slugify as they see fit", () => {
    expect(requireWorkspaceCreationName(" My Feature ")).toBe("My Feature");
  });

  it.each([
    ["", /non-empty/u],
    ["   ", /non-empty/u],
    ["x".repeat(WORKSPACE_CREATION_NAME_MAX_LENGTH + 1), /non-empty/u],
    [".", /relative path segment/u],
    ["..", /relative path segment/u],
    ["feat/one", /path separators/u],
    ["feat\\one", /path separators/u],
    [`feat${nul}one`, /path separators/u],
  ])("rejects %j", (name, message) => {
    expect(() => requireWorkspaceCreationName(name)).toThrow(message);
  });

  it("rejects non-strings", () => {
    expect(() => requireWorkspaceCreationName(7)).toThrow(/must be a string/u);
  });
});

describe("requireWorkspaceCreationParentPath", () => {
  it("accepts an absolute path", () => {
    expect(requireWorkspaceCreationParentPath("/work/projects")).toBe("/work/projects");
  });

  it.each([
    ["", /non-empty/u],
    ["work/projects", /must be absolute/u],
    [`/work${nul}/projects`, /must not contain NUL/u],
  ])("rejects %j", (path, message) => {
    expect(() => requireWorkspaceCreationParentPath(path)).toThrow(message);
  });
});

describe("workspaceCreationMetadata", () => {
  it("tags the run so clients can recognise a creation command", () => {
    expect(workspaceCreationMetadata("My Feature")).toEqual({
      "pi.operation": "workspace.create",
      "created.workspaceName": "My Feature",
    });
  });
});
