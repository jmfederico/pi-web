import { describe, expect, it } from "vitest";
import type { Workspace } from "../api";
import type { JsonValue } from "../../../shared/pluginApiTypes";
import { providerNavigation } from "./providerNavigation";

describe("providerNavigation", () => {
  it("reads the two keys the host acts on", () => {
    expect(providerNavigation(workspace({ hideProjects: true, workspacesTitle: "Cases" }))).toEqual({
      hideProjects: true,
      workspacesTitle: "Cases",
    });
  });

  it("keeps the project section for a workspace with no provider navigation", () => {
    expect(providerNavigation(undefined)).toEqual({ hideProjects: false });
    expect(providerNavigation(workspace(undefined))).toEqual({ hideProjects: false });
    expect(providerNavigation({ id: "ws", projectId: "p", path: "/repo", label: "main", isMain: true, effectiveConfig: {} })).toEqual({ hideProjects: false });
  });

  it("ignores values of the wrong shape instead of trusting provider metadata", () => {
    expect(providerNavigation(workspace("hidden"))).toEqual({ hideProjects: false });
    expect(providerNavigation(workspace(["hidden"]))).toEqual({ hideProjects: false });
    expect(providerNavigation(workspace({ hideProjects: "yes" }))).toEqual({ hideProjects: false });
    expect(providerNavigation(workspace({ hideProjects: true, workspacesTitle: 42 }))).toEqual({ hideProjects: true });
  });

  it("drops a blank title so the section keeps its own name", () => {
    expect(providerNavigation(workspace({ workspacesTitle: "   " }))).toEqual({ hideProjects: false });
    expect(providerNavigation(workspace({ workspacesTitle: "  Cases  " }))).toEqual({ hideProjects: false, workspacesTitle: "Cases" });
  });
});

function workspace(navigation: JsonValue | undefined): Workspace {
  return {
    id: "ws",
    projectId: "p",
    path: "/repo",
    label: "main",
    isMain: true,
    effectiveConfig: {},
    provider: {
      pluginId: "modes",
      capabilities: { request: true, remove: false },
      ...(navigation === undefined ? {} : { metadata: { navigation } }),
    },
  };
}
