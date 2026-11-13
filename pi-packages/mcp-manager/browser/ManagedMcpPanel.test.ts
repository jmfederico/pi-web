// @vitest-environment happy-dom
import { installNativeDialogFake } from "../../../src/client/src/components/nativeDialog.testSupport.js";
installNativeDialogFake();

import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ManagedMcpView } from "../shared.js";
import { managedMcpApi } from "./managedMcp.js";
import { managedMcpView } from "./managedMcp.testSupport.js";
import { deferred } from "../../../src/client/src/components/SettingsDialog.testSupport.js";
import type { ManagedMcpPanel, ManagedMcpPanelContext } from "./ManagedMcpPanel.js";
import { panelServices } from "./panel.testSupport.js";

const services = panelServices();
const managedMcpMessages = services.messages;
afterAll(() => { services.lifetime.abort(); });
const context = { machineId: "remote", projectId: "project", workspaceId: "workspace", cwd: "/workspace", sessionId: "session-a" };
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
}
async function mount(origin: ManagedMcpPanelContext = context): Promise<ManagedMcpPanel> {
  const panel = services.createPanel();
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
  panel.shadowRoot?.querySelector<HTMLButtonElement>("header button")?.click();
}
async function answerRefresh(panel: ManagedMcpPanel, answer: "confirm" | "cancel"): Promise<void> {
  await panel.updateComplete;
  const choice = panel.shadowRoot?.querySelector<HTMLButtonElement>(`#confirmation-${answer}`);
  if (!choice) throw new Error("Missing refresh confirmation");
  choice.click();
  await settle(panel);
}

it("shows disabled definitions and only the scopes available in the current context", async () => {
  const panel = await mount({ machineId: "remote" });
  expect(panel.shadowRoot?.querySelectorAll("input")).toHaveLength(3);
  expect(checkbox(panel, "project-tools", "Global").disabled).toBe(true);
  expect(checkbox(panel, "native", "Global").disabled).toBe(true);
  panel.context = { machineId: "remote", projectId: "project", workspaceId: "workspace", cwd: "/workspace" };
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
  const savedChoices = managedMcpMessages.t("enabledBy", { scopes: "Global and Project" });
  expect(row?.textContent).toContain(savedChoices);
  checkbox(panel, "docs", "Project").click();
  await settle(panel);
  expect(row?.textContent).toContain(savedChoices);
  expect(row?.textContent).toContain(managedMcpMessages.t("remainsEnabled", { scopes: "Global" }));
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
  expect(managedMcpApi.update).toHaveBeenLastCalledWith(undefined, context, { serverName: "docs", scope: "global", enabled: false, revision: "revision-1" }, expect.any(AbortSignal));
  checkbox(panel, "docs", "Session").click();
  await settle(panel);
  expect(managedMcpApi.update).toHaveBeenLastCalledWith(undefined, context, { serverName: "docs", scope: "session", enabled: true, revision: "revision-2" }, expect.any(AbortSignal));
  expect(checkbox(panel, "docs", "Session").closest("td")?.querySelector('[role="status"]')).not.toBeNull();
  expect(checkbox(panel, "docs", "Global").closest("td")?.querySelector('[role="status"]')).toBeNull();
});

it("preserves drafts when the host supplies a fresh backend facade for the same selection", async () => {
  const panel = services.createPanel();
  panel.context = context;
  panel.backend = { machineId: context.machineId, forScope: () => ({ request: vi.fn() }) };
  document.body.append(panel);
  await settle(panel);
  checkbox(panel, "docs", "Project").click();
  await settle(panel);
  panel.backend = { machineId: context.machineId, forScope: () => ({ request: vi.fn() }) };
  await settle(panel);
  expect(managedMcpApi.get).toHaveBeenCalledOnce();
  expect(checkbox(panel, "docs", "Project").checked).toBe(true);
});

it("registers shared UI styles and releases the root on removal and replacement", async () => {
  const release = vi.fn();
  const styles = { registerRoot: vi.fn(() => release), subscribe: vi.fn(), createController: vi.fn() };
  const panel = services.createPanel();
  panel.context = context;
  panel.styles = styles;
  document.body.append(panel);
  await settle(panel);
  expect(styles.registerRoot).toHaveBeenCalledWith(panel.shadowRoot, { sharedUi: true });
  panel.remove();
  expect(release).toHaveBeenCalledOnce();
  document.body.append(panel);
  await settle(panel);
  expect(styles.registerRoot).toHaveBeenCalledTimes(2);
  const replacement = { ...styles, registerRoot: vi.fn(() => vi.fn()) };
  panel.styles = replacement;
  await settle(panel);
  expect(replacement.registerRoot).toHaveBeenCalledWith(panel.shadowRoot, { sharedUi: true });
  expect(release).toHaveBeenCalledTimes(2);
});

it("keeps drafts when refresh is cancelled and reloads only after confirmation", async () => {
  const panel = await mount();
  checkbox(panel, "docs", "Project").click();
  await settle(panel);
  refresh(panel);
  await answerRefresh(panel, "cancel");
  expect(managedMcpApi.get).toHaveBeenCalledOnce();
  expect(checkbox(panel, "docs", "Project").checked).toBe(true);
  refresh(panel);
  await answerRefresh(panel, "confirm");
  expect(managedMcpApi.get).toHaveBeenCalledTimes(2);
  expect(checkbox(panel, "docs", "Project").checked).toBe(false);
  expect(managedMcpApi.update).not.toHaveBeenCalled();
});

it("does not discard a new context's drafts when an old refresh prompt is confirmed", async () => {
  const panel = await mount();
  checkbox(panel, "docs", "Project").click();
  await settle(panel);
  refresh(panel);
  panel.context = { ...context, sessionId: "session-b" };
  await settle(panel);
  checkbox(panel, "docs", "Project").click();
  await settle(panel);
  await answerRefresh(panel, "confirm");
  expect(managedMcpApi.get).toHaveBeenCalledTimes(2);
  expect(checkbox(panel, "docs", "Project").checked).toBe(true);
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
  { ...context, machineId: "other" },
  { ...context, workspaceId: "different", cwd: "/different" },
  { ...context, workspaceId: "different" },
  { ...context, sessionId: "session-b" },
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
  expect(copy).toHaveBeenCalledWith("/home/fixture/.pi/agent/mcp-manager/config.json");
  const pending = deferred<ManagedMcpView>();
  vi.mocked(managedMcpApi.get).mockReturnValueOnce(pending.promise);
  refresh(panel);
  panel.remove();
  pending.resolve(managedMcpView({ servers: [] }));
  document.body.append(panel);
  await settle(panel);
  expect(checkbox(panel, "docs", "Global").checked).toBe(true);
});
