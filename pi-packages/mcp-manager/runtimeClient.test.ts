import { expect, it, vi } from "vitest";
import type { PiWebHostPiSessionEventsV1 } from "@jmfederico/pi-web/server-plugin-api";
import { requestMcpRuntime } from "./runtimeClient.js";

it("ignores unrelated replies and closes the connection on cancellation", async () => {
  const abort = new AbortController();
  let listener: ((data: unknown) => void | Promise<void>) | undefined;
  const unsubscribe = vi.fn();
  const close = vi.fn();
  const events: PiWebHostPiSessionEventsV1 = {
    version: 1,
    connect: () => Promise.resolve({
      signal: new AbortController().signal,
      on: (_channel, handler) => { listener = handler; return unsubscribe; },
      emit: () => { void listener?.({ id: "unrelated", state: { secrets: "do-not-forward" } }); abort.abort(); },
      close,
    }),
  };
  await expect(requestMcpRuntime(events, { projectId: "p", workspaceId: "w", sessionId: "s" }, "refresh", abort.signal)).rejects.toThrow("did not respond");
  expect(unsubscribe).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
});

it("projects only safe runtime fields from synchronous replies", async () => {
  let listener: ((data: unknown) => void | Promise<void>) | undefined;
  const close = vi.fn();
  const events: PiWebHostPiSessionEventsV1 = {
    version: 1,
    connect: () => Promise.resolve({
      signal: new AbortController().signal,
      on: (_channel, handler) => { listener = handler; return () => { listener = undefined; }; },
      emit: (_channel, input) => {
        if (typeof input !== "object" || input === null) throw new Error("Missing request");
        const id: unknown = Reflect.get(input, "id");
        void listener?.({ id, projectTrusted: true, state: { pending: true, secrets: "hidden", servers: [{ name: "docs", pending: true, config: { token: "hidden" } }], errors: [] } });
      },
      close,
    }),
  };
  expect(await requestMcpRuntime(events, { projectId: "p", workspaceId: "w", sessionId: "s" }, "view", new AbortController().signal)).toEqual({
    projectTrusted: true, pending: true, servers: [{ name: "docs", pending: true }], errors: [],
  });
  expect(listener).toBeUndefined();
  expect(close).toHaveBeenCalledOnce();
});
