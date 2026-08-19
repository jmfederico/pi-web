import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLUGIN_BACKEND_BINARY_BODY_MAX_BYTES, PLUGIN_BACKEND_RESPONSE_BODY_MAX_BYTES } from "../../../shared/pluginBackendProtocol";
import {
  pluginBackendBinaryRequestPath,
  pluginBackendRequestPath,
  pluginBackendRequestUrl,
  requestPluginBackend,
  requestPluginBackendBinary,
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

    await expect(requestPluginBackend(target, "cards.summary", { cards: ["alpha", "beta"], includeClosed: false })).resolves.toEqual({
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

  it("cancels responses that exceed the bounded JSON wire contract", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response("x".repeat(PLUGIN_BACKEND_RESPONSE_BODY_MAX_BYTES + 1), {
      status: 200,
      headers: { "content-length": String(PLUGIN_BACKEND_RESPONSE_BODY_MAX_BYTES + 1) },
    })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(requestPluginBackend(target, "cards.summary", null)).rejects.toThrow("response exceeds");
  });
});

describe("browser plugin backend binary helper", () => {
  it("builds the binary sibling path with encoded dynamic segments", () => {
    expect(pluginBackendBinaryRequestPath({ ...target, machineId: "local" }, "secrets.store")).toBe(
      "api/plugin-backends/board.tools/projects/project%20%2F%20one/workspaces/workspace%20%231/secrets.store/binary",
    );
    expect(pluginBackendBinaryRequestPath(target, "secrets.store")).toBe(
      "api/machines/remote%20%2F%20one/plugin-backends/board.tools/projects/project%20%2F%20one/workspaces/workspace%20%231/secrets.store/binary",
    );
  });

  it("sends the raw bytes and revision header through the selected machine", async () => {
    const fetchMock = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ stored: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(requestPluginBackendBinary(target, "secrets.store", new Uint8Array([0x00, 0xff, 0x73]))).resolves.toEqual({ stored: true });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://pi.example.test/api/machines/remote%20%2F%20one/plugin-backends/board.tools/projects/project%20%2F%20one/workspaces/workspace%20%231/secrets.store/binary");
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-pi-web-plugin-backend-revision": "server-r1",
      },
    });
    const body = init?.body;
    if (!(body instanceof ArrayBuffer)) throw new Error("Expected binary request body");
    expect(Array.from(new Uint8Array(body))).toEqual([0x00, 0xff, 0x73]);
  });

  it("rejects over-cap payloads before any fetch and maps attributed failures", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      error: "Server plugin board.tools does not provide binary workspace backend operations",
      code: "operation-unavailable",
    }), { status: 501, headers: { "content-type": "application/json" } })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(requestPluginBackendBinary(target, "secrets.store", new Uint8Array(PLUGIN_BACKEND_BINARY_BODY_MAX_BYTES + 1)))
      .rejects.toThrow("byte wire limit");
    await expect(requestPluginBackendBinary(target, "Invalid/Operation", new Uint8Array([0x01]))).rejects.toThrow("operation must match");
    await expect(requestPluginBackendBinary(target, "secrets.store", new Uint8Array([0x01]))).rejects.toThrow("binary workspace backend operations");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
