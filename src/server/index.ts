import { effectivePiWebConfig } from "../config.js";
import { buildApp } from "./app.js";

const app = await buildApp();
const { config } = effectivePiWebConfig();
await app.listen({ port: config.port ?? 8504, host: config.host ?? "127.0.0.1" });
