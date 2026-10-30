// @vitest-environment happy-dom

import { afterEach, expect, it, vi } from "vitest";
import { trustApi } from "../api";
import { writeClipboardText } from "../clipboard";
import { installPopoverFake } from "./anchoredPopup.testSupport";
import { MachineList } from "./MachineList";
import { ProjectList } from "./ProjectList";
import { WorkspaceList } from "./WorkspaceList";
import { SessionList } from "./SessionList";

vi.mock("../clipboard", () => ({ writeClipboardText: vi.fn().mockResolvedValue(true) }));
installPopoverFake();

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.mocked(writeClipboardText).mockReset().mockResolvedValue(true);
});

const id = "opaque / ? identifier";
const date = "2026-06-09T00:00:00.000Z";

async function mount(kind: "machine" | "project" | "workspace" | "session") {
  let list: MachineList | ProjectList | WorkspaceList | SessionList;
  if (kind === "machine") {
    list = new MachineList();
    list.machines = [{ id, name: "Local machine", kind: "local", createdAt: date, updatedAt: date }];
  } else if (kind === "project") {
    list = new ProjectList();
    list.projects = [{ id, name: "Project", path: "/repo", createdAt: date }];
  } else if (kind === "workspace") {
    vi.spyOn(trustApi, "workspaceTrust").mockResolvedValue({ path: "/repo", trusted: true, decision: true });
    list = new WorkspaceList();
    list.workspaces = [{ id, projectId: "project", path: "/repo", label: "Workspace", isMain: true, effectiveConfig: {} }];
  } else {
    list = new SessionList();
    list.sessions = [{ id, path: "/sessions/session.jsonl", cwd: "/repo", created: date, modified: date, messageCount: 1, firstMessage: "Session" }];
  }
  list.onSelect = vi.fn();
  document.body.append(list);
  await list.updateComplete;
  list.shadowRoot?.querySelector<HTMLButtonElement>(".action-menu-toggle")?.click();
  await list.updateComplete;
  return list;
}

it.each(["machine", "project", "workspace", "session"] as const)("copies the %s ID without exposing it or selecting the row", async (kind) => {
  const list = await mount(kind);
  const panel = list.shadowRoot?.querySelector(".action-menu-panel");
  expect(panel).not.toBeNull();
  expect(panel?.textContent).not.toContain(id);
  const copy = panel?.querySelector<HTMLButtonElement>("[data-copy-id]");
  expect(copy).not.toBeNull();
  const actions = kind === "workspace" ? panel?.querySelector(".workspace-menu-actions") : panel;
  expect([...actions?.querySelectorAll("button") ?? []].at(-1)).toBe(copy);
  copy?.click();
  await vi.waitFor(() => { expect(writeClipboardText).toHaveBeenCalledExactlyOnceWith(id); });
  await list.updateComplete;
  expect(list.shadowRoot?.querySelector(".action-menu-panel")).toBeNull();
  expect(list.onSelect).not.toHaveBeenCalled();
});

it("keeps the menu available and reports a failed copy", async () => {
  vi.mocked(writeClipboardText).mockResolvedValue(false);
  const alert = vi.fn();
  vi.stubGlobal("alert", alert);
  const list = await mount("machine");
  list.shadowRoot?.querySelector<HTMLButtonElement>("[data-copy-id]")?.click();
  await vi.waitFor(() => { expect(alert).toHaveBeenCalledOnce(); });
  expect(list.shadowRoot?.querySelector(".action-menu-panel")).not.toBeNull();
});
