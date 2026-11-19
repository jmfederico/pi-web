import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { installedBrowserModules } from "./installedBrowserModules.js";

/** Mount browser assets, never a general-purpose package or node_modules resolver. */
export async function registerInstalledClientAssetRoutes(app: FastifyInstance): Promise<void> {
  await app.register(async (modules) => {
    await modules.register(fastifyStatic, { serve: false });
    for (const { path, entry } of installedBrowserModules) {
      const file = fileURLToPath(import.meta.resolve(entry));
      modules.get(`/${path}`, (_request, reply) => reply.sendFile(basename(file), dirname(file)));
    }
  });
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
