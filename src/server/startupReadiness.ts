import { networkInterfaces } from "node:os";
import type { FastifyInstance } from "fastify";
import { startupUrlLines } from "./startupUrls.js";

export function reportStartupReadiness(app: FastifyInstance, isTTY: boolean | undefined): void {
  const bound = app.server.address();
  if (bound === null || typeof bound === "string") throw new Error("Expected a bound TCP address after listen");
  if (isTTY === true) {
    console.log(`\n  PI WEB is ready\n\n${startupUrlLines(bound, networkInterfaces()).join("\n")}\n`);
    return;
  }
  app.log.info({ event: "web.ready", address: bound.address, port: bound.port }, "PI WEB is ready");
}
