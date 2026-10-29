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
afterEach(() => { cleanup.splice(0).forEach((dispose) => { dispose(); }); document.body.replaceChildren(); localStorage.clear(); vi.restoreAllMocks(); });

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
function deferred() {
  let resolve!: (value: JsonValue) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<JsonValue>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function button(root: ShadowRoot, name: string): HTMLButtonElement {
  const control = [...root.querySelectorAll("button")].find((candidate) => (candidate.getAttribute("aria-label") ?? candidate.textContent.trim()) === name);
  if (!control) throw new Error(`Missing button ${name}`);
  return control;
}
async function ready(target: ReturnType<typeof setup>): Promise<void> { await vi.waitFor(() => { expect(target.root.querySelector("article")).not.toBeNull(); }); }

describe("Scheduled tasks dashboard", () => {
  it("initially loads only the machine overview, escapes task names, and opens stored conversation targets", async () => {
    const target = setup(); await ready(target);
    expect(target.forScope).toHaveBeenCalledWith({ kind: "machine" });
    expect(target.request).toHaveBeenCalledExactlyOnceWith("overview", {}, expect.anything());
    expect(target.request.mock.calls[0]?.[2]?.signal).toBeInstanceOf(AbortSignal);
    expect(button(target.root, `View task: ${task.name}`).textContent).toBe(task.name);
    expect(target.root.querySelector("script")).toBeNull();
    // A retained due timestamp is not an upcoming dispatch while the task is paused.
    expect(target.root.querySelector('[aria-labelledby="upcoming-title"] article')).toBeNull();
    expect(target.root.querySelector('[aria-labelledby="awaiting-title"] [data-status="dispatched"]')).not.toBeNull();
    expect(target.root.querySelector('[aria-labelledby="results-title"]')).toBeNull();
    button(target.root, "Open conversation").click();
    await vi.waitFor(() => { expect(target.navigate).toHaveBeenCalledExactlyOnceWith({ machineId: "captured-machine", projectId: "stored-project", workspaceId: "stored-workspace", sessionId: "stored-conversation", view: "chat" }); });
    expect(target.context.prompt.getText()).toBe("draft");
    target.mount({ ...target.context, state: { mainView: "workspace" } }); await target.element.updateComplete;
    expect(target.request).toHaveBeenCalledTimes(1);
  });
  it("opens full task reports and technical disclosures with lazy task-filtered, paginated history", async () => {
    const summary = `First line <script>\n${"Full report detail. ".repeat(40)}\nFinal finding <failure>`;
    const reported = { ...execution, status: "errored", dispatchError: "Diagnostic <failure>", latestReport: { summary } };
    const target = setup(vi.fn((operation) => Promise.resolve(operation === "overview"
      ? { tasks: [{ ...task, latestExecution: reported }] }
      : { executions: [reported], nextOffset: 20 })));
    await ready(target);
    button(target.root, `View task: ${task.name}`).click();
    await vi.waitFor(() => { expect(target.request).toHaveBeenCalledWith("history", { taskId: "task", limit: 20, offset: 0 }, expect.anything()); });
    await vi.waitFor(() => { expect(target.root.querySelector(".history-entry .summary")?.textContent).toBe(summary); });
    expect(target.root.querySelector("script, failure")).toBeNull();
    const disclosures = [...target.root.querySelectorAll<HTMLDetailsElement>("details")].filter((details) => details.querySelector("summary")?.textContent === "Technical details");
    expect(disclosures).toHaveLength(2);
    const runDetails = disclosures.find((details) => details.textContent.includes(execution.id));
    if (!runDetails) throw new Error("Missing execution technical disclosure");
    expect(runDetails.open).toBe(false);
    runDetails.open = true;
    for (const value of [task.projectId, task.workspaceId, task.schedule.expression, task.timezone, execution.sessionId, "Diagnostic <failure>"]) {
      expect(runDetails.textContent).toContain(value);
    }
    await vi.waitFor(() => { expect(button(target.root, "Next").disabled).toBe(false); });
    expect(button(target.root, "Previous").disabled).toBe(true);
    button(target.root, "Next").click();
    await vi.waitFor(() => { expect(target.request).toHaveBeenCalledWith("history", { taskId: "task", limit: 20, offset: 20 }, expect.anything()); });
    await vi.waitFor(() => { expect(button(target.root, "Refresh").disabled).toBe(false); });
    button(target.root, "Previous").click();
    await vi.waitFor(() => { expect(target.request.mock.calls.at(-1)?.[1]).toEqual({ taskId: "task", limit: 20, offset: 0 }); });
    await vi.waitFor(() => { expect(button(target.root, "Refresh").disabled).toBe(false); });
    target.request.mockImplementation((operation) => Promise.resolve(operation === "overview"
      ? { tasks: [{ ...task, latestExecution: { ...execution, status: "completed", latestReport: { summary: "Corrected result" } } }] }
      : { executions: [{ ...execution, status: "completed", latestReport: { summary: "Corrected result" } }], nextOffset: null }));
    button(target.root, "Refresh").click();
    await vi.waitFor(() => { expect(target.root.querySelector('.history-entry [data-status="completed"]')).not.toBeNull(); });
    expect(target.root.querySelector(".history-entry .summary")?.textContent).toBe("Corrected result");
    expect(target.root.querySelector(".pages")).toBeNull();
    expect(target.request.mock.calls.every(([operation]) => ["overview", "history"].includes(operation))).toBe(true);
  });
  it("opens global history on demand and returns to the overview without loading history again", async () => {
    const target = setup(); await ready(target);
    button(target.root, "All history").click();
    await vi.waitFor(() => { expect(target.request).toHaveBeenCalledWith("history", { limit: 20, offset: 0 }, expect.anything()); });
    await vi.waitFor(() => { expect(target.root.querySelector(".history-entry")).not.toBeNull(); });
    expect(target.root.querySelector(".history-entry h3")?.textContent).toBe(task.name);
    const historyCalls = target.request.mock.calls.filter(([operation]) => operation === "history").length;
    button(target.root, "Overview").click();
    await vi.waitFor(() => { expect(target.root.querySelector('[aria-labelledby="awaiting-title"]')).not.toBeNull(); });
    expect(target.root.querySelector(".history-entry")).toBeNull();
    expect(target.request.mock.calls.at(-1)?.[0]).toBe("overview");
    expect(target.request.mock.calls.filter(([operation]) => operation === "history")).toHaveLength(historyCalls);
  });
  it("ignores an obsolete overview refresh after opening task details", async () => {
    const target = setup(); await ready(target);
    const stale = deferred();
    target.request.mockImplementationOnce(() => stale.promise);
    button(target.root, "Refresh").click();
    const staleSignal = target.request.mock.calls.at(-1)?.[2]?.signal;
    button(target.root, `View task: ${task.name}`).click();
    await vi.waitFor(() => { expect(target.root.querySelector(".history-entry")).not.toBeNull(); });
    expect(staleSignal?.aborted).toBe(true);
    stale.resolve({ tasks: [{ ...task, name: "Obsolete task", latestExecution: execution }] });
    await stale.promise; await target.element.updateComplete;
    expect(target.root.querySelector(".view-title")?.textContent).toBe(task.name);
    expect(target.root.textContent).not.toContain("Obsolete task");
    expect(target.root.querySelector(".history-entry")).not.toBeNull();
  });
  it("ignores late history failures after returning to the overview", async () => {
    const target = setup(); await ready(target);
    const stale = deferred();
    target.request.mockImplementation((operation) => operation === "overview"
      ? Promise.resolve({ tasks: [{ ...task, latestExecution: execution }] }) : stale.promise);
    button(target.root, `View task: ${task.name}`).click();
    await target.element.updateComplete;
    const historySignal = target.request.mock.calls.find(([operation]) => operation === "history")?.[2]?.signal;
    button(target.root, "Overview").click();
    await vi.waitFor(() => { expect(button(target.root, "Refresh").disabled).toBe(false); });
    expect(historySignal?.aborted).toBe(true);
    stale.reject(new Error("Obsolete history failure"));
    await stale.promise.catch(() => undefined); await target.element.updateComplete;
    expect(target.root.querySelector('[role="alert"]')).toBeNull();
    expect(target.root.querySelector(".history-entry")).toBeNull();
    expect(button(target.root, `View task: ${task.name}`)).toBeDefined();
  });
  it("keeps conversation navigation failures visible without losing the stored recovery identity", async () => {
    const target = setup(); await ready(target);
    button(target.root, `View task: ${task.name}`).click();
    await vi.waitFor(() => { expect(target.root.querySelector(".history-entry")).not.toBeNull(); });
    target.navigate.mockRejectedValueOnce(new Error("Missing conversation"));
    button(target.root, "Open conversation").click();
    await vi.waitFor(() => { expect(target.root.querySelector('[role="alert"]')).not.toBeNull(); });
    expect(target.root.querySelector(".history-entry details")?.textContent).toContain(execution.sessionId);
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
    expect(target.request).toHaveBeenCalledTimes(1);
    target.lifetime.abort();
    expect(target.request.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
  });
});
