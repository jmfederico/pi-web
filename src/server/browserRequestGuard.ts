import { isIP } from "node:net";
import type { FastifyInstance } from "fastify";
import type { PiWebHostAccess } from "../shared/apiTypes.js";
import { hostnameAllowedByPolicy, normalizeHostname, requireHostAccess } from "../shared/hostAccess.js";

interface Authority {
  hostname: string;
  port: number | undefined;
}

/** Browser defenses, not authentication: non-browser clients can supply these headers. */
export function registerBrowserRequestGuard(app: FastifyInstance, hostAccess?: PiWebHostAccess): void {
  // Snapshot the startup policy, like host/port. Saving config must not change
  // admission halfway through the request that saves it.
  const policy = hostAccess === undefined ? undefined : requireHostAccess(hostAccess);
  app.addHook("onRequest", (request, reply, done) => {
    const host = parseAuthority(request.headers.host);
    if (headerCount(request.raw.rawHeaders, "host") !== 1 || host === undefined || !hostnameAllowedByPolicy(host.hostname, policy)) {
      void reply.code(403).send({ error: "Host not allowed. Check hostAccess in the gateway config and restart the web/API service." });
      return;
    }

    const requiresOriginCheck = request.headers.upgrade !== undefined || !["GET", "HEAD", "OPTIONS"].includes(request.method);
    const origin = request.headers.origin;
    if (requiresOriginCheck && origin !== undefined && (
      headerCount(request.raw.rawHeaders, "origin") !== 1 || !originMatchesHost(origin, host)
    )) {
      void reply.code(403).send({ error: "Origin not allowed. Open PI WEB at its configured address; proxies must preserve Host and Origin." });
      return;
    }
    done();
  });
}

function headerCount(rawHeaders: string[], name: string): number {
  let count = 0;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === name) count++;
  }
  return count;
}

function parseAuthority(value: string | undefined): Authority | undefined {
  if (value === undefined) return undefined;
  // Do not let URL parsing silently repair whitespace, credentials, escapes,
  // paths, or an empty port in security-sensitive headers.
  const match = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::([0-9]+))?$/iu.exec(value);
  if (match?.[1] === undefined || match[0] !== value) return undefined;
  const rawHostname = match[1];
  let hostname: string;
  if (rawHostname.startsWith("[")) {
    if (isIP(rawHostname.slice(1, -1)) !== 6) return undefined;
    hostname = new URL(`http://${rawHostname}`).hostname.slice(1, -1);
  } else {
    hostname = normalizeHostname(rawHostname);
    if (hostname.length > 253 || !hostname.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))) return undefined;
  }
  const port = match[2] === undefined ? undefined : Number(match[2]);
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) return undefined;
  return { hostname, port };
}

function originMatchesHost(value: string, host: Authority): boolean {
  const match = /^(https?):\/\/([^/?#]+)$/iu.exec(value);
  if (match?.[2] === undefined || match[0] !== value) return false;
  const origin = parseAuthority(match[2]);
  if (origin === undefined) return false;
  const defaultPort = match[1]?.toLowerCase() === "https" ? 443 : 80;
  // Intentionally ignore transport scheme: TLS belongs to the reverse proxy.
  // Compare the preserved public Host, never forwarded headers or the local
  // listener port (which also differs behind Vite's development proxy).
  return origin.hostname === host.hostname && (origin.port ?? defaultPort) === (host.port ?? defaultPort);
}
