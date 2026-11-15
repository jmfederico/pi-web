// @vitest-environment happy-dom
import { html, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonValue, PluginPeerRequestOptions, TranscriptToolRendererInput } from "@jmfederico/pi-web/plugin-api";
import { stylesheetIntegrationCapability } from "../../../src/client/src/plugins/styles.js";
import { PrivateInputForm } from "./form.js";
import plugin from "./pi-web-plugin.js";

const record = {
  requestId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", sessionId: "conversation",
  destination: "/outside/workspace/new-token", purpose: "Configure <private> access", status: "waiting",
};
const sentinel = "  private-sentinel-⛄\nsecond line\n";
const cleanup: (() => void)[] = [];
beforeEach(() => {
  // happy-dom exposes CSS via a getter; keep one instance for feature-detection overrides.
  vi.stubGlobal("CSS", CSS);
  vi.spyOn(CSS, "supports").mockReturnValue(true);
});
afterEach(() => {
  cleanup.splice(0).forEach((dispose) => { dispose(); });
  document.body.replaceChildren(); localStorage.clear(); sessionStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
function setup(request = vi.fn<(operation: string, input: JsonValue, options?: PluginPeerRequestOptions) => Promise<JsonValue>>(
  () => Promise.resolve({ record, active: false }),
)) {
  const lifetime = new AbortController();
  const activation = plugin.activate({ apiVersion: 5, pluginId: "private-input", runtimePluginId: "private-input",
    signal: lifetime.signal, lifetimeSignal: lifetime.signal, html, svg: html });
  activation.start({ signal: lifetime.signal, capabilities: { resolve: (token) => token.parse(stylesheetIntegrationCapability) } });
  const contribution = activation.contributions.transcriptRenderers[0];
  const renderer = contribution?.resolve("request_private_input", () => undefined);
  if (!renderer) throw new Error("Missing renderer");
  const forScope = vi.fn(() => ({ request }));
  const context: TranscriptToolRendererInput = {
    scope: { machineId: "origin", projectId: "project", workspaceId: "workspace", sessionId: record.sessionId },
    entry: { toolName: "request_private_input", status: "success", details: { privateInput: record } },
    signal: lifetime.signal, fail: vi.fn(), backend: { machineId: "origin", forScope },
  };
  const container = document.createElement("div"); document.body.append(container);
  render(renderer.render(context), container);
  const element = container.querySelector("pi-web-private-input");
  if (!(element instanceof PrivateInputForm)) throw new Error("Missing form");
  cleanup.push(() => { lifetime.abort(); render(html``, container); });
  return { element, request, forScope, context, lifetime, renderer };
}
function root(target: ReturnType<typeof setup>): ShadowRoot {
  if (!target.element.shadowRoot) throw new Error("Missing shadow root");
  return target.element.shadowRoot;
}
function button(target: ReturnType<typeof setup>, name: string): HTMLButtonElement {
  const control = [...root(target).querySelectorAll("button")].find((node) => (node.getAttribute("aria-label") ?? node.textContent.trim()) === name);
  if (!control) throw new Error(`Missing ${name}`);
  return control;
}
function field(target: ReturnType<typeof setup>): HTMLInputElement | HTMLTextAreaElement {
  const control = root(target).querySelector<HTMLInputElement | HTMLTextAreaElement>(".secret:not([hidden])");
  if (!control) throw new Error("Missing input");
  return control;
}
async function ready(target: ReturnType<typeof setup>): Promise<void> {
  await vi.waitFor(() => { expect(field(target).disabled).toBe(false); });
}
async function format(target: ReturnType<typeof setup>, value: "single-line" | "multiline"): Promise<void> {
  const name = value === "multiline" ? "Use multiline" : "Use single line";
  const control = [...root(target).querySelectorAll("button")].find((node) => node.textContent.trim() === name);
  control?.click();
  await target.element.updateComplete;
}
function submit(target: ReturnType<typeof setup>): void {
  root(target).querySelector("form")?.dispatchEvent(new SubmitEvent("submit", { cancelable: true }));
}

describe("inline private input", () => {
  it("uses Save to confirm the displayed destination and sends exact text only to its backend", async () => {
    const target = setup(); await ready(target);
    expect(target.forScope).toHaveBeenCalledWith({ kind: "workspace", projectId: "project", workspaceId: "workspace" });
    expect(target.request).toHaveBeenCalledExactlyOnceWith("status", { sessionId: record.sessionId, requestId: record.requestId }, expect.anything());
    expect(root(target).textContent).toContain(record.destination);
    expect(root(target).querySelector("private")).toBeNull();
    await format(target, "multiline");
    field(target).value = sentinel;
    expect(target.request).toHaveBeenCalledTimes(1);
    expect(button(target, "Save file").disabled).toBe(false);
    expect(root(target).querySelector('input[type="checkbox"]')).toBeNull();
    expect([...root(target).querySelectorAll("button")].some((node) => node.textContent.trim() === "Check status")).toBe(false);
    let finish!: (value: JsonValue) => void;
    target.request.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    submit(target);
    expect(field(target).value).toBe("");
    expect(target.request).toHaveBeenLastCalledWith("submit", {
      sessionId: record.sessionId, requestId: record.requestId, confirmedDestination: record.destination, secret: sentinel,
    }, expect.anything());
    await target.element.updateComplete;
    expect(root(target).textContent).not.toContain("File saved");
    expect(button(target, "Save file").disabled).toBe(true);
    finish({ record: { ...record, status: "saved" }, delivered: true });
    await vi.waitFor(() => { expect(root(target).querySelector("textarea")).toBeNull(); });
    expect(root(target).textContent).not.toContain(sentinel);
    expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
    expect(target.context.fail).not.toHaveBeenCalled();
  });

  it("clears a rejected submission, suppresses unsafe errors, and recovers status without replay", async () => {
    const target = setup(); await ready(target);
    const log = vi.spyOn(console, "error");
    target.request.mockRejectedValueOnce(new Error(sentinel));
    field(target).value = sentinel; submit(target);
    await vi.waitFor(() => { expect(root(target).querySelector('[role="alert"]')).not.toBeNull(); });
    expect(field(target).value).toBe("");
    expect(button(target, "Save file").disabled).toBe(true);
    expect(root(target).textContent).not.toContain(sentinel);
    expect(log).not.toHaveBeenCalled(); expect(target.context.fail).not.toHaveBeenCalled();
    target.request.mockResolvedValueOnce({ record: { ...record, status: "saved" }, active: false });
    button(target, "Check status").click();
    await vi.waitFor(() => { expect(root(target).querySelector("textarea")).toBeNull(); });
    expect(target.request.mock.calls.map(([operation]) => operation)).toEqual(["status", "submit", "status"]);
    target.request.mockResolvedValueOnce({ record: { ...record, status: "saved" }, delivered: true });
    button(target, "Notify agent").click();
    await vi.waitFor(() => { expect(target.request).toHaveBeenLastCalledWith("notify", {
      sessionId: record.sessionId, requestId: record.requestId,
    }, expect.anything()); });
  });

  it("cancels without forwarding the entered value or leaving recovery controls", async () => {
    const target = setup(); await ready(target);
    field(target).value = sentinel;
    target.request.mockResolvedValueOnce({ record: { ...record, status: "cancelled" }, delivered: true });
    button(target, "Cancel").click();
    expect(field(target).value).toBe("");
    await vi.waitFor(() => { expect(root(target).querySelector("textarea")).toBeNull(); });
    expect(target.request.mock.calls[1]?.slice(0, 2)).toEqual(["cancel", { sessionId: record.sessionId, requestId: record.requestId }]);
    expect(root(target).querySelectorAll("button")).toHaveLength(0);
  });

  it.each(["single-line", "multiline"] as const)("drops %s values on pagehide, removal and signal revocation, and ignores obsolete replies", async (mode) => {
    const target = setup(); await ready(target); await format(target, mode);
    field(target).value = sentinel;
    window.dispatchEvent(new Event("pagehide"));
    expect(field(target).value).toBe("");
    await target.element.updateComplete;
    expect(button(target, "Show secret")).toBeDefined();
    field(target).value = sentinel;
    const retained = field(target);
    target.element.remove();
    expect(retained.value).toBe("");
    document.body.append(target.element); await ready(target); await format(target, mode);
    field(target).value = sentinel;
    let finish!: (value: JsonValue) => void;
    target.request.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    submit(target);
    const signal = target.request.mock.calls.at(-1)?.[2]?.signal;
    target.lifetime.abort(); expect(signal?.aborted).toBe(true);
    expect(field(target).value).toBe("");
    finish({ record: { ...record, status: "saved" }, delivered: true });
    await target.element.updateComplete;
    expect(root(target).textContent).not.toContain("File saved");
  });

  it("offers explicit recovery for interrupted writes, never a second secret submission", async () => {
    const target = setup(vi.fn(() => Promise.resolve({ record: { ...record, status: "writing" }, active: false })));
    await vi.waitFor(() => { expect(button(target, "Report interruption").disabled).toBe(false); });
    expect(root(target).querySelector("textarea")).toBeNull();
    target.request.mockResolvedValueOnce({ record: { ...record, status: "failed", failure: "write_uncertain" }, delivered: true });
    button(target, "Report interruption").click();
    await vi.waitFor(() => { expect(target.request.mock.calls).toHaveLength(2); });
    expect(target.request.mock.calls[1]?.[0]).toBe("notify");
  });

  it("enforces the UTF-8 size limit without sending the value", async () => {
    const target = setup(); await ready(target);
    field(target).value = "⛄".repeat(24_000); submit(target);
    await target.element.updateComplete;
    expect(target.request).toHaveBeenCalledTimes(1);
    expect(root(target).querySelector('[role="alert"]')).not.toBeNull();
  });

  it("keeps values only in the active field and blocks lossy format changes", async () => {
    const target = setup(); await ready(target);
    const password = field(target);
    expect(password).toBeInstanceOf(HTMLInputElement);
    expect(password.type).toBe("password");
    password.value = "  synthetic-one-line  ";
    button(target, "Show secret").click(); await target.element.updateComplete;
    expect(password.type).toBe("text");
    await format(target, "multiline");
    expect(password.value).toBe("");
    expect(field(target).value).toBe("  synthetic-one-line  ");
    expect(button(target, "Show secret")).toBeDefined();
    field(target).value = sentinel;
    await format(target, "single-line");
    expect(button(target, "Use single line")).toBeDefined();
    expect(field(target)).toBeInstanceOf(HTMLTextAreaElement);
    expect(field(target).value).toBe(sentinel);
    expect(password.value).toBe("");
    expect(root(target).querySelector('[role="alert"]')).not.toBeNull();
    field(target).value = "  safe-to-transfer  ";
    const textarea = field(target);
    await format(target, "single-line");
    expect(password.value).toBe("  safe-to-transfer  ");
    expect(password.type).toBe("password");
    expect(textarea.value).toBe("");
  });

  it("requires explicit reveal when multiline masking is unavailable, without a plaintext fallback", async () => {
    vi.mocked(CSS.supports).mockReturnValue(false);
    const target = setup(); await ready(target);
    field(target).value = "synthetic-transfer";
    await format(target, "multiline");
    const textarea = root(target).querySelector("textarea");
    expect(textarea?.hidden).toBe(true);
    expect(textarea?.value).toBe("synthetic-transfer");
    expect(root(target).querySelector(".secret:not([hidden])")).toBeNull();
    button(target, "Show secret").click(); await target.element.updateComplete;
    expect(textarea?.hidden).toBe(false);
    expect(field(target).value).toBe("synthetic-transfer");
    button(target, "Hide secret").click();
    expect(textarea?.hidden).toBe(true);
    target.lifetime.abort();
    expect(textarea?.value).toBe("");
  });

  it("hides revealed values on leaving the tab without changing the value", async () => {
    const target = setup(); await ready(target);
    const password = field(target);
    password.value = "synthetic-secret";
    button(target, "Show secret").click(); await target.element.updateComplete;
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(password.type).toBe("password");
    expect(password.value).toBe("synthetic-secret");
    await target.element.updateComplete;
    expect(button(target, "Show secret")).toBeDefined();
  });

  it("offers status recovery only when needed and preserves an unsent value", async () => {
    const target = setup(vi.fn(() => Promise.resolve({ record, unavailable: true })));
    await ready(target); await format(target, "multiline");
    field(target).value = sentinel;
    target.request.mockResolvedValueOnce({ record });
    button(target, "Check status").click();
    await ready(target);
    expect(field(target).value).toBe(sentinel);
    expect(target.request.mock.calls.map(([operation]) => operation)).toEqual(["status", "status"]);
    expect(JSON.stringify(target.request.mock.calls)).not.toContain("private-sentinel");
    expect([...root(target).querySelectorAll("button")].some((node) => node.textContent.trim() === "Check status")).toBe(false);
  });

  it("declines malformed tool details and fails closed without a paired backend", async () => {
    const target = setup(); await ready(target);
    expect(target.renderer.render({ ...target.context, entry: { ...target.context.entry, details: { privateInput: {} } } })).toBeUndefined();
    const withoutBackend = { ...target.context };
    delete withoutBackend.backend;
    target.element.context = withoutBackend;
    await vi.waitFor(() => { expect(root(target).querySelector('[role="alert"]')).not.toBeNull(); });
    expect(field(target).disabled).toBe(true);
    expect(target.request).toHaveBeenCalledTimes(1);
  });
});
