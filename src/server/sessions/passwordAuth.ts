/**
 * Username/Password Authentication for PI WEB
 *
 * Provides login/logout routes and a Fastify preHandler hook
 * that protects all `/api/*` routes (except `/api/auth/*`) behind
 * a simple in-memory token.
 *
 * Tokens are ephemeral — they are never persisted to disk. A server
 * restart forces all clients to re-authenticate.
 *
 * Configuration:
 *   - Config file: `{ "auth": { "enabled": true, "username": "...", "password": "..." } }`
 *   - Environment: `PI_WEB_AUTH_USERNAME` and `PI_WEB_AUTH_PASSWORD`
 */

import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

const TOKEN_BYTES = 48;
const TOKEN_HEX_LENGTH = TOKEN_BYTES * 2;

const tokens = new Map<string, number>();

const BEARER_PREFIX = "Bearer ";

/**
 * Generate a new bearer token valid for 24 hours.
 * Oldest tokens are evicted when the map grows past 500 entries.
 */
function createToken(): string {
  const token = randomBytes(TOKEN_BYTES).toString("hex");
  const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
  tokens.set(token, expiresAt);
  if (tokens.size > 500) evictExpired();
  return token;
}

function evictExpired(): void {
  const now = Date.now();
  for (const [token, expiresAt] of tokens) {
    if (now > expiresAt) tokens.delete(token);
  }
}

function isValidToken(token: string): boolean {
  if (token.length !== TOKEN_HEX_LENGTH) return false;
  const expiresAt = tokens.get(token);
  if (expiresAt === undefined) return false;
  if (Date.now() > expiresAt) {
    tokens.delete(token);
    return false;
  }
  return true;
}

function revokeToken(token: string): void {
  tokens.delete(token);
}

/** Route prefix that must be excluded from auth checks. */
const AUTH_PREFIX = "/api/auth";

export interface PasswordAuthOptions {
  /** Whether authentication is required. */
  enabled: boolean;
  /** Valid username (case-sensitive). */
  username: string;
  /** Valid password (case-sensitive). */
  password: string;
}

/**
 * Register the password-auth plugin on a Fastify instance.
 *
 * Adds:
 *   POST /api/auth/login    — body { username, password } → { token }
 *   POST /api/auth/logout   — header Authorization: Bearer <token> → { success }
 *   GET  /api/auth/check    — returns { authenticated: boolean }
 *
 * A preHandler on `/api/*` (excluding `/api/auth/*`) validates the
 * Bearer token and rejects with 401 when auth is enabled.
 */
export function registerPasswordAuth(
  app: FastifyInstance,
  authConfig: PasswordAuthOptions,
): void {
  // ---- public auth endpoints (no auth required) ----

  app.post(`${AUTH_PREFIX}/login`, async (request: FastifyRequest<{ Body: { username?: string; password?: string } }>, reply: FastifyReply) => {
    if (!authConfig.enabled) {
      return reply.code(403).send({ error: "Password authentication is not enabled on this server." });
    }
    if (authConfig.username.length === 0 || authConfig.password.length === 0) {
      return reply.code(403).send({ error: "No credentials configured. Set PI_WEB_AUTH_USERNAME and PI_WEB_AUTH_PASSWORD, or add auth to config." });
    }

    const { username, password } = request.body;
    if (username === undefined || username.length === 0 || password === undefined || password.length === 0) {
      return reply.code(400).send({ error: "Username and password are required" });
    }

    if (username !== authConfig.username || password !== authConfig.password) {
      return reply.code(401).send({ error: "Invalid username or password" });
    }

    const token = createToken();
    return { token, expiresAt: Date.now() + 24 * 60 * 60 * 1000 };
  });

  app.post(`${AUTH_PREFIX}/logout`, (request: FastifyRequest, reply: FastifyReply) => {
    const authHeader = request.headers.authorization;
    if (authHeader?.startsWith(BEARER_PREFIX) === true) {
      revokeToken(authHeader.slice(BEARER_PREFIX.length));
    }
    return reply.send({ success: true });
  });

  app.get(`${AUTH_PREFIX}/check`, (request: FastifyRequest) => {
    const authHeader = request.headers.authorization;
    const token = authHeader?.startsWith(BEARER_PREFIX) === true ? authHeader.slice(BEARER_PREFIX.length) : null;
    const authenticated = token !== null && isValidToken(token);
    return { authenticated, authEnabled: authConfig.enabled };
  });

  // ---- preHandler hook that protects all /api/* routes ----

  if (!authConfig.enabled) return;

  app.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
    const url = request.url;

    // Skip auth for public auth endpoints
    if (url === `${AUTH_PREFIX}/login` || url === `${AUTH_PREFIX}/logout` || url === `${AUTH_PREFIX}/check`) {
      return;
    }

    // Only protect /api/* routes
    if (!url.startsWith("/api/")) return;

    // Extract token from Authorization header or ?token= query parameter
    // (WebSocket connections from browsers cannot set custom headers,
    // so they pass the token as a query parameter instead)
    const token = extractToken(request);
    if (token === undefined) {
      return reply.code(401).send({ error: "Authentication required" });
    }

    if (!isValidToken(token)) {
      return reply.code(401).send({ error: "Invalid or expired token" });
    }
  });
}

function extractToken(request: FastifyRequest): string | undefined {
  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith(BEARER_PREFIX) === true) {
    return authHeader.slice(BEARER_PREFIX.length);
  }
  // Also accept token from query parameter (for WebSocket connections)
  const url = request.url;
  const queryIndex = url.indexOf("?");
  if (queryIndex !== -1) {
    const params = new URLSearchParams(url.slice(queryIndex));
    const queryToken = params.get("token");
    if (queryToken !== null && queryToken.length > 0) {
      return queryToken;
    }
  }
  return undefined;
}
