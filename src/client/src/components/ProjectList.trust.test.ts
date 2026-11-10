// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trustApi, workspacesApi, type Project, type Workspace } from "../api";
import { installPopoverFake } from "./anchoredPopup.testSupport";
import { ProjectList } from "./ProjectList";

installPopoverFake();
const project: Project = { id: "project", name: "Plain folder", path: "/repo", createdAt: "" };
const root: Workspace = { id: "root", projectId: project.id, path: project.path, label: "Root", isMain: true, effectiveConfig: {} };
const other: Workspace = { ...root, id: "other", path: "/worktrees/other" };

beforeEach(() => {
  vi.spyOn(workspacesApi, "workspaces").mockResolvedValue([root]);
  vi.spyOn(trustApi, "workspaceTrust").mockResolvedValue({ path: root.path, decision: false, trusted: false });
  vi.spyOn(trustApi, "setWorkspaceTrust").mockImplementation((_projectId, _workspaceId, trusted) => Promise.resolve({ path: root.path, decision: trusted, trusted }));
});
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("project root trust", () => {
  it.each(["local", "remote"])("targets only the root folder on %s, not another provider main workspace", async (machineId) => {
    vi.mocked(workspacesApi.workspaces).mockResolvedValue([
      other,
      { ...root, id: "wrong-project", projectId: "unrelated" },
      { ...root, isMain: false },
    ]);
    const list = await mount(machineId);
    list.onSelect = vi.fn();
    await toggleMenu(list);
    await loaded(list, false);
    const input = checkbox(list);
    // Scope and path are part of the permission decision, including for assistive technology.
    expect(input.labels?.[0]?.textContent).toContain("root folder");
    const description = input.getAttribute("aria-describedby")?.split(/\s+/)
      .map((id) => list.shadowRoot?.getElementById(id)?.textContent).join(" ");
    expect(description).toContain(project.path);
    input.click();
    await loaded(list, true);
    expect(workspacesApi.workspaces).toHaveBeenCalledExactlyOnceWith(project.id, machineId);
    expect(trustApi.workspaceTrust).toHaveBeenCalledExactlyOnceWith(project.id, root.id, machineId);
    expect(trustApi.setWorkspaceTrust).toHaveBeenCalledExactlyOnceWith(project.id, root.id, true, machineId);
    expect(list.onSelect).not.toHaveBeenCalled();
  });

  it("keeps a missing root unavailable instead of trusting another folder, and retries on reopen", async () => {
    vi.mocked(workspacesApi.workspaces).mockResolvedValueOnce([other]);
    const list = await mount();
    await toggleMenu(list);
    await vi.waitFor(() => { expect(list.shadowRoot?.querySelector('[role="alert"]')).not.toBeNull(); });
    expect(checkbox(list).disabled).toBe(true);
    checkbox(list).click();
    expect(trustApi.workspaceTrust).not.toHaveBeenCalled();
    expect(trustApi.setWorkspaceTrust).not.toHaveBeenCalled();
    await toggleMenu(list);
    await toggleMenu(list);
    await loaded(list, false);
    expect(list.shadowRoot?.querySelector('[role="alert"]')).toBeNull();
  });

  it("disables changes after a failed trust read and refreshes the decision when reopened", async () => {
    vi.mocked(trustApi.workspaceTrust).mockRejectedValueOnce(new Error("Offline"));
    const list = await mount();
    await toggleMenu(list);
    await vi.waitFor(() => { expect(list.shadowRoot?.querySelector('[role="alert"]')?.textContent).toBe("Offline"); });
    expect(checkbox(list).disabled).toBe(true);
    vi.mocked(trustApi.workspaceTrust).mockResolvedValue({ path: root.path, decision: true, trusted: true });
    await toggleMenu(list);
    await toggleMenu(list);
    await loaded(list, true);
    checkbox(list).click();
    await loaded(list, false);
    expect(trustApi.setWorkspaceTrust).toHaveBeenCalledExactlyOnceWith(project.id, root.id, false, "local");
  });

  it("keeps a pending save disabled across reopening, rolls back failure and allows retry", async () => {
    let rejectSave: (error: Error) => void = () => { throw new Error("Missing save"); };
    vi.mocked(trustApi.setWorkspaceTrust).mockReturnValueOnce(new Promise((_resolve, reject) => { rejectSave = reject; }));
    const list = await mount();
    await toggleMenu(list);
    await loaded(list, false);
    checkbox(list).click();
    await list.updateComplete;
    expect(checkbox(list).disabled).toBe(true);
    await toggleMenu(list);
    await toggleMenu(list);
    expect(checkbox(list).disabled).toBe(true);
    expect(trustApi.workspaceTrust).toHaveBeenCalledTimes(1);
    rejectSave(new Error("Cannot save trust"));
    await loaded(list, false);
    const error = list.shadowRoot?.querySelector('[role="alert"]');
    expect(error?.textContent).toBe("Cannot save trust");
    expect(checkbox(list).getAttribute("aria-describedby")).toContain(error?.id);
    checkbox(list).click();
    await loaded(list, true);
    expect(list.shadowRoot?.querySelector('[role="alert"]')).toBeNull();
  });

  it("does not use a late lookup from another machine with matching project IDs", async () => {
    let resolveLocal: (value: Workspace[]) => void = () => { throw new Error("Missing lookup"); };
    vi.mocked(workspacesApi.workspaces).mockReturnValueOnce(new Promise((resolve) => { resolveLocal = resolve; }));
    const list = await mount();
    await toggleMenu(list);
    expect(checkbox(list).disabled).toBe(true);
    list.machineId = "remote";
    await list.updateComplete;
    expect(list.shadowRoot?.querySelector(".action-menu-panel")).toBeNull();
    await toggleMenu(list);
    await loaded(list, false);
    vi.mocked(trustApi.workspaceTrust).mockResolvedValue({ path: root.path, decision: true, trusted: true });
    resolveLocal([{ ...root, id: "local-root" }]);
    await vi.waitFor(() => { expect(trustApi.workspaceTrust).toHaveBeenCalledWith(project.id, "local-root", "local"); });
    await loaded(list, false);
    checkbox(list).click();
    await loaded(list, true);
    expect(trustApi.setWorkspaceTrust).toHaveBeenCalledExactlyOnceWith(project.id, root.id, true, "remote");
  });
});

async function mount(machineId = "local"): Promise<ProjectList> {
  const list = new ProjectList();
  list.machineId = machineId;
  list.projects = [project];
  document.body.append(list);
  await list.updateComplete;
  return list;
}

async function toggleMenu(list: ProjectList): Promise<void> {
  const trigger = list.shadowRoot?.querySelector<HTMLButtonElement>(".action-menu-toggle");
  if (!trigger) throw new Error("Missing project menu");
  trigger.click();
  await list.updateComplete;
}

function checkbox(list: ProjectList): HTMLInputElement {
  const input = list.shadowRoot?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (!input) throw new Error("Missing root trust checkbox");
  return input;
}

async function loaded(list: ProjectList, trusted: boolean): Promise<void> {
  await vi.waitFor(() => {
    expect(checkbox(list).disabled).toBe(false);
    expect(checkbox(list).checked).toBe(trusted);
  });
}
