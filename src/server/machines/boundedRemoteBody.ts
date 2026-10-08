import { RemoteMachineRequestError } from "./machineClient.js";

export function readBoundedRemoteBody(body: NodeJS.ReadableStream, maxBytes: number, timeoutMs: number, signal?: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, rejectPromise) => {
    const chunks: Buffer[] = [];
    let byteLength = 0;
    let settled = false;
    const timeout = setTimeout(() => {
      fail(new RemoteMachineRequestError("Remote machine response body timed out", 504));
    }, timeoutMs);
    timeout.unref();
    // An inbound disconnect must release the upstream connection instead of
    // draining a remote body nobody is waiting for any more.
    const onAbort = (): void => {
      fail(new RemoteMachineRequestError("Remote machine request cancelled", 502));
    };

    const cleanup = (): void => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      body.removeListener("data", onData);
      body.removeListener("end", onEnd);
      body.removeListener("error", onError);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        destroyReadable(body);
      } catch {
        // The bounded gateway error remains authoritative even if teardown fails.
      }
      rejectPromise(error);
    };
    const onData = (chunk: unknown): void => {
      const buffer = typeof chunk === "string"
        ? Buffer.from(chunk)
        : chunk instanceof Uint8Array ? Buffer.from(chunk) : undefined;
      if (buffer === undefined) {
        fail(new RemoteMachineRequestError("Remote machine returned an invalid response body", 502));
        return;
      }
      byteLength += buffer.byteLength;
      if (byteLength > maxBytes) {
        fail(new RemoteMachineRequestError(`Remote machine response exceeded the ${String(maxBytes)} byte limit`, 502));
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onError = (error: unknown): void => {
      fail(new RemoteMachineRequestError(errorMessage(error), 502));
    };

    body.on("data", onData);
    body.once("end", onEnd);
    body.once("error", onError);
    if (signal?.aborted === true) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function destroyReadable(body: NodeJS.ReadableStream): void {
  const destroy: unknown = Reflect.get(body, "destroy");
  if (typeof destroy === "function") Reflect.apply(destroy, body, []);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
