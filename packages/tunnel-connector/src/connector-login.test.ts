import { describe, expect, it } from "vitest";

import { createDefaultConnectorConfig, type ConnectorConfig } from "./config-storage.js";
import {
  applyConnectorLoginResultToConfig,
  connectorLoginClientVersion,
  runConnectorLoginFlow,
  type ConnectorLoginResult,
} from "./connector-login.js";
import type { FetchLike, FetchLikeRequestInit, FetchLikeResponse } from "./connector-runtime.js";

interface ObservedFetchRequest {
  readonly body?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly input: string;
  readonly method?: string;
}

interface CapturedSink {
  readonly output: () => string;
  readonly sink: { write(chunk: string): void };
}

function createCapturedSink(): CapturedSink {
  let output = "";

  return {
    output: () => output,
    sink: {
      write(chunk): void {
        output = `${output}${chunk}`;
      },
    },
  };
}

function createJsonResponse(status: number, body: unknown): FetchLikeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  };
}

function createSequencedFetch(responses: readonly FetchLikeResponse[]): {
  readonly fetch: FetchLike;
  readonly requests: () => readonly ObservedFetchRequest[];
} {
  const requests: ObservedFetchRequest[] = [];
  let responseIndex = 0;

  return {
    requests: () => requests,
    fetch(input: string, init?: FetchLikeRequestInit): Promise<FetchLikeResponse> {
      requests.push({
        input,
        ...(init?.method === undefined ? {} : { method: init.method }),
        ...(init?.headers === undefined ? {} : { headers: init.headers }),
        ...(init?.body === undefined ? {} : { body: init.body }),
      });
      const response = responses[responseIndex];
      responseIndex += 1;

      if (response === undefined) {
        return Promise.reject(new Error(`unexpected fetch call to ${input}`));
      }

      return Promise.resolve(response);
    },
  };
}

function createStartedDeviceAuthResponse(): unknown {
  return {
    deviceCode: "piwt_dcode_v1_device",
    userCode: "ABCD-EFGH",
    verificationUri: "https://control.local/device",
    verificationUriComplete: "https://control.local/device?user_code=ABCD-EFGH",
    expiresAt: "2026-07-03T12:10:00.000Z",
    intervalSeconds: 5,
  };
}

function createCompletedDeviceAuthResponse(): unknown {
  return {
    accessToken: "piwt_cat_v1_access",
    tokenType: "Bearer",
    expiresAt: "2026-07-03T12:15:00.000Z",
    account: {
      id: "acct_123",
      publicNamespace: "ns-abc123",
    },
  };
}

function createRegisteredMachineResponse(): unknown {
  return {
    machine: {
      id: "machine_123",
      accountId: "acct_123",
      name: "My Dev Box",
      slug: "my-dev-box",
    },
    publicHostname: "my-dev-box.ns-abc123.tunnels.pi-web.dev",
    publicUrl: "https://my-dev-box.ns-abc123.tunnels.pi-web.dev",
    machineToken: "piwt_mtok_v1_machine",
    tunnelConfigUrl: "/v1/machines/machine_123/tunnel-config",
  };
}

function createLoginResult(): ConnectorLoginResult {
  return {
    machineCredentials: {
      controlApiBaseUrl: "https://control.local/",
      machineId: "machine_123",
      machineToken: "piwt_mtok_v1_machine",
      machineSlug: "my-dev-box",
      publicUrl: "https://my-dev-box.ns-abc123.tunnels.pi-web.dev",
    },
    registeredMachine: {
      machine: {
        id: "machine_123",
        accountId: "acct_123",
        name: "My Dev Box",
        slug: "my-dev-box",
      },
      publicHostname: "my-dev-box.ns-abc123.tunnels.pi-web.dev",
      publicUrl: "https://my-dev-box.ns-abc123.tunnels.pi-web.dev",
      machineToken: "piwt_mtok_v1_machine",
      tunnelConfigUrl: "/v1/machines/machine_123/tunnel-config",
    },
  };
}

describe("connector login flow", () => {
  it("starts device auth, polls until approval, registers the machine, and returns credentials", async () => {
    const stdout = createCapturedSink();
    const sleeps: number[] = [];
    const fetch = createSequencedFetch([
      createJsonResponse(202, createStartedDeviceAuthResponse()),
      createJsonResponse(409, {
        error: {
          code: "authorization_pending",
          message: "Connector device authorization is still pending approval",
        },
      }),
      createJsonResponse(200, createCompletedDeviceAuthResponse()),
      createJsonResponse(201, createRegisteredMachineResponse()),
    ]);

    const result = await runConnectorLoginFlow({
      controlApiBaseUrl: "https://control.local/",
      machineName: "My Dev Box",
      machineSlug: "my-dev-box",
      localPiWebUrl: "http://127.0.0.1:8504",
      connectorVersion: connectorLoginClientVersion,
      fetch: fetch.fetch,
      now: () => new Date("2026-07-03T12:00:00.000Z"),
      sleep: (milliseconds) => {
        sleeps.push(milliseconds);
        return Promise.resolve();
      },
      stdout: stdout.sink,
    });

    expect(result).toEqual(createLoginResult());
    expect(sleeps).toEqual([5000]);
    expect(fetch.requests()).toEqual([
      {
        input: "https://control.local/v1/device/start",
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: "{\"connectorVersion\":\"pi-web-tunnel/0.0.0\"}",
      },
      {
        input: "https://control.local/v1/device/complete",
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: "{\"deviceCode\":\"piwt_dcode_v1_device\"}",
      },
      {
        input: "https://control.local/v1/device/complete",
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: "{\"deviceCode\":\"piwt_dcode_v1_device\"}",
      },
      {
        input: "https://control.local/v1/machines",
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: "Bearer piwt_cat_v1_access",
        },
        body: "{\"name\":\"My Dev Box\",\"slug\":\"my-dev-box\",\"localPiWebUrl\":\"http://127.0.0.1:8504\",\"connectorVersion\":\"pi-web-tunnel/0.0.0\"}",
      },
    ]);
    expect(stdout.output()).toContain("https://control.local/device?user_code=ABCD-EFGH\n");
    expect(stdout.output()).toContain("User code: ABCD-EFGH\n");
    expect(stdout.output()).toContain("Connector authorization approved.\n");
  });

  it("surfaces Control API errors while polling", async () => {
    const stdout = createCapturedSink();
    const fetch = createSequencedFetch([
      createJsonResponse(202, createStartedDeviceAuthResponse()),
      createJsonResponse(403, {
        error: {
          code: "authorization_denied",
          message: "Connector device authorization was denied",
        },
      }),
    ]);

    await expect(
      runConnectorLoginFlow({
        controlApiBaseUrl: "https://control.local",
        machineName: "My Dev Box",
        machineSlug: "my-dev-box",
        localPiWebUrl: "http://127.0.0.1:8504",
        fetch: fetch.fetch,
        now: () => new Date("2026-07-03T12:00:00.000Z"),
        sleep: () => Promise.resolve(),
        stdout: stdout.sink,
      }),
    ).rejects.toThrow("authorization_denied");
  });

  it("merges successful login credentials into the existing connector config", () => {
    const existing: ConnectorConfig = {
      ...createDefaultConnectorConfig(),
      localPiWebUrl: "http://127.0.0.1:9000",
      frpcPath: "/usr/local/bin/frpc",
    };

    expect(
      applyConnectorLoginResultToConfig(
        existing,
        {
          controlApiBaseUrl: "https://control.local/",
          machineName: "My Dev Box",
          machineSlug: "my-dev-box",
        },
        createLoginResult(),
      ),
    ).toEqual({
      localPiWebUrl: "http://127.0.0.1:9000",
      schemaVersion: 2,
      frpcPath: "/usr/local/bin/frpc",
      machine: {
        controlApiBaseUrl: "https://control.local/",
        machineId: "machine_123",
        machineToken: "piwt_mtok_v1_machine",
        machineSlug: "my-dev-box",
        publicUrl: "https://my-dev-box.ns-abc123.tunnels.pi-web.dev",
      },
    });
  });
});
