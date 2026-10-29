// @vitest-environment happy-dom
import { html, render } from "lit";
import type { ApplicationPanelContextV5, JsonValue, PluginPeerRequestOptions } from "@jmfederico/pi-web/plugin-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalizationService } from "../../../src/client/src/localization/service.js";
import { createPluginLocalization } from "../../../src/client/src/plugins/localization.js";
import { stylesheetIntegrationCapability } from "../../../src/client/src/plugins/styles.js";
import plugin from "./pi-web-plugin.js";
import { ScheduledTasksPanel } from "./panel.js";

const task = { id: "task", name: "Review <script>", revision: 3, projectId: "stored-project", workspaceId: "stored-workspace", schedule: { kind: "cron", expression: "0 9 * * *" }, timezone: "Europe/Madrid", paused: true, archived: false, nextDue: "2026-10-02T07:00:00Z" };
const execution = { id: "execution", task, status: "dispatched", trigger: "manual", createdAt: "2026-10-01T07:00:00Z", sessionId: "stored-conversation", dispatchError: null, latestReport: null };
const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).forEach((dispose) => { dispose(); }); document.body.replaceChildren(); vi.restoreAllMocks(); });

function setup(request = vi.fn<(operation: string, input: JsonValue, options?: PluginPeerRequestOptions) => Promise<JsonValue>>((operation) => Promise.resolve(operation === "overview" ? { tasks: [{ ...task, latestExecution: execution }] } : { executions: [execution], nextOffset: 20 }))) {
  const lifetime = new AbortController();
  const service = new LocalizationService({ development: true, preferences: { language: "en", formatLocale: "en-US" } });
  const localization = createPluginLocalization(service, "scheduled-tasks", "@jmfederico/pi-web-scheduled-tasks", lifetime.signal);
  const activation = plugin.activate({ apiVersion: 5, pluginId: "scheduled-tasks", runtimePluginId: "scheduled-tasks", signal: lifetime.signal, localization, lifetimeSignal: lifetime.signal, html, svg: html });
  activation.start({ signal: lifetime.signal, capabilities: { resolve: (token) => token.parse(stylesheetIntegrationCapability) } });
  const panel = activation.contributions.applicationPanels[0];
  if (!panel) throw new Error("Panel missing");
  const forScope = vi.fn(() => ({ request }));
  const navigate = vi.fn(() => Promise.resolve());
  const context: ApplicationPanelContextV5 = {
    machine: { id: "captured-machine", name: "Machine", kind: "remote" }, state: {},
    catalog: { version: 1, machineId: "captured-machine", projects: { list: vi.fn(), get: vi.fn() }, workspaces: { list: vi.fn(), get: vi.fn() }, sessions: { list: vi.fn(), get: vi.fn() } },
    backend: { machineId: "captured-machine", forScope }, navigate,
    host: { requestRender: vi.fn() }, prompt: { insertText: vi.fn(), getText: () => "draft", getSelection: () => null },
  };
  const container = document.createElement("div"); document.body.append(container);
  const mount = (next = context) => { render(panel.render(next), container); };
  mount();
  const element = document.querySelector("pi-web-scheduled-tasks-panel");
  if (!(element instanceof ScheduledTasksPanel) || !element.shadowRoot) throw new Error("Dashboard missing");
  const root = element.shadowRoot;
  cleanup.push(() => { lifetime.abort(); render(nothingTemplate, container); });
  return { element, root, request, forScope, context, mount, service, lifetime, navigate };
}
const nothingTemplate = html``;
function button(root: ShadowRoot, name: string): HTMLButtonElement {
  const control = [...root.querySelectorAll("button")].find((candidate) => (candidate.getAttribute("aria-label") ?? candidate.textContent.trim()) === name);
  if (!control) throw new Error(`Missing button ${name}`);
  return control;
}
async function ready(target: ReturnType<typeof setup>): Promise<void> { await vi.waitFor(() => { expect(target.root.querySelector("article")).not.toBeNull(); }); }

describe("Scheduled tasks dashboard", () => {
  it("loads machine-wide read models without a workspace, escapes user content, and opens stored conversation targets", async () => {
    const target = setup(); await ready(target);
    expect(target.forScope).toHaveBeenCalledWith({ kind: "machine" });
    expect(target.request.mock.calls.map(([operation]) => operation)).toEqual(["overview", "history"]);
    expect(target.root.textContent).toContain(task.name);
    expect(target.root.querySelector("script")).toBeNull();
    // A retained due timestamp is not an upcoming dispatch while the task is paused.
    expect(target.root.querySelector(".next")?.textContent).not.toContain("2026");
    expect(target.root.querySelectorAll('[data-status="dispatched"]')).toHaveLength(2);
    button(target.root, "Open conversation").click();
    await vi.waitFor(() => { expect(target.navigate).toHaveBeenCalledExactlyOnceWith({ machineId: "captured-machine", projectId: "stored-project", workspaceId: "stored-workspace", sessionId: "stored-conversation", view: "chat" }); });
    expect(target.context.prompt.getText()).toBe("draft");
    target.mount({ ...target.context, state: { mainView: "workspace" } }); await target.element.updateComplete;
    expect(target.request).toHaveBeenCalledTimes(2);
  });
  it("filters and pages history, then refreshes explicit corrections without deriving outcomes from sessions", async () => {
    const target = setup(); await ready(target);
    button(target.root, `View history for ${task.name}`).click();
    await vi.waitFor(() => { expect(target.request).toHaveBeenCalledWith("history", { taskId: "task", limit: 20, offset: 0 }, expect.anything()); });
    await vi.waitFor(() => { expect(button(target.root, "Next").disabled).toBe(false); });
    button(target.root, "Next").click();
    await vi.waitFor(() => { expect(target.request).toHaveBeenCalledWith("history", { taskId: "task", limit: 20, offset: 20 }, expect.anything()); });
    await vi.waitFor(() => { expect(button(target.root, "Refresh").disabled).toBe(false); });
    target.request.mockImplementation((operation) => Promise.resolve(operation === "overview" ? { tasks: [{ ...task, latestExecution: { ...execution, status: "errored", latestReport: { summary: "Corrected <failure>" } } }] } : { executions: [], nextOffset: null }));
    button(target.root, "Refresh").click();
    await vi.waitFor(() => { expect(target.root.textContent).toContain("Corrected <failure>"); });
    expect(target.root.querySelector("failure")).toBeNull();
    expect(target.request.mock.calls.every(([operation]) => ["overview", "history"].includes(operation))).toBe(true);
  });
  it("discards stale results on machine changes and aborts requests on disconnect", async () => {
    let resolve: (value: JsonValue) => void = () => undefined;
    const target = setup(vi.fn((operation) => operation === "overview" ? new Promise<JsonValue>((done) => { resolve = done; }) : Promise.resolve({ executions: [], nextOffset: null })));
    const signal = target.request.mock.calls[0]?.[2]?.signal;
    const unavailable = { ...target.context }; delete unavailable.backend;
    target.mount({ ...unavailable, machine: { id: "new-machine", name: "New", kind: "local" } });
    resolve({ tasks: [{ ...task, latestExecution: execution }] });
    await target.element.updateComplete;
    expect(signal?.aborted).toBe(true);
    expect(target.root.querySelector("article")).toBeNull();
    target.mount(); await target.element.updateComplete;
    const newSignal = target.request.mock.calls.at(-1)?.[2]?.signal;
    target.element.remove();
    expect(newSignal?.aborted).toBe(true);
  });
  it("shows backend errors safely and recovers through refresh; validates malformed data", async () => {
    const target = setup(vi.fn(() => Promise.reject(new Error("Backend <failure>"))));
    await vi.waitFor(() => { expect(target.root.querySelector('[role="alert"]')?.textContent).toContain("Backend <failure>"); });
    expect(target.root.querySelector("failure")).toBeNull();
    target.request.mockResolvedValue({ tasks: [{}] }); button(target.root, "Refresh").click();
    await vi.waitFor(() => { expect(target.root.querySelector('[role="alert"]')?.textContent).toContain("Invalid response"); });
    target.request.mockImplementation((operation) => Promise.resolve(operation === "overview" ? { tasks: [] } : { executions: [], nextOffset: null }));
    button(target.root, "Refresh").click();
    await vi.waitFor(() => { expect(target.root.querySelector('[role="alert"]')).toBeNull(); expect(target.root.querySelector("section")).not.toBeNull(); });
  });
  it("updates language and direction without another request and aborts when disabled", async () => {
    const target = setup(); await ready(target);
    const originalTitle = target.root.querySelector("header")?.textContent;
    await target.service.setPreferences({ language: "ar-XB", formatLocale: "ar-EG" });
    await target.element.updateComplete;
    expect(target.root.querySelector(".panel")?.getAttribute("dir")).toBe("rtl");
    expect(target.root.querySelector("header")?.textContent).not.toBe(originalTitle);
    expect(target.request).toHaveBeenCalledTimes(2);
    target.lifetime.abort();
    expect(target.request.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
  });
});
