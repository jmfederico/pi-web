import { describe, expect, it } from "vitest";
import { workspaceIdFor } from "./workspaceIdentity";

describe("workspaceIdFor", () => {
  it("matches the golden ids produced by the workspace provider registry formula", () => {
    // Golden vectors pin the formula: changing it silently breaks deep links in stored payloads.
    expect(workspaceIdFor("a707eb96-4455-433c-b07c-577116b83f08", "/data/bernhard")).toBe("8ba4949d12d1");
    expect(workspaceIdFor("p1", "/repo")).toMatchInlineSnapshot('"614f8cf01cd6"');
  });

  it("is stable across calls and distinguishes project and key", () => {
    expect(workspaceIdFor("p1", "/repo")).toBe(workspaceIdFor("p1", "/repo"));
    expect(workspaceIdFor("p1", "/repo")).not.toBe(workspaceIdFor("p2", "/repo"));
    expect(workspaceIdFor("p1", "/repo")).not.toBe(workspaceIdFor("p1", "/repo-2"));
  });
});
