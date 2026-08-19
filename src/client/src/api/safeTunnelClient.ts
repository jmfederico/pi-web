import type {
  SafeTunnelDisableResponse,
  SafeTunnelEnableRequest,
  SafeTunnelEnableResponse,
  SafeTunnelOperationResponse,
  SafeTunnelStatusResponse,
} from "../../../shared/apiTypes";
import {
  SAFE_TUNNEL_MUTATION_HEADER_NAME,
  SAFE_TUNNEL_MUTATION_HEADER_VALUE,
} from "../../../shared/safeTunnelHttp";
import { request } from "./http";
import {
  parseSafeTunnelDisableResponse,
  parseSafeTunnelEnableResponse,
  parseSafeTunnelOperationResponse,
  parseSafeTunnelStatusResponse,
} from "./safeTunnelParsers";

export interface SafeTunnelApi {
  status(): Promise<SafeTunnelStatusResponse>;
  enable(input?: SafeTunnelEnableRequest): Promise<SafeTunnelEnableResponse>;
  disable(): Promise<SafeTunnelDisableResponse>;
  operation(operationId: string): Promise<SafeTunnelOperationResponse>;
}

export const safeTunnelApi: SafeTunnelApi = {
  status: () => request("api/safe-tunnel/status", parseSafeTunnelStatusResponse, { cache: "no-store" }),
  enable: (input: SafeTunnelEnableRequest = {}) => request(
    "api/safe-tunnel/enable",
    parseSafeTunnelEnableResponse,
    safeTunnelMutationRequest(input),
  ),
  disable: () => request(
    "api/safe-tunnel/disable",
    parseSafeTunnelDisableResponse,
    safeTunnelMutationRequest({}),
  ),
  operation: (operationId: string) => request(
    `api/safe-tunnel/operations/${encodeURIComponent(operationId)}`,
    parseSafeTunnelOperationResponse,
    { cache: "no-store" },
  ),
};

function safeTunnelMutationRequest(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: {
      [SAFE_TUNNEL_MUTATION_HEADER_NAME]: SAFE_TUNNEL_MUTATION_HEADER_VALUE,
    },
    body: JSON.stringify(body),
  };
}
