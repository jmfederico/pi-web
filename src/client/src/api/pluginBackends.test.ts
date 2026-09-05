import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLUGIN_BACKEND_RESPONSE_BODY_MAX_BYTES } from "../../../shared/pluginBackendProtocol";
import {
  pluginBackendRequestPath,
  pluginBackendRequestUrl,
  requestPluginBackend,
  type PluginBackendRequestTarget,
} from "./pluginBackends";

const target: PluginBackendRequestTarget = {
  pluginId: "board.tools",
  backendRevision: "server-r1",
  machineId: "remote / one",
  projectId: "project / one",
  workspaceId: "workspace #1",
};

beforeEach(() => {
  vi.stubGlobal("document", { baseURI: "https://pi.example.test/" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("browser plugin backend helper", () => {
  it("builds local and remote application-relative paths with encoded dynamic segments", () => {
    expect(pluginBackendRequestPath({ ...target, machineId: "local" }, "cards.summary")).toBe(
      "api/plugin-backends/board.tools/projects/project%20%2F%20one/workspaces/workspace%20%231/cards.summary",
    );
    expect(pluginBackendRequestPath(target, "cards.summary")).toBe(
      "api/machines/remote%20%2F%20one/plugin-backends/board.tools/projects/project%20%2F%20one/workspaces/workspace%20%231/cards.summary",
    );
  });

  it("resolves the helper exactly once under a nested deployment base", () => {
    expect(pluginBackendRequestUrl(target, "cards.summary", {
      viteBaseUrl: "./",
      documentBaseUrl: "https://pi.example.test/test/ai/",
    })).toBe(
      "https://pi.example.test/test/ai/api/machines/remote%20%2F%20one/plugin-backends/board.tools/projects/project%20%2F%20one/workspaces/workspace%20%231/cards.summary",
    );
  });

  it("sends the active backend revision and private JSON input through the selected machine", async () => {
    const fetchMock = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ counts: { open: 2 }, cursor: "next" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await expect(requestPluginBackend(target, "cards.summary", { cards: ["alpha", "beta"], includeClosed: false }, { signal: controller.signal })).resolves.toEqual({
      counts: { open: 2 },
      cursor: "next",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://pi.example.test/api/machines/remote%20%2F%20one/plugin-backends/board.tools/projects/project%20%2F%20one/workspaces/workspace%20%231/cards.summary");
    expect(init).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: "server-r1", input: { cards: ["alpha", "beta"], includeClosed: false } }),
      signal: controller.signal,
    });
  });

  it("rejects invalid requests and attributed non-success responses consistently", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      error: "Server plugin board.tools does not own this workspace",
      code: "owner-mismatch",
    }), { status: 409, headers: { "content-type": "application/json" } })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(requestPluginBackend(target, "cards.summary", null)).rejects.toThrow("does not own this workspace");
    await expect(requestPluginBackend(target, "Invalid/Operation", null)).rejects.toThrow("operation must match");
    await expect(requestPluginBackend(target, "cards.summary", { invalid: Number.NaN })).rejects.toThrow("finite JSON numbers");
    await expect(requestPluginBackend({ ...target, backendRevision: "" }, "cards.summary", null)).rejects.toThrow("revision must be a non-empty string");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("preserves an attributed caller cancellation instead of wrapping it as transport loss", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, rejectPromise) => {
      init?.signal?.addEventListener("abort", () => {
        const reason: unknown = init.signal?.reason;
        rejectPromise(reason instanceof Error ? reason : new Error("request aborted", { cause: reason }));
      }, { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);
    const pending = requestPluginBackend(target, "cards.summary", null, { signal: controller.signal });

    controller.abort(new DOMException("Panel closed", "AbortError"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError", message: "Panel closed" });
  });

  it("cancels responses that exceed the bounded JSON wire contract", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response("x".repeat(PLUGIN_BACKEND_RESPONSE_BODY_MAX_BYTES + 1), {
      status: 200,
      headers: { "content-length": String(PLUGIN_BACKEND_RESPONSE_BODY_MAX_BYTES + 1) },
    })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(requestPluginBackend(target, "cards.summary", null)).rejects.toThrow("response exceeds");
  });
});
