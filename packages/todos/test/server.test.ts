import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { JsonObject, ServerPluginActivationContext, ServerPluginActivation, ServerPluginTransportV1 } from "@jmfederico/pi-web/server-plugin-api";
import plugin from "../src/server.js";
import { resultTask } from "../src/browser/protocol.js";

const roots: string[] = [];
const activations: ServerPluginActivation[] = [];
afterEach(async () => {
  for (const activation of activations) await activation.dispose?.(new AbortController().signal);
  activations.length = 0;
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.length = 0;
});
async function host(settings: JsonObject): Promise<ServerPluginActivationContext> {
  const directory = await mkdtemp(join(tmpdir(), "todos-host-")); roots.push(directory);
  return {
    apiVersion: 3, pluginId: "todos", packageRoot: directory, dataDirectory: directory,
    settings, logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    execFile: () => Promise.reject(new Error("Not used")),
    signal: new AbortController().signal, lifetimeSignal: new AbortController().signal,
  };
}
it("routes client operations unchanged through public transport and never creates a client database", async () => {
  const authority = await host({ role: "server" });
  const server = await plugin.activate(authority); activations.push(server);
  const backend = server.backend;
  if (backend === undefined) throw new Error("Missing server backend");
  const request = vi.fn<ServerPluginTransportV1["request"]>(async ({ operation, input, signal }) => await backend.request({ operation, input, signal }));
  const clientHost = await host({ role: "client", targetMachineId: "central" });
  const client = await plugin.activate({ ...clientHost, transport: { version: 1, request } }); activations.push(client);
  const signal = new AbortController().signal;
  const task = resultTask(await client.backend?.request({ operation: "mutate", input: { title: "From client" }, signal }));
  expect(request).toHaveBeenCalledWith({ machineId: "central", operation: "mutate", input: { title: "From client" }, signal });
  expect(resultTask(await server.backend?.request({ operation: "read", input: { id: task.id }, signal }))).toEqual(task);
  expect(await readdir(clientHost.dataDirectory)).toEqual([]);
  request.mockRejectedValueOnce(new Error("Remote unavailable"));
  await expect(client.backend?.request({ operation: "list", input: {}, signal })).rejects.toThrow("Remote unavailable");
  expect(await readdir(clientHost.dataDirectory)).toEqual([]);
});
it("requires explicit role and a supported configured remote client target", async () => {
  for (const settings of [{}, { role: "replica" }, { role: "client" }, { role: "client", targetMachineId: "local" }, { role: "client", targetMachineId: "http://example.test" }, { role: "client", targetMachineId: "central" }]) {
    const context = await host(settings);
    await expect(async () => await plugin.activate(context)).rejects.toThrow();
    expect(await readdir(context.dataDirectory)).toEqual([]);
  }
});
it("rejects cancelled operations before writing", async () => {
  const context = await host({ role: "server" });
  const server = await plugin.activate(context); activations.push(server);
  expect(() => server.backend?.request({ operation: "mutate", input: { title: "cancelled" }, signal: AbortSignal.abort() })).toThrow();
  expect(await server.backend?.request({ operation: "list", input: {}, signal: new AbortController().signal })).toEqual({ ok: true, tasks: [] });
});
