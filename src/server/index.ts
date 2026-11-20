#!/usr/bin/env node
import { effectivePiWebConfig, maxUploadBytes } from "../config.js";
import { buildApp } from "./app.js";
import { reportStartupReadiness } from "./startupReadiness.js";
import { startupLogger } from "./startupLogger.js";

const { config } = effectivePiWebConfig();
const app = await buildApp({ bodyLimit: maxUploadBytes(process.env, config), logger: startupLogger });
let closing: Promise<void> | undefined;
const shutdown = (): void => {
  closing ??= app.close().catch((error: unknown) => {
    app.log.error({ err: error }, "web/API shutdown failed");
    process.exitCode = 1;
  });
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
await app.listen({ port: config.port ?? 8504, host: config.host ?? "127.0.0.1" });
reportStartupReadiness(app, process.stdout.isTTY);
