import { join } from "node:path";
import type { CredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export type SessionModelRuntimeFactory = () => Promise<ModelRuntime>;

export interface SessionModelRuntimeFactoryOptions {
  agentDir: string;
  credentials: CredentialStore;
}

/**
 * Build the daemon's cwd-runtime factory. Every invocation owns a fresh model
 * overlay while all overlays resolve auth through the one profile store.
 */
export function createSessionModelRuntimeFactory(
  options: SessionModelRuntimeFactoryOptions,
): SessionModelRuntimeFactory {
  const modelsPath = join(options.agentDir, "models.json");
  return () => ModelRuntime.create({
    credentials: options.credentials,
    modelsPath,
    // Session overlays restore cached catalogs only. The profile runtime owns
    // PI WEB-triggered model network refreshes.
    allowModelNetwork: false,
  });
}
