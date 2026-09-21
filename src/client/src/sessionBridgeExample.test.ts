// @vitest-environment happy-dom
import { html, render, svg } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import plugin from "../../../examples/session-bridge-plugin/src/browser/index.js";
import type { WorkspacePanelContext } from "../../plugin-api.js";
import type { Review } from "../../../examples/session-bridge-plugin/src/browser/protocol.js";

afterEach(() => { document.body.replaceChildren(); });

it("starts, refreshes, selects and cycles text reviews through the selected machine peer", async () => {
  const activation = await plugin.activate({
    apiVersion: 4, pluginId: "example", runtimePluginId: "example", html, svg,
    signal: new AbortController().signal, lifetimeSignal: new AbortController().signal,
  });
  const panel = activation.contributions.workspacePanels?.[0];
  if (!panel) throw new Error("Example panel missing");
  const unused = () => { throw new Error("Unrelated host API must not be called"); };
  const one: Review = { id: "11111111-1111-4111-8111-111111111111", createdAt: "2026-09-01", status: "running", text: "Starting", sessionId: "session-one" };
  const two: Review = { ...one, id: "22222222-2222-4222-8222-222222222222", status: "completed", text: "Second review" };
  const first = vi.fn((operation: string, input: unknown) => {
    if (operation === "start") return Promise.resolve({ ...one });
    if (operation === "list") return Promise.resolve([{ ...one, text: "" }, { ...two, text: "" }]);
    if (operation === "read") return Promise.resolve(input === one.id ? { ...one } : { ...two });
    throw new Error("Unexpected operation");
  });
  const second = vi.fn(() => Promise.reject(new Error("Backend unavailable")));
  let context: WorkspacePanelContext = {
    machine: { id: "remote-a", name: "A", kind: "remote" },
    workspace: { id: "workspace", projectId: "project", path: "/workspace", label: "Workspace", isMain: true },
    state: {},
    files: { readFile: unused, listFiles: unused, writeFile: unused, deleteFile: unused, moveFile: unused },
    prompt: { insertText: unused, getText: unused, getSelection: unused },
    terminal: { open: unused, runCommand: unused },
    peer: { request: first },
    host: { requestRender: () => { render(panel.render(context), document.body); } },
  };
  context.host.requestRender();
  const button = (text: string) => {
    const element = [...document.querySelectorAll("button")].find((button) => button.textContent === text);
    if (!element) throw new Error(`Button missing: ${text}`);
    return element;
  };
  button("Start review").click();
  await vi.waitFor(() => { expect(document.body.textContent).toContain("Review admitted"); });
  expect(first).toHaveBeenCalledWith("start", null);
  expect(button("Start review").disabled).toBe(true);
  one.status = "completed";
  one.text = "<script>not executable</script>\nBug at file.ts:4";
  button("Refresh reviews").click();
  await vi.waitFor(() => { expect(document.querySelector("pre")?.textContent).toBe(one.text); });
  expect(document.querySelector("script")).toBeNull();
  expect(button("Start review").disabled).toBe(false);
  button("Next review").click();
  await vi.waitFor(() => { expect(document.querySelector("pre")?.textContent).toBe(two.text); });
  button("Previous review").click();
  await vi.waitFor(() => { expect(document.querySelector("pre")?.textContent).toBe(one.text); });
  const select = document.querySelector("select");
  if (!select) throw new Error("Missing saved review selector");
  select.value = two.id;
  select.dispatchEvent(new Event("change"));
  await vi.waitFor(() => { expect(document.querySelector("pre")?.textContent).toBe(two.text); });
  expect(document.querySelector('[role="status"]')?.getAttribute("aria-live")).toBe("polite");

  context = { ...context, machine: { id: "remote-b", name: "B", kind: "remote" }, peer: { request: second } };
  context.host.requestRender();
  expect(document.body.textContent).not.toContain("Second review");
  button("Refresh reviews").click();
  await vi.waitFor(() => { expect(document.body.textContent).toContain("Backend unavailable"); });
  expect(second).toHaveBeenCalledWith("list", null);
  context = { ...context };
  delete context.peer;
  context.host.requestRender();
  expect(button("Start review").disabled).toBe(true);
  await activation.dispose?.(new AbortController().signal);
});
