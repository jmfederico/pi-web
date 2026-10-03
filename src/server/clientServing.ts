import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Explicit decision about how the web/API process handles non-API browser
 * requests, and which local URL a browser actually uses to reach the UI.
 *
 * - `packaged`: the API process serves the built client from `clientDist`.
 * - `dev`: a development stack serves the UI from its own listener (the Vite
 *   dev server); the API process serves no client at all and points stray
 *   non-API requests at `browserEntrypointUrl`.
 *
 * The mode is chosen from explicit startup wiring, never by probing for
 * `src/client` sources, so a development API process can never serve raw
 * `%BASE_URL%` source HTML.
 */
export type ClientServing =
  | { readonly mode: "packaged"; readonly clientDist: string }
  | { readonly mode: "dev"; readonly browserEntrypointUrl: string };

/**
 * Environment key through which development stacks (`npm run dev:*`, the
 * Docker `--dev` Compose stack) declare the local browser entrypoint — the
 * Vite dev listener. Packaged and single-process runs leave it unset, so their
 * browser entrypoint is the API listener itself. Also consumed as Safe
 * Tunnel's default local target in development mode.
 */
export const PI_WEB_BROWSER_URL_ENV = "PI_WEB_BROWSER_URL";

export interface ResolveClientServingOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** Directory containing the running server module; tests substitute fixture layouts. */
  readonly serverModuleDir?: string;
}

/** Resolves the startup serving-mode decision from explicit environment wiring. */
export function resolveClientServing(options: ResolveClientServingOptions = {}): ClientServing {
  const env = options.env ?? process.env;
  const browserEntrypointUrl = parseBrowserEntrypointUrl(env[PI_WEB_BROWSER_URL_ENV]);
  if (browserEntrypointUrl !== undefined) return { mode: "dev", browserEntrypointUrl };
  return {
    mode: "packaged",
    clientDist: defaultPackagedClientDist(options.serverModuleDir ?? runningServerModuleDir()),
  };
}

/**
 * The built client always lives at `<package root>/dist/client`. Anchoring on
 * the package root keeps packaged runs (`dist/server`) and checkout runs under
 * tsx (`src/server`, e.g. `npm start`) pointed at the build output — never at
 * the `src/client` source tree.
 */
export function defaultPackagedClientDist(serverModuleDir: string): string {
  return join(serverModuleDir, "..", "..", "dist", "client");
}

/**
 * Fails startup loudly when packaged mode has no build output, instead of
 * silently serving nothing — or, worse, the raw source tree.
 */
export function requirePackagedClientDist(
  clientDist: string,
  fileExists: (path: string) => boolean = existsSync,
): void {
  if (fileExists(join(clientDist, "index.html"))) return;
  throw new Error(
    `PI WEB cannot serve its browser client: no built client found at ${clientDist}. `
    + "Run `npm run build` first (packaged installs ship the built client), or develop with `npm run dev`, "
    + `which serves the UI from the Vite dev server and sets ${PI_WEB_BROWSER_URL_ENV} so the API process does not serve the client.`,
  );
}

/** Plain-language pointer answered for non-API requests in development mode. */
export function devModeClientPointer(browserEntrypointUrl: string): string {
  return `PI WEB is running in development mode; the API process does not serve the browser UI. Open the dev server at ${browserEntrypointUrl}\n`;
}

function parseBrowserEntrypointUrl(value: string | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${PI_WEB_BROWSER_URL_ENV} must be a valid URL, got ${JSON.stringify(value)}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${PI_WEB_BROWSER_URL_ENV} must be an http:// or https:// URL, got ${JSON.stringify(value)}`);
  }
  return value;
}

function runningServerModuleDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}
