import Fastify, { type FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerPluginPeerV5 } from "../../server-plugin-api.js";
import { pairedPluginBackendResourceUrl } from "../../client/src/api/pluginBackends.js";
import { SessionDaemonClient } from "../../sessiond/sessionDaemonClient.js";
import { RemoteMachineClient } from "../machines/machineClient.js";
import { registerMachineProxyRoutes } from "../machines/machineProxyRoutes.js";
import { registerPluginBackendResourceRoutes } from "../sessiond/pluginBackendResourceRoutes.js";
import { PluginBackendRegistry } from "./pluginBackendRegistry.js";
import { registerPluginBackendResourceProxyRoutes } from "./pluginBackendResourceProxyRoutes.js";

const servers: FastifyInstance[] = [];
const registries: PluginBackendRegistry[] = [];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function serve(app: FastifyInstance): Promise<string> {
  servers.push(app);
  return app.listen({ host: "127.0.0.1", port: 0 });
}

async function resourceChain(resource: NonNullable<ServerPluginPeerV5["resource"]>) {
  const registry = new PluginBackendRegistry({
    contributions: [{
      pluginId: "reports", pluginName: "Reports", apiVersion: 5,
      packageRoot: "/plugins/reports", source: "fixture", scope: "local", moduleRevision: "r1",
      backend: { resource },
    }],
    workspaces: { lookup: () => { throw new Error("Machine resources must not resolve a workspace"); } },
  });
  registries.push(registry);
  const daemon = Fastify({ forceCloseConnections: true });
  registerPluginBackendResourceRoutes(daemon, {
    projects: { requireProject: () => { throw new Error("Machine resources must not resolve a project"); } },
    backends: registry,
  });
  const daemonUrl = await serve(daemon);
  const target = Fastify({ forceCloseConnections: true });
  registerPluginBackendResourceProxyRoutes(target, new SessionDaemonClient({ baseUrl: daemonUrl }), "/nested/api");
  const targetUrl = await serve(target);
  // Model the deployment proxy stripping its application prefix before routing.
  const gateway = Fastify({
    forceCloseConnections: true,
    rewriteUrl: (request) => request.url?.replace(/^\/app\//u, "/") ?? "/",
  });
  await gateway.register(fastifyWebsocket);
  registerMachineProxyRoutes(gateway, {
    remoteClient: (machineId) => Promise.resolve(machineId === "target" ? new RemoteMachineClient({ baseUrl: `${targetUrl}/nested` }) : undefined),
    invalidateReportedName: () => undefined,
  });
  const gatewayUrl = await serve(gateway);
  return {
    url: (operation: string) => pairedPluginBackendResourceUrl(
      { pluginId: "reports", backendRevision: "r1", machineId: "target", scope: "machine" },
      operation, { artifact: "résumé?#" },
      { documentBaseUrl: `${gatewayUrl}/app/`, viteBaseUrl: "./" },
    ),
  };
}

afterEach(async () => {
  for (const server of servers.splice(0).reverse()) await server.close();
  for (const registry of registries.splice(0)) await registry.closeAll();
});

describe("plugin resources across real HTTP hops", () => {
  it("delivers exact bytes and plugin-managed ranges through nested remote deployments", async () => {
    const bytes = new Uint8Array([0, 255, 128, 13, 10, 0, 254]);
    const chain = await resourceChain(({ operation, input, scope, range }) => {
      expect(input).toEqual({ artifact: "résumé?#" });
      expect(scope).toEqual({ kind: "machine" });
      if (operation === "partial") {
        expect(range).toBe("bytes=2-4");
        return { body: bytes.subarray(2, 5), contentType: "audio/wav", statusCode: 206, contentRange: "bytes 2-4/7", contentLength: 3, acceptRanges: "bytes" };
      }
      return { body: bytes, contentType: "application/octet-stream", contentLength: bytes.byteLength };
    });
    const whole = await fetch(chain.url("whole"));
    expect(whole.status).toBe(200);
    expect(new Uint8Array(await whole.arrayBuffer())).toEqual(bytes);
    expect(whole.headers.get("cache-control")).toBe("no-store");
    expect(whole.headers.get("x-content-type-options")).toBe("nosniff");
    expect(whole.headers.get("content-security-policy")).toContain("sandbox");
    const partial = await fetch(chain.url("partial"), { headers: { range: "bytes=2-4" } });
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-range")).toBe("bytes 2-4/7");
    expect(partial.headers.get("accept-ranges")).toBe("bytes");
    expect(new Uint8Array(await partial.arrayBuffer())).toEqual(bytes.subarray(2, 5));
    const stale = await fetch(chain.url("whole").replace("revision=r1", "revision=old"));
    expect(stale.status).toBe(409);
  });

  it("propagates a browser disconnect back to the plugin's streaming callback", async () => {
    const aborted = deferred();
    const cleanedUp = deferred();
    const chain = await resourceChain(({ signal }) => ({
      contentType: "application/octet-stream",
      body: (async function* () {
        try {
          yield new Uint8Array([0, 255]);
          await new Promise<void>((resolve) => {
            const abort = () => { aborted.resolve(); resolve(); };
            if (signal.aborted) abort();
            else signal.addEventListener("abort", abort, { once: true });
          });
          signal.throwIfAborted();
        } finally { cleanedUp.resolve(); }
      })(),
    }));
    const response = await fetch(chain.url("stream"));
    if (response.body === null) throw new Error("Missing resource response body");
    const reader = response.body.getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array([0, 255]));
    await reader.cancel();
    await aborted.promise;
    await cleanedUp.promise;
  }, 10_000);
});
