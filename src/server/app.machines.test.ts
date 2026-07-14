import { describe, expect, it, vi } from "vitest";
import type { MachineClient } from "./machines/machineClient.js";
import { PI_WEB_CAPABILITIES } from "../shared/capabilities.js";
import type { PiWebConfigResponse, PiWebConfigValues } from "../shared/apiTypes.js";
import { appTestContext, configFromMachineConfigWriteBody, fakeRemoteClient, fullPiWebConfig, piWebConfigResponse, registerAppTestHooks, selectedMachinePiWebConfig } from "./app.testSupport.js";

registerAppTestHooks();

describe("buildApp machine routes", () => {
  it("lists synthesized local machine through the HTTP contract", async () => {
    const response = await appTestContext.app.inject({ method: "GET", url: "/api/machines" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ machines: [{ id: "local", name: "Local", kind: "local", createdAt: "1970-01-01T00:00:00.000Z", updatedAt: "1970-01-01T00:00:00.000Z" }] });
  });

  it("adds remote machines without exposing tokens", async () => {
    const addResponse = await appTestContext.app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/", token: "secret" } });

    expect(addResponse.statusCode).toBe(200);
    expect(addResponse.json()).toMatchObject({ name: "Remote", kind: "remote", baseUrl: "https://remote.example.test" });
    expect(addResponse.json()).not.toHaveProperty("token");
  });

  it("reports machine health for local and remote machines", async () => {
    const addResponse = await appTestContext.app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    const requestJson: MachineClient["requestJson"] = () => Promise.resolve({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: {
        packageName: "@jmfederico/pi-web",
        generatedAt: "2026-05-25T00:00:00.000Z",
        components: {
          web: { component: "web", label: "Remote Web", stale: false, available: true },
          sessiond: { component: "sessiond", label: "Remote Sessiond", stale: false, available: true },
        },
        release: { packageName: "@jmfederico/pi-web", updateAvailable: false },
        commands: { update: "", restart: "", restartSystemd: "", restartDev: "" },
        messages: [],
      },
    });
    appTestContext.remoteClient = fakeRemoteClient({ requestJson });

    const localHealth = await appTestContext.app.inject({ method: "GET", url: "/api/machines/local/health" });
    const remoteHealth = await appTestContext.app.inject({ method: "GET", url: `/api/machines/${remote.id}/health` });

    expect(localHealth.statusCode).toBe(200);
    expect(localHealth.json()).toMatchObject({ machineId: "local", ok: true, status: "online" });
    expect(remoteHealth.statusCode).toBe(200);
    expect(remoteHealth.json()).toMatchObject({ machineId: remote.id, ok: true, status: "online" });
  });

  it("reports effective machine runtime capabilities for remote machines", async () => {
    const addResponse = await appTestContext.app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    const requestJson = vi.fn<MachineClient["requestJson"]>(() => Promise.resolve({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: {
        packageName: "@jmfederico/pi-web",
        generatedAt: "2026-05-25T00:00:00.000Z",
        components: {
          web: { component: "web", label: "Remote Web", runtimeVersion: "1.0.0", available: true, capabilities: [PI_WEB_CAPABILITIES.sessionsDeleteArchived, PI_WEB_CAPABILITIES.piPackagesManage, PI_WEB_CAPABILITIES.agentProfileConfig, "future.capability"] },
          sessiond: {
            component: "sessiond",
            label: "Remote Sessiond",
            runtimeVersion: "1.0.0",
            available: true,
            capabilities: [PI_WEB_CAPABILITIES.sessionsDeleteArchived],
            activeAgentProfile: {
              schemaVersion: 1,
              revision: `sha256:${"a".repeat(64)}`,
              command: "remote-agent",
              dir: "/srv/remote-agent",
              sessionDirEnvKeys: ["PI_WEB_AGENT_SESSION_DIR"],
            },
          },
        },
        capabilities: [PI_WEB_CAPABILITIES.sessionsDeleteArchived, PI_WEB_CAPABILITIES.piPackagesManage, PI_WEB_CAPABILITIES.agentProfileConfig, "future.capability"],
      },
    }));
    appTestContext.remoteClient = fakeRemoteClient({ requestJson });

    const runtime = await appTestContext.app.inject({ method: "GET", url: `/api/machines/${remote.id}/runtime` });
    const refreshedRuntime = await appTestContext.app.inject({ method: "GET", url: `/api/machines/${remote.id}/runtime?refresh=1` });

    expect(runtime.statusCode).toBe(200);
    expect(refreshedRuntime.statusCode).toBe(200);
    expect(runtime.json()).toMatchObject({
      machineId: remote.id,
      ok: true,
      capabilities: [PI_WEB_CAPABILITIES.sessionsDeleteArchived, PI_WEB_CAPABILITIES.piPackagesManage, PI_WEB_CAPABILITIES.agentProfileConfig],
      components: { sessiond: { activeAgentProfile: { command: "remote-agent", dir: "/srv/remote-agent" } } },
    });
    expect(requestJson).toHaveBeenCalledTimes(2);
    expect(requestJson).toHaveBeenCalledWith("GET", "/api/pi-web/runtime", undefined, { timeoutMs: 3000 });
  });

  it("filters remote selected-machine config reads to machine-safe keys", async () => {
    const addResponse = await appTestContext.app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    const requestJson = vi.fn<MachineClient["requestJson"]>(() => Promise.resolve({
      statusCode: 200,
      headers: { "content-type": "application/json", "set-cookie": "secret=1" },
      body: piWebConfigResponse(fullPiWebConfig()),
    }));
    appTestContext.remoteClient = fakeRemoteClient({ requestJson });

    const response = await appTestContext.app.inject({ method: "GET", url: `/api/machines/${remote.id}/config` });

    expect(response.statusCode).toBe(200);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.json<PiWebConfigResponse>()).toEqual({
      ...piWebConfigResponse(fullPiWebConfig()),
      config: selectedMachinePiWebConfig(),
      effectiveConfig: selectedMachinePiWebConfig(),
    });
    expect(requestJson).toHaveBeenCalledWith("GET", "/api/config");
  });

  it("merges remote selected-machine config updates into the target machine config", async () => {
    const addResponse = await appTestContext.app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    let persistedConfig = fullPiWebConfig();
    const requestJson = vi.fn<MachineClient["requestJson"]>((method, _path, body) => {
      if (method === "GET") return Promise.resolve({ statusCode: 200, headers: { "content-type": "application/json" }, body: piWebConfigResponse(persistedConfig) });
      persistedConfig = configFromMachineConfigWriteBody(body);
      return Promise.resolve({ statusCode: 200, headers: { "content-type": "application/json" }, body: piWebConfigResponse(persistedConfig) });
    });
    appTestContext.remoteClient = fakeRemoteClient({ requestJson });

    const response = await appTestContext.app.inject({
      method: "PUT",
      url: `/api/machines/${remote.id}/config`,
      payload: { config: { plugins: { info: { enabled: false } }, pathAccess: { allowedPaths: ["/srv/remote"] }, uploads: { defaultFolder: "remote\\uploads" }, maxUploadBytes: 4096, spawnSessions: true, agent: { command: "remote-agent", dir: "/srv/remote-agent" } } },
    });

    const expectedMerged: PiWebConfigValues = {
      ...fullPiWebConfig(),
      plugins: { info: { enabled: false } },
      pathAccess: { allowedPaths: ["/srv/remote"] },
      uploads: { defaultFolder: "remote/uploads" },
      maxUploadBytes: 4096,
      spawnSessions: true,
      agent: { command: "remote-agent", dir: "/srv/remote-agent" },
    };
    expect(response.statusCode).toBe(200);
    expect(requestJson).toHaveBeenNthCalledWith(1, "GET", "/api/config");
    expect(requestJson).toHaveBeenNthCalledWith(2, "PUT", "/api/config", { config: expectedMerged });
    expect(response.json<PiWebConfigResponse>().config).toEqual({
      plugins: { info: { enabled: false } },
      pathAccess: { allowedPaths: ["/srv/remote"] },
      uploads: { defaultFolder: "remote/uploads" },
      maxUploadBytes: 4096,
      spawnSessions: true,
      subsessions: false,
      agent: { command: "remote-agent", dir: "/srv/remote-agent" },
    });
  });

  it("rejects a false-success agent profile write from an older remote machine", async () => {
    const addResponse = await appTestContext.app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    const legacyConfig = fullPiWebConfig();
    delete legacyConfig.agent;
    const requestJson = vi.fn<MachineClient["requestJson"]>(() => Promise.resolve({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: piWebConfigResponse(legacyConfig),
    }));
    appTestContext.remoteClient = fakeRemoteClient({ requestJson });

    const response = await appTestContext.app.inject({
      method: "PUT",
      url: `/api/machines/${remote.id}/config`,
      payload: { config: { agent: { command: "remote-agent", dir: "/srv/remote-agent" } } },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: "Remote machine did not persist the requested agent profile",
      machineId: remote.id,
    });
    expect(requestJson).toHaveBeenNthCalledWith(1, "GET", "/api/config");
    expect(requestJson).toHaveBeenNthCalledWith(2, "PUT", "/api/config", {
      config: { ...legacyConfig, agent: { command: "remote-agent", dir: "/srv/remote-agent" } },
    });
  });

  it("verifies an explicit remote profile reset instead of treating an empty profile as no patch", async () => {
    const addResponse = await appTestContext.app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    const requestJson = vi.fn<MachineClient["requestJson"]>((method) => {
      const config = fullPiWebConfig();
      if (method === "PUT") delete config.agent;
      return Promise.resolve({ statusCode: 200, headers: { "content-type": "application/json" }, body: piWebConfigResponse(config) });
    });
    appTestContext.remoteClient = fakeRemoteClient({ requestJson });

    const response = await appTestContext.app.inject({
      method: "PUT",
      url: `/api/machines/${remote.id}/config`,
      payload: { config: { agent: {} } },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "Remote machine did not persist the requested agent profile" });
    expect(requestJson).toHaveBeenNthCalledWith(2, "PUT", "/api/config", {
      config: { ...fullPiWebConfig(), agent: {} },
    });
  });

  it("keeps non-profile selected-machine saves compatible with older remote machines", async () => {
    const addResponse = await appTestContext.app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    const legacyConfig = fullPiWebConfig();
    delete legacyConfig.agent;
    const requestJson = vi.fn<MachineClient["requestJson"]>((method, _path, body) => {
      const config = method === "PUT" ? configFromMachineConfigWriteBody(body) : legacyConfig;
      return Promise.resolve({ statusCode: 200, headers: { "content-type": "application/json" }, body: piWebConfigResponse(config) });
    });
    appTestContext.remoteClient = fakeRemoteClient({ requestJson });

    const response = await appTestContext.app.inject({
      method: "PUT",
      url: `/api/machines/${remote.id}/config`,
      payload: { config: { spawnSessions: true } },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<PiWebConfigResponse>().config.spawnSessions).toBe(true);
  });

  it("preserves foreign-platform agent paths while the target verifies persistence", async () => {
    const addResponse = await appTestContext.app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    const windowsAgent = { command: "C:\\tools\\pi.exe", dir: "C:\\agent-profiles\\work" };
    const requestJson = vi.fn<MachineClient["requestJson"]>((method, _path, body) => {
      const config = method === "PUT" ? configFromMachineConfigWriteBody(body) : fullPiWebConfig();
      return Promise.resolve({ statusCode: 200, headers: { "content-type": "application/json" }, body: piWebConfigResponse(config) });
    });
    appTestContext.remoteClient = fakeRemoteClient({ requestJson });

    const response = await appTestContext.app.inject({
      method: "PUT",
      url: `/api/machines/${remote.id}/config`,
      payload: { config: { agent: windowsAgent } },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<PiWebConfigResponse>().config.agent).toEqual(windowsAgent);
    expect(requestJson).toHaveBeenNthCalledWith(2, "PUT", "/api/config", {
      config: { ...fullPiWebConfig(), agent: windowsAgent },
    });
  });

  it("rejects unsafe remote selected-machine config keys before proxying", async () => {
    const addResponse = await appTestContext.app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    const requestJson = vi.fn<MachineClient["requestJson"]>();
    appTestContext.remoteClient = fakeRemoteClient({ requestJson });

    const response = await appTestContext.app.inject({
      method: "PUT",
      url: `/api/machines/${remote.id}/config`,
      payload: { config: { host: "0.0.0.0", allowedHosts: true, shortcuts: { "core:view.chat": "mod+1" }, spawnSessions: true } },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toContain("PI WEB selected-machine config key is not allowed: host");
    expect(requestJson).not.toHaveBeenCalled();
  });
});
