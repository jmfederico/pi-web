import { expect, it, vi } from "vitest";
import { managedMcpApi, parseManagedMcpView } from "./managedMcp";
import { managedMcpView } from "./managedMcp.testSupport";

it("uses captured backend IDs, never sends display paths, and includes the revision", async () => {
  const view = managedMcpView();
  const request = vi.fn().mockResolvedValue(view);
  const backend = { machineId: "remote", forScope: vi.fn(() => ({ request })) };
  const context = { machineId: "remote", projectId: "project /?", workspaceId: "workspace /?", cwd: "/display only", sessionId: "session /?" };
  const signal = new AbortController().signal;
  await expect(managedMcpApi.get(backend, context, signal)).resolves.toEqual(view);
  expect(backend.forScope).toHaveBeenLastCalledWith({ kind: "workspace", projectId: context.projectId, workspaceId: context.workspaceId });
  expect(request).toHaveBeenLastCalledWith("view", { sessionId: context.sessionId }, { signal });
  const update = { scope: "session" as const, serverName: "docs", enabled: true, revision: "revision-1" };
  const extraFields = { ...update, cwd: "/not authority" };
  await managedMcpApi.update(backend, context, extraFields, signal);
  expect(request).toHaveBeenLastCalledWith("update", { ...update, sessionId: context.sessionId }, { signal });
  await managedMcpApi.get(backend, { machineId: "remote" }, signal);
  expect(backend.forScope).toHaveBeenLastCalledWith({ kind: "machine" });
  expect(request).toHaveBeenLastCalledWith("view", {}, { signal });
  await expect(managedMcpApi.get(backend, { machineId: "other" }, signal)).rejects.toThrow("unavailable");
  await expect(managedMcpApi.get(undefined, context, signal)).rejects.toThrow("unavailable");
  expect(request).toHaveBeenCalledTimes(3);
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
