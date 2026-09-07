import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { DEPLOYMENT_IDENTITY_ASSET_PATHS, DEPLOYMENT_MANIFEST_CONTENT_TYPE, DEPLOYMENT_MANIFEST_PATH, deploymentIdentityAssetForPath, deploymentManifestForFlavor, type PiWebDeploymentFlavor } from "./deploymentIdentity.js";

export interface DeploymentIdentityRouteOptions {
  /** Root of the built client assets; must be the fastify-static root so `sendFile` resolves. */
  clientDist: string;
  flavor: () => Promise<PiWebDeploymentFlavor>;
}

/**
 * Serve dev brand assets in place of the stock files when the deployment is a
 * dev flavor. Explicit routes take precedence over the fastify-static wildcard,
 * so the stable path just delegates back to `sendFile` with the original name.
 * Register after fastify-static so the `sendFile` decorator exists.
 */
export function registerDeploymentIdentityAssetRoutes(app: FastifyInstance, options: DeploymentIdentityRouteOptions): void {
  for (const pathname of DEPLOYMENT_IDENTITY_ASSET_PATHS) {
    app.get(pathname, async (_request, reply) => {
      const asset = deploymentIdentityAssetForPath(pathname, await options.flavor());
      return reply.sendFile(asset === undefined ? pathname.slice(1) : asset.fileName);
    });
  }

  app.get(DEPLOYMENT_MANIFEST_PATH, async (_request, reply) => {
    const manifest = await readFile(join(options.clientDist, DEPLOYMENT_MANIFEST_PATH.slice(1)), "utf8");
    return reply.type(DEPLOYMENT_MANIFEST_CONTENT_TYPE).send(deploymentManifestForFlavor(manifest, await options.flavor()));
  });
}
