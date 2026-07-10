import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SafeTunnelLoginRequest,
  SafeTunnelLoginResponse,
  SafeTunnelOperationResponse,
  SafeTunnelStartRequest,
  SafeTunnelStartResponse,
  SafeTunnelStatusResponse,
  SafeTunnelStopResponse,
} from "../../shared/apiTypes.js";
import { SafeTunnelBridgeError, type SafeTunnelBridgeService } from "./safeTunnelBridgeService.js";
import { registerSafeTunnelRoutes } from "./safeTunnelRoutes.js";

let app: FastifyInstance;
let service: FakeSafeTunnelBridgeService;

beforeEach(async () => {
  app = Fastify({ logger: false });
  service = new FakeSafeTunnelBridgeService();
  registerSafeTunnelRoutes(app, service);
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe("registerSafeTunnelRoutes", () => {
  it("serves Safe Tunnel status", async () => {
    const response = await app.inject({ method: "GET", url: "/api/safe-tunnel/status" });

    expect(response.statusCode).toBe(200);
    expect(response.json<SafeTunnelStatusResponse>()).toEqual(service.statusResponse);
  });

  it("validates and starts a login operation", async () => {
    const payload = {
      controlApiUrl: " https://control.example.test ",
      machineName: " Dev Box ",
      machineSlug: " dev-box ",
      localPiWebUrl: " http://127.0.0.1:8504 ",
      frpcPath: " /opt/frpc ",
    };

    const response = await app.inject({ method: "POST", url: "/api/safe-tunnel/login", payload });

    expect(response.statusCode).toBe(202);
    expect(response.json<SafeTunnelLoginResponse>()).toEqual(service.loginResponse);
    expect(service.login).toHaveBeenCalledWith({
      controlApiUrl: "https://control.example.test",
      machineName: "Dev Box",
      machineSlug: "dev-box",
      localPiWebUrl: "http://127.0.0.1:8504",
      frpcPath: "/opt/frpc",
    });
  });

  it("rejects invalid login bodies before calling the service", async () => {
    const response = await app.inject({ method: "POST", url: "/api/safe-tunnel/login", payload: { controlApiUrl: "" } });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Safe Tunnel login controlApiUrl must be a non-empty string" });
    expect(service.login).not.toHaveBeenCalled();
  });

  it("looks up tracked operations", async () => {
    const response = await app.inject({ method: "GET", url: "/api/safe-tunnel/operations/op_1" });
    const missing = await app.inject({ method: "GET", url: "/api/safe-tunnel/operations/missing" });

    expect(response.statusCode).toBe(200);
    expect(response.json<SafeTunnelOperationResponse>()).toEqual(service.operationResponse);
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "Safe Tunnel operation not found" });
  });

  it("starts and stops the connector", async () => {
    const startResponse = await app.inject({ method: "POST", url: "/api/safe-tunnel/start", payload: { frpcPath: " /opt/frpc " } });
    const stopResponse = await app.inject({ method: "POST", url: "/api/safe-tunnel/stop" });

    expect(startResponse.statusCode).toBe(202);
    expect(startResponse.json<SafeTunnelStartResponse>()).toEqual(service.startResponse);
    expect(service.start).toHaveBeenCalledWith({ frpcPath: "/opt/frpc" });
    expect(stopResponse.statusCode).toBe(200);
    expect(stopResponse.json<SafeTunnelStopResponse>()).toEqual(service.stopResponse);
  });

  it("maps bridge errors to their HTTP status", async () => {
    service.start.mockRejectedValueOnce(new SafeTunnelBridgeError("Already running", 409));

    const response = await app.inject({ method: "POST", url: "/api/safe-tunnel/start", payload: {} });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "Already running" });
  });
});

class FakeSafeTunnelBridgeService implements SafeTunnelBridgeService {
  readonly operationResponse: SafeTunnelOperationResponse = {
    id: "op_1",
    kind: "login",
    startedAt: "2026-07-03T00:00:00.000Z",
    status: "running",
    stdout: "",
    stderr: "",
  };

  readonly statusResponse: SafeTunnelStatusResponse = {
    connector: { command: "pi-web-tunnel", state: "available" },
    config: { exists: false, path: "/tmp/pi-web-tunnel/config.json", state: "missing" },
    runtime: { pidFilePath: "/tmp/pi-web-tunnel/connector.pid", state: "stopped" },
  };

  readonly loginResponse: SafeTunnelLoginResponse = {
    operation: this.operationResponse,
    status: { ...this.statusResponse, activeOperation: this.operationResponse },
  };

  readonly startResponse: SafeTunnelStartResponse = {
    accepted: true,
    operation: { ...this.operationResponse, connectorProcessId: 1234, kind: "start" },
    connectorProcessId: 1234,
    status: this.statusResponse,
  };

  readonly stopResponse: SafeTunnelStopResponse = {
    command: { exitCode: 0, stdout: "Stopped\n", stderr: "" },
    status: this.statusResponse,
  };

  readonly login = vi.fn<(request: SafeTunnelLoginRequest) => Promise<SafeTunnelLoginResponse>>(() => Promise.resolve(this.loginResponse));
  readonly operation = vi.fn<(operationId: string) => SafeTunnelOperationResponse | undefined>((operationId) => (operationId === "op_1" ? this.operationResponse : undefined));
  readonly start = vi.fn<(request: SafeTunnelStartRequest) => Promise<SafeTunnelStartResponse>>(() => Promise.resolve(this.startResponse));
  readonly status = vi.fn<() => Promise<SafeTunnelStatusResponse>>(() => Promise.resolve(this.statusResponse));
  readonly stop = vi.fn<() => Promise<SafeTunnelStopResponse>>(() => Promise.resolve(this.stopResponse));
}
