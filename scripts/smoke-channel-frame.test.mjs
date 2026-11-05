import { once } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { oversizedFrame } from "./smoke-channel-frame.mjs";

let server;
let url;
beforeEach(async () => {
  server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  url = `ws://127.0.0.1:${server.address().port}/channel`;
});
afterEach(async () => {
  for (const socket of server.clients) socket.terminate();
  await new Promise(resolve => server.close(resolve));
});

function rejection(url, { reqId = "probe-request", code = "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH", phase = "awaiting-open" } = {}) {
  return [
    JSON.stringify({ reqId: "probe-request", req: { url } }),
    JSON.stringify({ reqId, msg: "plugin backend channel transport failed", err: { code }, phase }),
  ].join("\n");
}

it("accepts a size-specific close without receiver diagnostics", async () => {
  server.on("connection", socket => socket.once("message", () => socket.close(1009)));
  await oversizedFrame(url, "revision", "terminal", "open", 128);
});

it("accepts an attributed error envelope after data admission followed by size rejection", async () => {
  server.on("connection", socket => socket.on("message", bytes => {
    const frame = JSON.parse(bytes.toString());
    if (frame.kind === "open") socket.send(JSON.stringify({ version: 1, kind: "ready" }));
    else {
      socket.send(JSON.stringify({ version: 1, kind: "error", code: "invalid-frame" }));
      socket.close(1009);
    }
  }));
  await oversizedFrame(url, "revision", "terminal", "data", 128);
});

it("rejects an unattributed reset on paths requiring a close frame", async () => {
  server.on("connection", socket => socket.once("message", () => socket.terminate()));
  await expect(oversizedFrame(url, "revision", "terminal", "open", 128)).rejects.toThrow("size-specific rejection");
});

it.each(["open", "data"])("accepts a reset only with matching %s receiver evidence, including delayed stdout", async phase => {
  const receiver = { output: "", done: false };
  server.on("connection", (socket, request) => {
    socket.on("message", bytes => {
      const frame = JSON.parse(bytes.toString());
      if (phase === "data" && frame.kind === "open") {
        socket.send(JSON.stringify({ version: 1, kind: "ready" }));
        return;
      }
      socket.once("close", () => {
        // Model stdout delivery after the client has observed socket closure.
        setImmediate(() => { receiver.output = rejection(request.url, { phase: phase === "open" ? "awaiting-open" : "ready" }); });
      });
      socket.terminate();
    });
  });
  await oversizedFrame(url, "revision", "terminal", phase, 128, receiver);
});

it.each(["different probe", "different request", "wrong error", "wrong phase", "missing evidence"])("does not accept a reset with %s", async scenario => {
  let output = "";
  const readOutput = vi.fn(() => output);
  const receiver = { get output() { return readOutput(); }, set output(value) { output = value; }, done: false };
  server.on("connection", (socket, request) => socket.once("message", () => {
    receiver.output = scenario === "missing evidence" ? "" : rejection(
      scenario === "different probe" ? "/channel?smokeProbe=previous" : request.url,
      {
        reqId: scenario === "different request" ? "other-request" : "probe-request",
        code: scenario === "wrong error" ? "ECONNRESET" : "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH",
        phase: scenario === "wrong phase" ? "ready" : "awaiting-open",
      },
    );
    socket.terminate();
  }));
  await expect(oversizedFrame(url, "revision", "terminal", "open", 128, receiver, 100)).rejects.toThrow("timed out");
  const readsAtTimeout = readOutput.mock.calls.length;
  // Let canceled asynchronous continuations run; no evidence poll may survive.
  await new Promise(resolve => setImmediate(resolve));
  expect(readOutput.mock.calls.length).toBe(readsAtTimeout);
});

it("rejects a failed upgrade without unhandled socket errors", async () => {
  server.options.verifyClient = () => false;
  await expect(oversizedFrame(url, "revision", "terminal", "open", 128)).rejects.toThrow("Unexpected server response");
});
