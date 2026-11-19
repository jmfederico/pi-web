import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Mount browser assets, never a general-purpose package or node_modules resolver. */
export async function registerInstalledClientAssetRoutes(app: FastifyInstance): Promise<void> {
  await app.register(async (icons) => {
    icons.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: "Icon not found" }));
    await icons.register(fastifyStatic, {
      root: dirname(fileURLToPath(import.meta.resolve("material-icon-theme/icons/file.svg"))),
      decorateReply: false,
      index: false,
      allowedPath: (path) => /^\/?[\w-]+(?:\.clone)?\.svg$/u.test(path),
      setHeaders: (reply) => {
        reply.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
        reply.header("Link", '<../../licenses/material-icon-theme/NOTICE.txt>; rel="license"');
      },
    });
  }, { prefix: "/pi-web-dependencies/material-icon-theme" });
}
