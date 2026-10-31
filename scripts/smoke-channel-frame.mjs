import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";

export async function oversizedFrame(url, revision, terminalId, phase, limit, receiver, timeoutMs = 5_000) {
  // Correlate receiver evidence to this connection, never a preceding probe.
  const probe = `smokeProbe=${randomUUID()}`;
  const socket = new WebSocket(`${url}?${probe}`);
  const cancellation = new AbortController();
  let timeout;
  let readyReceived = false;
  try {
    await new Promise((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(`Oversized ${phase} frame test timed out (${phase === "open" || readyReceived ? "waiting for size rejection" : "waiting for ready"}) at ${url}`)), timeoutMs);
      socket.once("error", reject);
      socket.once("open", () => {
        const open = { version: 1, kind: "open", revision, input: { terminalId } };
        if (phase === "open") open.input.padding = "x".repeat(limit);
        socket.send(JSON.stringify(open));
      });
      socket.on("message", bytes => {
        try {
          const frame = JSON.parse(bytes.toString());
          if (frame.kind === "error" && phase === "data" && !readyReceived) throw new Error(`Channel admission failed at ${url}: ${JSON.stringify(frame)}`);
          if (frame.kind === "ready" && !readyReceived) {
            readyReceived = true;
            if (phase === "data") socket.send(JSON.stringify({ version: 1, kind: "data", data: { type: "input", data: "x".repeat(limit) } }));
          }
        } catch (error) { reject(error); }
      });
      socket.once("close", code => {
        const verify = async () => {
          if (receiver !== undefined) {
            assert.ok(code === 1009 || code === 1006, `Unexpected oversized ${phase} close code ${code} at ${url}`);
            await sizeRejection(receiver, probe, phase, cancellation.signal);
          } else {
            assert.equal(code, 1009, `Oversized ${phase} frame must receive size-specific rejection at ${url}`);
          }
          if (phase === "open") assert.equal(readyReceived, false, "Oversized open must not be admitted");
        };
        void verify().then(resolve, reject);
      });
    });
  } finally { clearTimeout(timeout); cancellation.abort(); socket.terminate(); }
}

async function sizeRejection(receiver, probe, phase, signal) {
  while (!receiver.done) {
    signal.throwIfAborted();
    const logs = receiver.output.split("\n").flatMap(line => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
    const request = logs.find(entry => entry.req?.url?.endsWith(`?${probe}`));
    if (request && logs.some(entry => entry.reqId === request.reqId
      && entry.msg === "plugin backend channel transport failed"
      && entry.err?.code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
      && entry.phase === (phase === "open" ? "awaiting-open" : "ready"))) return;
    // Child stdout delivery can lag socket closure; the caller cancels at its deadline.
    await delay(10, undefined, { signal });
  }
  throw new Error(`Receiver exited before confirming oversized ${phase} rejection (${probe})`);
}
