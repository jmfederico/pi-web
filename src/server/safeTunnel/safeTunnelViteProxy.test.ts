import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { createViteProxyHostBypass } from "./safeTunnelViteProxy.js";

describe("Vite `/api` WebSocket proxy host bypass", () => {
  it("allows configured and managed hosts while rejecting unrelated hosts", () => {
    const bypass = createViteProxyHostBypass(["gateway.example.test", "machine.namespace.tunnels.example.test"]);
    const socket = new Socket();
    const request = new IncomingMessage(socket);
    const response = new ServerResponse(request);
    try {
      for (const host of ["gateway.example.test", "machine.namespace.tunnels.example.test"]) {
        request.headers.host = host;
        expect(bypass(request, response, {})).toBeUndefined();
      }
      request.headers.host = "attacker.example.test";
      expect(bypass(request, response, {})).toBe(false);
    } finally {
      socket.destroy();
    }
  });
});
