import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requestCancellation } from "./requestCancellation.js";

// These tests deliberately use a listening server instead of `app.inject`,
// because the false-positive cancellation they guard against comes from real
// Node request/response stream lifecycles that the injection harness fakes.
let app: FastifyInstance;
let baseUrl: string;

beforeEach(() => {
  app = Fastify({ logger: false });
});

afterEach(async () => {
  await app.close();
});

async function listen(): Promise<void> {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === "string") throw new Error("Expected a TCP address");
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
}

describe("requestCancellation", () => {
  it("stays live for a body-bearing request whose handler already awaited other work", async () => {
    app.delete("/resource", async (request, reply) => {
      // Mirrors routes that resolve a project before starting the cancellable
      // operation: by now Node has auto-destroyed the fully read request body.
      await new Promise((resolve) => { setImmediate(resolve); });
      const cancellation = requestCancellation(request, reply);
      try {
        return { abortedBeforeStart: cancellation.signal.aborted };
      } finally {
        cancellation.dispose();
      }
    });
    await listen();

    const response = await fetch(`${baseUrl}/resource`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ precondition: "v1.confirmed" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ abortedBeforeStart: false });
  });

  it("aborts when the client disconnects while the handler is still working", async () => {
    let abortReason = "";
    const observed = new Promise<void>((resolveObserved) => {
      app.delete("/resource", async (request, reply) => {
        const cancellation = requestCancellation(request, reply);
        try {
          await new Promise<void>((resolveAbort) => {
            cancellation.signal.addEventListener("abort", () => {
              abortReason = cancellation.signal.reason instanceof Error ? cancellation.signal.reason.message : "";
              resolveAbort();
            }, { once: true });
          });
          resolveObserved();
          return {};
        } finally {
          cancellation.dispose();
        }
      });
    });
    await listen();

    const controller = new AbortController();
    const pending = fetch(`${baseUrl}/resource`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ precondition: "v1.confirmed" }),
      signal: controller.signal,
    });
    setTimeout(() => { controller.abort(); }, 20);
    await expect(pending).rejects.toThrow();

    await observed;
    expect(abortReason).toBe("HTTP request cancelled");
  });
});
