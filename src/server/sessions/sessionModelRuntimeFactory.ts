import { join } from "node:path";
import type { CredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { SessionAuthRuntimeRegistry } from "./sessionAuthRuntimeRegistry.js";

export interface SessionModelRuntimeFactoryInput {
  cwd: string;
}

export type SessionModelRuntimeFactory = (input: SessionModelRuntimeFactoryInput) => Promise<ModelRuntime>;

export interface SessionModelRuntimeFactoryOptions {
  agentDir: string;
  credentials: CredentialStore;
  authRuntimeRegistry?: SessionAuthRuntimeRegistry;
}

/**
 * Build the daemon's cwd-runtime factory. Every invocation owns a fresh model
 * overlay while all overlays resolve auth through the one profile store.
 */
export function createSessionModelRuntimeFactory(
  options: SessionModelRuntimeFactoryOptions,
): SessionModelRuntimeFactory {
  const modelsPath = join(options.agentDir, "models.json");
  return async ({ cwd }) => {
    const credentialScope = options.authRuntimeRegistry?.createCredentialScope(cwd);
    try {
      const runtime = await ModelRuntime.create({
        credentials: credentialScope?.credentials ?? options.credentials,
        modelsPath,
        // Session overlays restore cached catalogs only. The profile runtime owns
        // PI WEB-triggered model network refreshes.
        allowModelNetwork: false,
      });
      credentialScope?.bindRuntime(runtime);
      return runtime;
    } catch (error: unknown) {
      credentialScope?.abandon();
      throw error;
    }
  };
}
