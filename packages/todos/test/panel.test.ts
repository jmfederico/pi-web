// @vitest-environment happy-dom
import { html, svg, render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import plugin from "../src/browser/index.js";
import { TodosPanel } from "../src/browser/panel.js";
import type { ApplicationPanelContext, PluginBackend, PluginProjects } from "@jmfederico/pi-web/plugin-api";
import { isRecord, type Task } from "../src/browser/protocol.js";

const lifetimes: AbortController[] = [];
afterEach(() => {
  document.body.replaceChildren(); localStorage.clear();
  for (const lifetime of lifetimes) lifetime.abort(); lifetimes.length = 0;
});
const first: Task = { id: "task-1", revision: 1, title: "Safe <title>", context: "Use SQLite", status: "Open", archived: false, project: null, createdAt: "today", updatedAt: "today" };
async function mount(backend: PluginBackend, projects?: PluginProjects): Promise<TodosPanel> {
  const lifetime = new AbortController(); lifetimes.push(lifetime);
  const activation = await plugin.activate({ apiVersion: 4, pluginId: "todos", runtimePluginId: "todos", html, svg, signal: new AbortController().signal, lifetimeSignal: lifetime.signal });
  const panel = activation.contributions.applicationPanels?.[0];
  if (panel === undefined) throw new Error("Missing application tab");
  const context: ApplicationPanelContext = { machine: { id: "local", name: "Client", kind: "local" }, state: {}, backend, ...(projects === undefined ? {} : { projects }), navigate: () => Promise.resolve(),
    prompt: { getText: () => "", getSelection: () => null, insertText: () => undefined }, host: { requestRender: () => undefined } };
  const container = document.createElement("div"); document.body.append(container);
  render(panel.render(context), container);
  const element = document.querySelector("pi-todos-panel");
  if (!(element instanceof TodosPanel)) throw new Error("Missing mounted panel");
  await vi.waitFor(() => { expect(element.textContent).not.toContain("Loading…"); });
  return element;
}
function input<T extends HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(element: HTMLElement, label: string, constructor: new() => T): T {
  const control = [...element.querySelectorAll("label")].find((entry) => entry.firstChild?.textContent?.trim() === label)?.lastElementChild;
  if (!(control instanceof constructor)) throw new Error(`Missing control: ${label}`);
  return control;
}
function click(element: HTMLElement, label: string): void {
  const button = [...element.querySelectorAll("button")].find((entry) => entry.textContent === label);
  if (button === undefined) throw new Error(`Missing button: ${label}`);
  button.click();
}
it("mounts the real application tab without selection, creates, edits and filters through its backend", async () => {
  const request = vi.fn<PluginBackend["request"]>().mockResolvedValue({ ok: true, tasks: [] });
  const panel = await mount({ version: 1, request });
  expect(panel.textContent).toContain("No tasks match.");
  input(panel, "Title", HTMLInputElement).value = first.title;
  input(panel, "Context", HTMLTextAreaElement).value = first.context;
  request.mockResolvedValueOnce({ ok: true, task: first }).mockResolvedValueOnce({ ok: true, tasks: [first] });
  click(panel, "Save");
  await vi.waitFor(() => { expect(panel.textContent).toContain(first.title); });
  expect(request).toHaveBeenCalledWith("mutate", { title: first.title, context: first.context, status: "Open", archived: false, project: null }, expect.anything());
  expect(panel.querySelector("title")).toBeNull(); // Task text is never interpreted as markup.
  click(panel, "Edit");
  input(panel, "Status", HTMLSelectElement).value = "Doing";
  input(panel, "Archived", HTMLInputElement).checked = true;
  request.mockResolvedValueOnce({ ok: true, task: { ...first, status: "Doing", archived: true, revision: 2 } }).mockResolvedValueOnce({ ok: true, tasks: [] });
  click(panel, "Save");
  await vi.waitFor(() => { expect(panel.textContent).toContain("No tasks match."); });
  expect(request).toHaveBeenCalledWith("mutate", { id: first.id, revision: 1, title: first.title, context: first.context, status: "Doing", archived: true, project: null }, expect.anything());
  input(panel, "Search title/context", HTMLInputElement).value = "SQLite";
  input(panel, "Filter status", HTMLSelectElement).value = "Doing";
  input(panel, "Archived filter", HTMLSelectElement).value = "all";
  click(panel, "Refresh");
  await vi.waitFor(() => { expect(request).toHaveBeenLastCalledWith("list", { text: "SQLite", status: "Doing", archived: "all" }, expect.anything()); });
});
it("assigns a registered local directory, filters by resolved ID/unassigned, and restores an assignment to unassigned", async () => {
  const project = { id: `git:${"a".repeat(64)}`, label: "Repo", kind: "git" } as const;
  let tasks: Task[] = [];
  const request = vi.fn<PluginBackend["request"]>((operation, value) => {
    if (operation === "resolve-project") return Promise.resolve({ ok: true, project });
    if (operation === "mutate") {
      if (!isRecord(value)) throw new Error("Invalid test mutation");
      const assigned = { ...first, project: value["project"] === null ? null : project };
      tasks = [assigned]; return Promise.resolve({ ok: true, task: assigned });
    }
    return Promise.resolve({ ok: true, tasks });
  });
  const panel = await mount({ version: 1, request }, { machineId: "local", listProjects: () => Promise.resolve([{ id: "registered", name: "Checkout", path: "/clone" }]), suggestDirectories: () => Promise.resolve([]) });
  input(panel, "Title", HTMLInputElement).value = first.title;
  input(panel, "Project", HTMLSelectElement).value = "path:/clone";
  click(panel, "Save");
  await vi.waitFor(() => { expect(panel.textContent).toContain("Repo (shared Git)"); });
  expect(request).toHaveBeenCalledWith("resolve-project", { path: "/clone" }, expect.anything());
  expect(request).toHaveBeenCalledWith("mutate", expect.objectContaining({ project }), expect.anything());
  input(panel, "Filter project", HTMLSelectElement).value = "path:/clone";
  click(panel, "Refresh");
  await vi.waitFor(() => { expect(request).toHaveBeenLastCalledWith("list", expect.objectContaining({ project: project.id }), expect.anything()); });
  click(panel, "Edit");
  expect(input(panel, "Project", HTMLSelectElement).value).toBe(project.id);
  input(panel, "Project", HTMLSelectElement).value = "";
  click(panel, "Save");
  await vi.waitFor(() => { expect(request).toHaveBeenCalledWith("mutate", expect.objectContaining({ id: first.id, revision: 1, project: null }), expect.anything()); });
  await vi.waitFor(() => { expect(input(panel, "Project", HTMLSelectElement).disabled).toBe(false); });
  input(panel, "Filter project", HTMLSelectElement).value = "unassigned";
  click(panel, "Refresh");
  await vi.waitFor(() => { expect(request).toHaveBeenLastCalledWith("list", expect.objectContaining({ project: null }), expect.anything()); });
});
it("retains the draft when local resolution fails and never sends a task mutation", async () => {
  const request = vi.fn<PluginBackend["request"]>().mockResolvedValue({ ok: true, tasks: [] });
  const panel = await mount({ version: 1, request }, { machineId: "local", listProjects: () => Promise.resolve([{ id: "registered", name: "Checkout", path: "/gone" }]), suggestDirectories: () => Promise.resolve([]) });
  input(panel, "Title", HTMLInputElement).value = "Keep my draft";
  input(panel, "Project", HTMLSelectElement).value = "path:/gone";
  request.mockRejectedValueOnce(new Error("Directory missing"));
  click(panel, "Save");
  await vi.waitFor(() => { expect(panel.textContent).toContain("Directory missing"); });
  expect(input(panel, "Title", HTMLInputElement).value).toBe("Keep my draft");
  expect(input(panel, "Project", HTMLSelectElement).value).toBe("path:/gone");
  expect(request.mock.calls.some(([operation]) => operation === "mutate")).toBe(false);
});
it("retains a foreign local descriptor without resolving it on the current machine", async () => {
  const project = { id: `local:12345678-1234-1234-1234-123456789012:${"b".repeat(64)}`, label: "Other machine", kind: "local" } as const;
  const request = vi.fn<PluginBackend["request"]>().mockResolvedValue({ ok: true, tasks: [{ ...first, project }] });
  const panel = await mount({ version: 1, request });
  click(panel, "Edit");
  request.mockResolvedValueOnce({ ok: true, task: { ...first, project, revision: 2 } }).mockResolvedValueOnce({ ok: true, tasks: [] });
  click(panel, "Save");
  await vi.waitFor(() => { expect(panel.textContent).toContain("No tasks match."); });
  expect(request).toHaveBeenCalledWith("mutate", expect.objectContaining({ project }), expect.anything());
  expect(request.mock.calls.some(([operation]) => operation === "resolve-project")).toBe(false);
});
it("keeps a stale draft and its revision on conflict; does not retry or silently rebase", async () => {
  const request = vi.fn<PluginBackend["request"]>().mockResolvedValue({ ok: true, tasks: [first] });
  const panel = await mount({ version: 1, request });
  click(panel, "Edit");
  input(panel, "Title", HTMLInputElement).value = "Unsaved draft";
  request.mockResolvedValueOnce({ ok: false, error: { code: "conflict", message: "Task changed; no changes saved" } });
  click(panel, "Save");
  await vi.waitFor(() => { expect(panel.textContent).toContain("Your draft is retained"); });
  expect(input(panel, "Title", HTMLInputElement).value).toBe("Unsaved draft");
  expect(panel.textContent).toContain("revision 1");
  expect(request.mock.calls.filter(([operation]) => operation === "mutate")).toHaveLength(1);
});
it("cancels in-flight panel work on disconnect and ignores late results from an old machine", async () => {
  const request = vi.fn<PluginBackend["request"]>().mockResolvedValue({ ok: true, tasks: [] });
  const panel = await mount({ version: 1, request });
  let resolve: ((value: { ok: true; tasks: Task[] }) => void) | undefined;
  request.mockImplementationOnce(() => new Promise((finish) => { resolve = finish; }));
  click(panel, "Refresh");
  const signal = request.mock.lastCall?.[2]?.signal;
  panel.source = { machineId: "other", backend: { version: 1, request: () => Promise.resolve({ ok: true, tasks: [] }) }, lifetime: new AbortController().signal };
  expect(signal?.aborted).toBe(true);
  resolve?.({ ok: true, tasks: [first] });
  await vi.waitFor(() => { expect(panel.textContent).toContain("No tasks match."); });
  expect(panel.textContent).not.toContain(first.title);
  panel.remove();
});
