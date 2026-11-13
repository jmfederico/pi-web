import { afterEach, expect, it, vi } from "vitest";
import { managedMcpApi, parseManagedMcpView } from "./managedMcp";
import { managedMcpView } from "./managedMcp.testSupport";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("uses encoded machine-aware application-relative URLs and sends the revision on updates", async () => {
  vi.stubEnv("BASE_URL", "./");
  vi.stubGlobal("document", { baseURI: "https://example.test/nested/pi/" });
  const view = managedMcpView();
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(view)));
  vi.stubGlobal("fetch", fetch);
  await expect(managedMcpApi.get({ cwd: "/work a/#x", sessionId: "session /?" }, "remote /a")).resolves.toEqual(view);
  expect(fetch.mock.calls[0]?.[0]).toBe("https://example.test/nested/pi/api/machines/remote%20%2Fa/mcp/managed?cwd=%2Fwork+a%2F%23x&sessionId=session+%2F%3F");
  fetch.mockResolvedValue(new Response(JSON.stringify(view)));
  const update = { cwd: "/work a/#x", sessionId: "session /?", scope: "session" as const, serverName: "docs", enabled: true, revision: "revision-1" };
  await managedMcpApi.update(update, "remote /a");
  expect(fetch.mock.calls[1]).toEqual(["https://example.test/nested/pi/api/machines/remote%20%2Fa/mcp/managed", expect.objectContaining({ method: "POST", body: JSON.stringify(update) })]);
  fetch.mockResolvedValue(new Response(JSON.stringify(view)));
  await managedMcpApi.get({});
  expect(fetch.mock.calls[2]?.[0]).toBe("https://example.test/nested/pi/api/machines/local/mcp/managed");
});

it("validates writable flags and optional row states without forwarding definitions or credentials", () => {
  const view = managedMcpView();
  expect(parseManagedMcpView({ ...view, secrets: "hidden", servers: view.servers.map((row) => ({ ...row, command: "hidden" })) })).toEqual(view);
  for (const field of ["globalWritable", "projectWritable", "sessionWritable", "projectTrusted"]) {
    expect(() => parseManagedMcpView({ ...view, [field]: "true" })).toThrow();
  }
  for (const patch of [{ enabled: { global: false, session: "false" } }, { nativeConflict: "false" }, { pending: 1 }, { error: false }, { definitionScope: "session" }]) {
    expect(() => parseManagedMcpView({ ...view, servers: [{ ...view.servers[0], ...patch }] })).toThrow();
  }
  expect(() => parseManagedMcpView({ ...view, revision: undefined })).toThrow();
});
