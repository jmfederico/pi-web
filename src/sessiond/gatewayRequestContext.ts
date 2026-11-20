import { AsyncLocalStorage } from "node:async_hooks";

const gatewayRequestId = new AsyncLocalStorage<string>();

/** The gateway onRequest hook supplies its own generated UUID, never an incoming header. */
export function withGatewayRequestId<T>(id: string, next: () => T): T {
  return gatewayRequestId.run(id, next);
}

/** Only the configured local daemon transport consumes this context. */
export function daemonRequestIdHeaders(): { "x-request-id": string } | undefined {
  const id = gatewayRequestId.getStore();
  return id === undefined ? undefined : { "x-request-id": id };
}
