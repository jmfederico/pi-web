import { afterEach, describe, expect, it, vi } from "vitest";
import { mcpApi } from "../api";
import { HttpRequestError } from "./http";

const config = { servers: [], errors: [], userConfigPath: "/home/pi/.pi/agent/mcp.json" };
const check = { checkedAt: "now", servers: [], errors: [] };
const workspace = { projectId: "p /?#", workspaceId: "w /?#" };

function stubFetch(body: unknown, status = 200) {
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("MCP API clients", () => {
  it.each([
    { base: "/", machineId: undefined, prefix: "api" },
    { base: "/", machineId: "local", prefix: "api/machines/local" },
    { base: "/team/pi/", machineId: "remote /?#", prefix: "api/machines/remote%20%2F%3F%23" },
  ])("uses application-relative machine and workspace routes ($base, $prefix)", async ({ base, machineId, prefix }) => {
    vi.stubEnv("BASE_URL", base);
    vi.stubGlobal("document", { baseURI: `https://pi.example.test${base}?settings=mcp` });
    const fetchMock = stubFetch(config);

    await expect(mcpApi.list(machineId)).resolves.toEqual(config);
    await mcpApi.setEnabled("catalog /?#", "user", false, machineId);
    await mcpApi.list(machineId, workspace);
    await mcpApi.setEnabled("catalog /?#", "project", true, machineId, workspace);
    await mcpApi.setEnabled("catalog /?#", "user", false, machineId, workspace);

    const root = `https://pi.example.test${base}${prefix}`;
    const scoped = `${root}/projects/p%20%2F%3F%23/workspaces/w%20%2F%3F%23/mcp`;
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${root}/mcp`, `${root}/mcp/servers/catalog%20%2F%3F%23`, scoped,
      `${scoped}/servers/catalog%20%2F%3F%23`, `${scoped}/servers/catalog%20%2F%3F%23`,
    ]);
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe("PUT");
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ enabled: false }));
    expect(fetchMock.mock.calls[3]?.[1]?.body).toBe(JSON.stringify({ scope: "project", enabled: true }));
    expect(fetchMock.mock.calls[4]?.[1]?.body).toBe(JSON.stringify({ scope: "user", enabled: false }));
    expect(new Headers(fetchMock.mock.calls[3]?.[1]?.headers).get("content-type")).toBe("application/json");
  });

  it("posts explicit temporary checks without a credential payload, under a nested deployment", async () => {
    vi.stubEnv("BASE_URL", "./");
    vi.stubGlobal("document", { baseURI: "https://pi.example.test/team/pi/?settings=mcp" });
    const fetchMock = stubFetch(check);

    await expect(mcpApi.check()).resolves.toEqual(check);
    await mcpApi.check("local");
    await mcpApi.check("remote /?#", workspace);

    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method, init?.body])).toEqual([
      ["https://pi.example.test/team/pi/api/mcp/check", "POST", undefined],
      ["https://pi.example.test/team/pi/api/machines/local/mcp/check", "POST", undefined],
      ["https://pi.example.test/team/pi/api/machines/remote%20%2F%3F%23/projects/p%20%2F%3F%23/workspaces/w%20%2F%3F%23/mcp/check", "POST", undefined],
    ]);
  });

  it.each([
    () => mcpApi.list("older"),
    () => mcpApi.setEnabled("catalog", "user", false, "older"),
    () => mcpApi.check("older", workspace),
  ])("preserves a selected-machine 404 without falling back to the gateway", async (request) => {
    vi.stubGlobal("document", { baseURI: "https://pi.example.test/" });
    const fetchMock = stubFetch({ error: "Not found" }, 404);

    await expect(request()).rejects.toBeInstanceOf(HttpRequestError);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toContain("api/machines/older/");
  });

  it("does not turn a mutation failure into a successful config response", async () => {
    vi.stubGlobal("document", { baseURI: "https://pi.example.test/" });
    stubFetch({ error: "Read-only Pi config" }, 403);

    await expect(mcpApi.setEnabled("catalog", "user", false, "local")).rejects.toMatchObject({ status: 403, message: "Read-only Pi config" });
  });
});
