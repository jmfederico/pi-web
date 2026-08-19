#!/usr/bin/env node
import type { FastifyInstance } from "fastify";
import { effectivePiWebConfig, maxUploadBytes } from "../config.js";
import { buildApp } from "./app.js";
import { loadSafeTunnelBridge } from "./safeTunnel/safeTunnelProductionLoader.js";
import { runWebProcess } from "./webProcessLifecycle.js";

const { config } = effectivePiWebConfig();
const appRef: { current?: FastifyInstance } = {};
const safeTunnel = await loadSafeTunnelBridge(config.safeTunnel, {
  serverAddress: () => appRef.current?.server.address() ?? null,
});
const app = await buildApp({
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
