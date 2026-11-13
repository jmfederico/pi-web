// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ManagedMcpView } from "../../../shared/managedMcp";
import { managedMcpApi } from "../api/managedMcp";
import { managedMcpView } from "../api/managedMcp.testSupport";
import { deferred } from "./SettingsDialog.testSupport";
import { ManagedMcpPanel, type ManagedMcpPanelContext } from "./ManagedMcpPanel";

const context = { machineId: "remote", cwd: "/workspace", sessionId: "session-a" };
beforeEach(() => {
  vi.spyOn(managedMcpApi, "get").mockResolvedValue(managedMcpView());
  vi.spyOn(managedMcpApi, "update").mockResolvedValue(managedMcpView({ revision: "revision-2" }));
});
afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
});
async function settle(panel: ManagedMcpPanel): Promise<void> {
  await panel.updateComplete;
  await panel.updateComplete;
  await panel.shadowRoot?.querySelector("settings-panel-frame")?.updateComplete;
}
async function mount(origin: ManagedMcpPanelContext = context): Promise<ManagedMcpPanel> {
  const panel = new ManagedMcpPanel();
  panel.context = origin;
  document.body.append(panel);
  await settle(panel);
  return panel;
}
function checkbox(panel: ManagedMcpPanel, name: string, scope: string): HTMLInputElement {
  const input = panel.shadowRoot?.querySelector<HTMLInputElement>(`input[aria-label="Enable ${name} in ${scope}"]`);
  if (!input) throw new Error("Missing scope checkbox");
  return input;
}
function button(panel: ManagedMcpPanel, label: string): HTMLButtonElement {
  const result = panel.shadowRoot?.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!result) throw new Error(`Missing ${label}`);
  return result;
}
function refresh(panel: ManagedMcpPanel): void {
  panel.shadowRoot?.querySelector("settings-panel-frame")?.shadowRoot?.querySelector("button")?.click();
}

it("shows disabled definitions and only the scopes available in the current context", async () => {
  const panel = await mount({ machineId: "remote" });
  expect(panel.shadowRoot?.querySelectorAll("input")).toHaveLength(3);
  expect(checkbox(panel, "project-tools", "Global").disabled).toBe(true);
  expect(checkbox(panel, "native", "Global").disabled).toBe(true);
  panel.context = { machineId: "remote", cwd: "/workspace" };
  await settle(panel);
  expect(panel.shadowRoot?.querySelectorAll("input")).toHaveLength(6);
  panel.context = context;
  await settle(panel);
  expect(panel.shadowRoot?.querySelectorAll("input")).toHaveLength(9);
  expect(checkbox(panel, "project-tools", "Session").checked).toBe(false);
  expect(managedMcpApi.update).not.toHaveBeenCalled();
});

it("shows explicit context and saved enablement sources without treating drafts as effective", async () => {
  const view = managedMcpView();
  view.servers = view.servers.map((server) => server.name === "docs"
    ? { ...server, enabled: { global: true, project: true, session: false } } : server);
  vi.mocked(managedMcpApi.get).mockResolvedValueOnce(view);
  const panel = await mount();
  panel.machineLabel = "Build machine";
  panel.sessionLabel = "Documentation review";
  await settle(panel);
  const header = panel.shadowRoot?.querySelector("dl");
  expect(header?.textContent).toContain("Build machine");
  expect(header?.textContent).toContain("/workspace");
  expect(header?.textContent).toContain("Documentation review");
  const row = panel.shadowRoot?.querySelector("tbody tr");
  expect(row?.textContent).toContain("Enabled by Global and Project");
  checkbox(panel, "docs", "Project").click();
  await settle(panel);
  expect(row?.textContent).toContain("Enabled by Global and Project");
  expect(managedMcpApi.update).not.toHaveBeenCalled();
  // Presentation changes must not reload the snapshot or discard an unsaved draft.
  panel.sessionLabel = "Renamed session";
  await settle(panel);
  expect(managedMcpApi.get).toHaveBeenCalledOnce();
  expect(checkbox(panel, "docs", "Project").checked).toBe(false);
  expect(header?.textContent).toContain("Renamed session");
  panel.sessionLabel = "";
  await settle(panel);
  expect(header?.textContent).toContain("session-a");
});

it("stages ancestor changes with explicit save, cancels drafts, and saves session changes immediately", async () => {
  const panel = await mount();
  checkbox(panel, "docs", "Project").click();
  await settle(panel);
  expect(managedMcpApi.update).not.toHaveBeenCalled();
  button(panel, "Cancel Project change for docs").click();
  await settle(panel);
  expect(checkbox(panel, "docs", "Project").checked).toBe(false);
  checkbox(panel, "docs", "Global").click();
  await settle(panel);
  button(panel, "Save Global change for docs").click();
  await settle(panel);
  expect(managedMcpApi.update).toHaveBeenLastCalledWith({ cwd: context.cwd, sessionId: context.sessionId, serverName: "docs", scope: "global", enabled: false, revision: "revision-1" }, "remote");
  checkbox(panel, "docs", "Session").click();
  await settle(panel);
  expect(managedMcpApi.update).toHaveBeenLastCalledWith({ cwd: context.cwd, sessionId: context.sessionId, serverName: "docs", scope: "session", enabled: true, revision: "revision-2" }, "remote");
});

it("enforces writable flags and project trust without hiding definitions or native conflicts", async () => {
  vi.mocked(managedMcpApi.get).mockResolvedValueOnce(managedMcpView({ globalWritable: false, projectWritable: false, sessionWritable: false }));
  const panel = await mount();
  expect([...panel.shadowRoot?.querySelectorAll("input") ?? []].every((input) => input.disabled)).toBe(true);
  vi.mocked(managedMcpApi.get).mockResolvedValueOnce(managedMcpView({ projectTrusted: false }));
  refresh(panel);
  await settle(panel);
  expect(checkbox(panel, "docs", "Session").disabled).toBe(false);
  expect(checkbox(panel, "docs", "Project").disabled).toBe(true);
  expect(checkbox(panel, "project-tools", "Session").disabled).toBe(true);
  expect(checkbox(panel, "native", "Session").disabled).toBe(true);
});

it("serializes saves and restores checked state after an error with a refresh recovery", async () => {
  const pending = deferred<ManagedMcpView>();
  vi.mocked(managedMcpApi.update).mockReturnValueOnce(pending.promise);
  const panel = await mount();
  checkbox(panel, "docs", "Session").click();
  await settle(panel);
  expect(checkbox(panel, "docs", "Session").checked).toBe(true);
  expect(checkbox(panel, "docs", "Project").disabled).toBe(true);
  pending.reject(new Error("stale revision"));
  await settle(panel);
  expect(checkbox(panel, "docs", "Session").checked).toBe(false);
  expect(panel.shadowRoot?.querySelector('[role="alert"]')?.textContent).toContain("stale revision");
  refresh(panel);
  await settle(panel);
  expect(panel.shadowRoot?.querySelector('[role="alert"]')).toBeNull();
});

it.each([
  { machineId: "other", cwd: "/workspace", sessionId: "session-a" },
  { machineId: "remote", cwd: "/different", sessionId: "session-a" },
  { machineId: "remote", cwd: "/workspace", sessionId: "session-b" },
])("ignores old loads and writes after a context switch: %j", async (next) => {
  const pendingLoad = deferred<ManagedMcpView>();
  vi.mocked(managedMcpApi.get).mockReturnValueOnce(pendingLoad.promise);
  const panel = await mount();
  panel.context = next;
  await settle(panel);
  pendingLoad.resolve(managedMcpView({ servers: [] }));
  await settle(panel);
  expect(checkbox(panel, "docs", "Session").disabled).toBe(false);
  const pendingSave = deferred<ManagedMcpView>();
  vi.mocked(managedMcpApi.update).mockReturnValueOnce(pendingSave.promise);
  checkbox(panel, "docs", "Session").click();
  await settle(panel);
  panel.context = context;
  await settle(panel);
  pendingSave.reject(new Error("obsolete write failure"));
  await settle(panel);
  expect(panel.shadowRoot?.querySelector('[role="alert"]')).toBeNull();
  expect(checkbox(panel, "docs", "Session").checked).toBe(false);
});

it("rejects events from the old rendered view before a context switch has rendered", async () => {
  const panel = await mount();
  checkbox(panel, "docs", "Global").click();
  await settle(panel);
  panel.context = { ...context, machineId: "other" };
  button(panel, "Save Global change for docs").click();
  checkbox(panel, "docs", "Session").click();
  await settle(panel);
  expect(managedMcpApi.update).not.toHaveBeenCalled();
});

it("ignores a response after removal and copies the exact machine config path", async () => {
  const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  const panel = await mount();
  button(panel, "Copy Global config path").click();
  await settle(panel);
  expect(copy).toHaveBeenCalledWith("/home/fixture/.config/pi-web/config.json");
  const pending = deferred<ManagedMcpView>();
  vi.mocked(managedMcpApi.get).mockReturnValueOnce(pending.promise);
  refresh(panel);
  panel.remove();
  pending.resolve(managedMcpView({ servers: [] }));
  document.body.append(panel);
  await settle(panel);
  expect(checkbox(panel, "docs", "Global").checked).toBe(true);
});
