// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { render } from "lit";
import { initialAppState } from "../../appState";
import type { SessionStatus } from "../../api";
import type { ApplicationPanelContext } from "../types";
import { createCoreNoticesPanel, sessionNotices } from "./notices";
import type { ChatSessionWarningRow } from "../../components/chat/SessionWarnings";

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected notices fixture value");
  return value;
}
function stateWithSession() {
  const state = initialAppState();
  state.selectedSession = { id: "session", cwd: "/work", path: "/session.jsonl", created: "", modified: "", messageCount: 0, firstMessage: "" };
  state.status = { sessionId: "session", isStreaming: false, isCompacting: false, isBashRunning: false,
    pendingMessageCount: 0, queuedMessages: [], cost: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } satisfies SessionStatus;
  return state;
}
function context(state = stateWithSession()): ApplicationPanelContext {
  return { state, machine: { id: "local", name: "Local", kind: "local" },
    navigate: vi.fn(), prompt: { insertText: vi.fn(), getText: () => "", getSelection: () => null }, host: { requestRender: vi.fn() } };
}
afterEach(() => {
  document.body.replaceChildren(); localStorage.clear(); window.history.replaceState(null, "", "/");
});

it("takes conditions only from the selected session's matching status", () => {
  const state = stateWithSession();
  const warnings = [{ severity: "warning" as const, message: "Diagnostic" }];
  state.status = { ...required(state.status), warnings };
  expect(sessionNotices(state)).toEqual(warnings);
  expect(sessionNotices({ ...state, status: { ...state.status, sessionId: "previous" } })).toEqual([]);
  expect(sessionNotices({ ...state, selectedSession: undefined })).toEqual([]);
  expect(sessionNotices({ ...state, status: undefined })).toEqual([]);
});

it("adds the opt-in DEV preview without changing actual session conditions", () => {
  const state = stateWithSession();
  const actual = { severity: "info" as const, message: "Actual" };
  state.status = { ...required(state.status), warnings: [actual] };
  const status = state.status;
  window.history.replaceState(null, "", "?previewWarning=1");
  const preview = sessionNotices(state);
  expect(preview).toHaveLength(2);
  expect(preview[0]).toEqual(actual);
  expect(preview[1]).toMatchObject({ source: "preview" });
  expect(state.status).toBe(status);
  expect(status.warnings).toEqual([actual]);
});

it.each([false, true])("adds application notices and actions independently of session selection (session=%s)", async (withSession) => {
  const ctx = context(withSession ? stateWithSession() : initialAppState());
  if (ctx.state.status) ctx.state.status = { ...ctx.state.status, warnings: [{ severity: "error", message: "Session diagnostic" }] };
  const run = vi.fn();
  let notices: readonly ChatSessionWarningRow[] = [{
    id: "application-condition", severity: "warning", severityClass: "session-warning warning",
    message: "Application diagnostic", source: "Application", action: { label: "Resolve condition", run },
  }];
  const panel = createCoreNoticesPanel(() => notices);
  expect(ctx.state.selectedWorkspace).toBeUndefined();
  expect(panel.visible?.(ctx)).toBe(true);
  expect(panel.badge?.(ctx)).toBe(withSession ? 2 : 1);
  const container = document.createElement("div");
  document.body.append(container);
  render(panel.render(ctx), container);
  const element = required(document.querySelector("session-notices-panel"));
  await element.updateComplete;
  const root = required(element.shadowRoot);
  expect(root.textContent).toContain("Application diagnostic");
  expect(root.textContent.includes("Session diagnostic")).toBe(withSession);
  const action = required([...root.querySelectorAll("button")].find((button) => button.textContent.trim() === "Resolve condition"));
  expect(root.querySelector(".session-warning-dismiss")).toBeNull();
  action.click();
  expect(run).toHaveBeenCalledOnce();
  expect(root.textContent).toContain("Application diagnostic");

  // Invoking an action does not resolve a condition. Its authoritative source
  // must change, and the same panel getter must reflect that updated source.
  notices = [];
  expect(panel.visible?.(ctx)).toBe(withSession);
  expect(panel.badge?.(ctx)).toBe(withSession ? 1 : undefined);
  render(panel.render(ctx), container);
  await element.updateComplete;
  expect(root.textContent).not.toContain("Application diagnostic");
  expect(root.textContent.includes("Session diagnostic")).toBe(withSession);
});

it("wires condition availability, count and current context into the panel contribution", async () => {
  const panel = createCoreNoticesPanel();
  const ctx = context();
  // This local ID is persisted in qualified routes and pin preferences as core:notices.
  expect(panel.id).toBe("notices");
  expect(panel.visible?.(ctx)).toBe(false); expect(panel.badge?.(ctx)).toBeUndefined();
  ctx.state.status = { ...required(ctx.state.status), warnings: [{ severity: "error", message: "Current" }] };
  expect(panel.visible?.(ctx)).toBe(true); expect(panel.badge?.(ctx)).toBe(1);
  const container = document.createElement("div");
  document.body.append(container);
  render(panel.render(ctx), container);
  const element = required(document.querySelector("session-notices-panel"));
  await element.updateComplete;
  expect(element.status).toBe(ctx.state.status);
  expect(element.machineId).toBe(ctx.machine.id);
});
