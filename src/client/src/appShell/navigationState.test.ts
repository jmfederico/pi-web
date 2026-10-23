import { describe, expect, it } from "vitest";
import { defaultNavigationSection, expandedNavigationSection, isNavigationSectionCollapsed, toggleCollapsedNavigationSection, toggleNavigationSection } from "./navigationState";

describe("navigationState", () => {
  it("defaults to the first incomplete selection section", () => {
    expect(defaultNavigationSection({ selectedProject: undefined, selectedWorkspace: undefined })).toBe("projects");
    expect(defaultNavigationSection({ selectedProject: {}, selectedWorkspace: undefined })).toBe("workspaces");
    expect(defaultNavigationSection({ selectedProject: {}, selectedWorkspace: {} })).toBe("sessions");
  });

  it("expands the default section until the user explicitly toggles a section", () => {
    const state = { selectedProject: {}, selectedWorkspace: undefined };

    expect(expandedNavigationSection(undefined, state)).toBe("workspaces");
    expect(expandedNavigationSection("sessions", state)).toBe("sessions");
    expect(expandedNavigationSection("none", state)).toBeUndefined();
  });

  it("keeps sessions expanded when a pending workspace section resolves to a folder", () => {
    const state = { selectedProject: {}, selectedWorkspace: {}, workspaceSelectionVisible: false };
    expect(expandedNavigationSection("workspaces", state)).toBe("sessions");
    expect(defaultNavigationSection({ ...state, selectedWorkspace: undefined })).toBe("sessions");
    expect(isNavigationSectionCollapsed("sessions", { isMobileLayout: true, expanded: "workspaces", state })).toBe(false);
    expect(expandedNavigationSection("projects", state)).toBe("projects");
    expect(expandedNavigationSection("none", state)).toBeUndefined();
  });

  it("uses the mobile accordion state on mobile layouts", () => {
    const state = { selectedProject: {}, selectedWorkspace: {} };

    expect(isNavigationSectionCollapsed("projects", { isMobileLayout: true, expanded: "sessions", state })).toBe(true);
    expect(isNavigationSectionCollapsed("sessions", { isMobileLayout: true, expanded: "sessions", state })).toBe(false);
  });

  it("uses independent collapsed sections on desktop layouts", () => {
    const state = { selectedProject: {}, selectedWorkspace: {} };

    expect(isNavigationSectionCollapsed("projects", { isMobileLayout: false, expanded: "sessions", state })).toBe(false);
    expect(isNavigationSectionCollapsed("projects", { isMobileLayout: false, expanded: "sessions", state, collapsedSections: ["projects"] })).toBe(true);
    expect(isNavigationSectionCollapsed("sessions", { isMobileLayout: false, expanded: "sessions", state, collapsedSections: ["projects"] })).toBe(false);
  });

  it("toggles the effective mobile section, including the implicit default section", () => {
    const state = { selectedProject: undefined, selectedWorkspace: undefined };

    expect(toggleNavigationSection(undefined, "projects", { isMobileLayout: true, state })).toBe("none");
    expect(toggleNavigationSection("none", "projects", { isMobileLayout: true, state })).toBe("projects");
    expect(toggleNavigationSection("projects", "workspaces", { isMobileLayout: true, state })).toBe("workspaces");
  });

  it("does not mutate expanded section on desktop layouts", () => {
    const state = { selectedProject: undefined, selectedWorkspace: undefined };

    expect(toggleNavigationSection("projects", "projects", { isMobileLayout: false, state })).toBe("projects");
  });

  it("toggles desktop sections independently", () => {
    expect(toggleCollapsedNavigationSection([], "projects")).toEqual(["projects"]);
    expect(toggleCollapsedNavigationSection(["machines", "projects"], "projects")).toEqual(["machines"]);
    expect(toggleCollapsedNavigationSection(["sessions"], "machines")).toEqual(["machines", "sessions"]);
  });

});
