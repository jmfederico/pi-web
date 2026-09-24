#!/usr/bin/env node
import type { FastifyInstance } from "fastify";
import { effectivePiWebConfig, maxUploadBytes } from "../config.js";
import { buildApp } from "./app.js";
import { resolveClientServing } from "./clientServing.js";
import { loadSafeTunnelBridge } from "./safeTunnel/safeTunnelProductionLoader.js";
import { runWebProcess } from "./webProcessLifecycle.js";

const { config } = effectivePiWebConfig();
// Explicit startup serving-mode decision: development stacks declare the Vite
// browser entrypoint through PI_WEB_BROWSER_URL; packaged/server runs serve the
// built client from the API listener and double as the browser entrypoint.
const clientServing = resolveClientServing();
const appRef: { current?: FastifyInstance } = {};
const safeTunnel = await loadSafeTunnelBridge(config.safeTunnel, {
  serverAddress: () => appRef.current?.server.address() ?? null,
  ...(clientServing.mode === "dev" ? { localBrowserEntrypointUrl: clientServing.browserEntrypointUrl } : {}),
});
const app = await buildApp({
  clientServing,
  bodyLimit: maxUploadBytes(process.env, config),
  ...(safeTunnel === undefined
    ? {}
    : {
        safeTunnel,
        safeTunnelMutationHosts: {
          listenerHost: config.host ?? "127.0.0.1",
          ...(config.allowedHosts === undefined
            ? {}
            : { allowedHosts: config.allowedHosts }),
        },
      }),
});
appRef.current = app;
await runWebProcess(app, {
  port: config.port ?? 8504,
  host: config.host ?? "127.0.0.1",
});
