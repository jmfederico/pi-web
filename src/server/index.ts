#!/usr/bin/env node
import { effectivePiWebConfig, maxUploadBytes } from "../config.js";
import { buildApp } from "./app.js";

const loaded = effectivePiWebConfig();
const { config } = loaded;
const app = await buildApp({
  bodyLimit: maxUploadBytes(process.env, config),
  resolvedAuth: {
    enabled: config.auth?.enabled ?? false,
    username: config.auth?.username ?? "",
    password: config.auth?.password ?? "",
  },
});
await app.listen({ port: config.port ?? 8504, host: config.host ?? "127.0.0.1" });
