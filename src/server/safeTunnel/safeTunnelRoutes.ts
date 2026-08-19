import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type {
  SafeTunnelAdvancedOverrides,
  SafeTunnelDisableResponse,
  SafeTunnelEnableRequest,
  SafeTunnelEnableResponse,
  SafeTunnelOperationResponse,
  SafeTunnelStatusResponse,
} from "../../shared/apiTypes.js";
import {
  SAFE_TUNNEL_MUTATION_HEADER_NAME,
  SAFE_TUNNEL_MUTATION_HEADER_VALUE,
} from "../../shared/safeTunnelHttp.js";
import {
  createSafeTunnelMutationHostBoundary,
  type SafeTunnelMutationHostConfig,
} from "./safeTunnelMutationHosts.js";

const enableRequestKeys = new Set(["advanced"]);
const disableRequestKeys = new Set<string>();
const advancedOverrideKeys = new Set([
  "controlApiUrl",
  "frpcPath",
  "localPiWebUrl",
  "machineName",
  "machineSlug",
]);
const unexpectedErrorMessage = "Safe Tunnel request failed.";

export interface SafeTunnelRouteService {
  disable(): Promise<SafeTunnelDisableResponse>;
  enable(request: SafeTunnelEnableRequest): Promise<SafeTunnelEnableResponse>;
  operation(operationId: string): SafeTunnelOperationResponse | undefined;
  /** Reads only the persisted public ingress identity used by the request boundary. */
  registeredPublicOrigin(): Promise<string | undefined>;
  status(): Promise<SafeTunnelStatusResponse>;
}

export type SafeTunnelOperationConflict =
  | "already_enabled"
  | "operation_in_progress";

/** A bounded, browser-safe conflict that the application adapter may expose. */
export class SafeTunnelOperationConflictError extends Error {
  constructor(readonly code: SafeTunnelOperationConflict) {
    super(code === "already_enabled"
      ? "Safe Tunnel is already enabled."
      : "A Safe Tunnel operation is already running.");
    this.name = "SafeTunnelOperationConflictError";
  }
}

/**
 * Registers only the Safe Tunnel HTTP contract. Production composition and
 * lifecycle ownership stay outside this dormant leaf.
 */
export function registerSafeTunnelRoutes(
  app: FastifyInstance,
  service: SafeTunnelRouteService,
  mutationHostConfig: SafeTunnelMutationHostConfig = {},
): void {
  const requestHosts = createSafeTunnelMutationHostBoundary(mutationHostConfig);
  const registeredPublicOrigin = () => service.registeredPublicOrigin();
  const requireReadRequest = (request: FastifyRequest, reply: FastifyReply) => (
    requireSafeTunnelReadRequest(
      request,
      reply,
      registeredPublicOrigin,
      requestHosts,
    )
  );
  const requireMutationRequest = (request: FastifyRequest, reply: FastifyReply) => (
    requireSafeTunnelMutationRequest(
      request,
      reply,
      registeredPublicOrigin,
      requestHosts,
    )
  );

  app.get(
    "/api/safe-tunnel/status",
    { preValidation: requireReadRequest },
    async (_request, reply) => {
      markSafeTunnelResponsePrivate(reply);
      try {
        return await service.status();
      } catch (error) {
        return sendSafeTunnelError(reply, error);
      }
    },
  );

  app.post<{ Body: unknown }>(
    "/api/safe-tunnel/enable",
    { preValidation: requireMutationRequest },
    async (request, reply) => {
      markSafeTunnelResponsePrivate(reply);
      try {
        const response = await service.enable(parseEnableRequest(request.body));
        return await reply.code(202).send(response);
      } catch (error) {
        return sendSafeTunnelError(reply, error);
      }
    },
  );

  app.post<{ Body: unknown }>(
    "/api/safe-tunnel/disable",
    { preValidation: requireMutationRequest },
    async (request, reply) => {
      markSafeTunnelResponsePrivate(reply);
      try {
        parseDisableRequest(request.body);
        return await service.disable();
      } catch (error) {
        return sendSafeTunnelError(reply, error);
      }
    },
  );

  app.get<{ Params: { operationId: string } }>(
    "/api/safe-tunnel/operations/:operationId",
    { preValidation: requireReadRequest },
    (request, reply) => {
      markSafeTunnelResponsePrivate(reply);
      try {
        const operation = service.operation(request.params.operationId);
        if (operation === undefined) {
          return reply.code(404).send({ error: "Safe Tunnel operation not found" });
        }
        return operation;
      } catch (error) {
        return sendSafeTunnelError(reply, error);
      }
    },
  );
}

function markSafeTunnelResponsePrivate(reply: FastifyReply): void {
  void reply.header("cache-control", "no-store");
}

async function requireSafeTunnelReadRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  registeredPublicOrigin: () => Promise<string | undefined>,
  requestHosts: ReturnType<typeof createSafeTunnelMutationHostBoundary>,
): Promise<void> {
  try {
    if (await requestHosts.allowsRead(
      { host: request.headers.host },
      registeredPublicOrigin,
    )) return;
  } catch {
    // The persisted registration could not establish trust. Fail closed and
    // do not expose private state/transport details at the browser boundary.
  }
  await denySafeTunnelRequest(reply);
}

async function requireSafeTunnelMutationRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  registeredPublicOrigin: () => Promise<string | undefined>,
  requestHosts: ReturnType<typeof createSafeTunnelMutationHostBoundary>,
): Promise<void> {
  const fetchSite = request.headers["sec-fetch-site"];
  const isSameOriginWhenKnown = fetchSite === undefined || fetchSite === "same-origin";
  const isMarkedBrowserRequest =
    request.headers[SAFE_TUNNEL_MUTATION_HEADER_NAME]
      === SAFE_TUNNEL_MUTATION_HEADER_VALUE;
  const hasJsonBody = request.body !== undefined
    && hasJsonContentType(request.headers["content-type"]);
  if (isSameOriginWhenKnown && isMarkedBrowserRequest && hasJsonBody) {
    try {
      if (await requestHosts.allowsMutation(
        { host: request.headers.host, origin: request.headers.origin },
        registeredPublicOrigin,
      )) return;
    } catch {
      // The persisted registration could not establish trust. Fail closed and
      // do not expose private state/transport details at the browser boundary.
    }
  }
  await denySafeTunnelRequest(reply);
}

async function denySafeTunnelRequest(reply: FastifyReply): Promise<void> {
  markSafeTunnelResponsePrivate(reply);
  await reply.code(403).send({ error: "Request forbidden." });
}

function hasJsonContentType(value: string | undefined): boolean {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

class SafeTunnelRequestValidationError extends Error {}

function parseEnableRequest(body: unknown): SafeTunnelEnableRequest {
  const request = requireRequestObject(
    body,
    "Safe Tunnel enable request body must be an object",
  );
  assertOnlyKeys(request, enableRequestKeys, "Safe Tunnel enable request");
  if (request["advanced"] === undefined) return {};

  const advanced = requireRequestObject(
    request["advanced"],
    "Safe Tunnel advanced overrides must be an object",
  );
  assertOnlyKeys(advanced, advancedOverrideKeys, "Safe Tunnel advanced overrides");

  const parsed: SafeTunnelAdvancedOverrides = {};
  copyOptionalString(
    advanced,
    parsed,
    "controlApiUrl",
    "Safe Tunnel advanced controlApiUrl",
    2_048,
  );
  copyOptionalString(
    advanced,
    parsed,
    "machineName",
    "Safe Tunnel advanced machineName",
    80,
  );
  copyOptionalString(
    advanced,
    parsed,
    "machineSlug",
    "Safe Tunnel advanced machineSlug",
    63,
  );
  copyOptionalString(
    advanced,
    parsed,
    "localPiWebUrl",
    "Safe Tunnel advanced localPiWebUrl",
    2_048,
  );
  copyOptionalString(
    advanced,
    parsed,
    "frpcPath",
    "Safe Tunnel advanced frpcPath",
    4_096,
  );
  return Object.keys(parsed).length === 0 ? {} : { advanced: parsed };
}

function parseDisableRequest(body: unknown): void {
  const request = requireRequestObject(
    body,
    "Safe Tunnel disable request body must be an object",
  );
  assertOnlyKeys(request, disableRequestKeys, "Safe Tunnel disable request");
}

function copyOptionalString(
  source: Readonly<Record<string, unknown>>,
  target: SafeTunnelAdvancedOverrides,
  key: keyof SafeTunnelAdvancedOverrides,
  fieldName: string,
  maximumCharacters: number,
): void {
  const value = optionalNonEmptyString(source[key], fieldName, maximumCharacters);
  if (value !== undefined) target[key] = value;
}

function optionalNonEmptyString(
  value: unknown,
  fieldName: string,
  maximumCharacters: number,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SafeTunnelRequestValidationError(
      `${fieldName} must be a non-empty string`,
    );
  }
  const normalized = value.trim();
  if (normalized.length > maximumCharacters) {
    throw new SafeTunnelRequestValidationError(`${fieldName} is too long`);
  }
  return normalized;
}

function requireRequestObject(
  value: unknown,
  message: string,
): Record<string, unknown> {
  if (!isRecord(value)) throw new SafeTunnelRequestValidationError(message);
  return value;
}

function assertOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowedKeys: ReadonlySet<string>,
  label: string,
): void {
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new SafeTunnelRequestValidationError(
      `${label} contains an unsupported field`,
    );
  }
}

function sendSafeTunnelError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof SafeTunnelRequestValidationError) {
    return reply.code(400).send({ error: error.message });
  }
  if (error instanceof SafeTunnelOperationConflictError) {
    return reply.code(409).send({ error: error.message });
  }
  return reply.code(500).send({ error: unexpectedErrorMessage });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
