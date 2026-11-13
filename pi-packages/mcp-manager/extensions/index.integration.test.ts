import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssistantMessageEventStream, getCurrentTools, type AssistantMessage } from "@earendil-works/pi-ai";
import { createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices, createEventBus, createMcpExtension, ProjectTrustStore, SessionManager, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createTestModelRuntime, stdioServer, testModel } from "../testSupport.js";
import { readManagedMcpSession, writeManagedMcpSession } from "../session.js";
import { MCP_MANAGER_REQUEST, MCP_MANAGER_RESPONSE, type McpManagerResponse } from "../shared.js";
import { SESSION_STATE_RESET_CUSTOM_TYPE } from "../../../src/shared/sessionState.js";

async function fixture(options: { project?: boolean; savedTrust?: boolean; piTrusted?: boolean; globalDefaultTrust?: "always"; projectDefaultTrust?: "always" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "mcp-manager-extension-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const errors: unknown[] = [];
  const observations: { trusted: boolean; defaultTrust: string; names: string[] }[] = [];
  let runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>> | undefined;
  onTestFinished(async () => {
    try { await runtime?.dispose(); runtime = undefined; }
    finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
  });
  await mkdir(cwd);
  await mkdir(join(agentDir, "mcp-manager"), { recursive: true });
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("PI_OFFLINE", "1");
  vi.stubEnv("PI_MCP_MANAGER", undefined);
  const config = { command: process.execPath, args: ["-e", stdioServer], exposure: "direct" };
  const globalPath = join(agentDir, "mcp-manager", "config.json");
  await writeFile(globalPath, JSON.stringify({ servers: { always: config, granted: config, removed: config, "native-alias": config }, enabledServers: ["always", "native-alias"] }));
  // Native ownership wins even when normalization aliases the package's spelling.
  await writeFile(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { native_alias: { ...config, enabled: false } } }));
  const projectMarker = join(root, "project-started");
  async function addProjectConfig() {
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(join(cwd, ".pi", "mcp-manager.json"), JSON.stringify({
      servers: { project_only: { ...config, args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(projectMarker)}, "started");\n${stdioServer}`] } },
      enabledServers: ["project_only"],
    }));
  }
  if (options.project === true) await addProjectConfig();
  if (options.projectDefaultTrust !== undefined) {
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({ defaultProjectTrust: options.projectDefaultTrust }));
  }
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({
    defaultTools: [], cacheWarming: "off", defaultProjectTrust: options.globalDefaultTrust ?? "ask",
    retry: { enabled: false }, compaction: { enabled: false },
  }));
  if (options.savedTrust !== undefined) new ProjectTrustStore(agentDir).set(cwd, options.savedTrust);
  const modelRuntime = await createTestModelRuntime();
  await modelRuntime.setRuntimeApiKey(testModel().provider, "isolated-test-key");
  const bus = createEventBus();
  const requests: string[][] = [];
  let onRequest: (() => void) | undefined;
  function setTransport(session: AgentSession) {
    session.agent.streamFunction = (_model, context) => {
      requests.push(getCurrentTools(context.messages).map((tool) => tool.name));
      onRequest?.();
      const message: AssistantMessage = {
        role: "assistant", api: "anthropic-messages", provider: testModel().provider, model: testModel().id,
        content: [{ type: "text", text: "Checkpoint" }], stopReason: "stop", timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: "stop", message });
      stream.end(message);
      return stream;
    };
  }
  runtime = await createAgentSessionRuntime(async ({ sessionManager, sessionStartEvent }) => {
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const services = await createAgentSessionServices({
      cwd, agentDir, settingsManager, modelRuntime,
      resourceLoaderOptions: {
        eventBus: bus,
        // Load the real standalone entry through Pi's public file loader. There is
        // no web server, management service, session host, or plugin in this test.
        additionalExtensionPaths: [fileURLToPath(new URL("./index.ts", import.meta.url))],
        extensionFactories: [createMcpExtension(), (pi) => {
          pi.on("resources_discover", (_event, ctx) => {
            observations.push({ trusted: ctx.isProjectTrusted(), defaultTrust: pi.getSettings().defaultProjectTrust ?? "ask", names: pi.getMcpServers().map((server) => server.name) });
          });
        }],
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      },
      // Explicitly exercise a host/CLI trust result, including Pi's true result
      // for an empty workspace. The package must not confuse it with consent.
      resourceLoaderReloadOptions: { resolveProjectTrust: () => Promise.resolve(options.piTrusted ?? true) },
    });
    expect(services.resourceLoader.getExtensions().errors).toEqual([]);
    const result = await createAgentSessionFromServices({ services, sessionManager, ...(sessionStartEvent === undefined ? {} : { sessionStartEvent }), model: testModel() });
    setTransport(result.session);
    return { ...result, services, diagnostics: services.diagnostics };
  }, { cwd, agentDir, sessionManager: SessionManager.create(cwd, join(root, "sessions")) });
  const activeRuntime = runtime;
  async function bind() { await activeRuntime.session.bindExtensions({ onError: (error) => errors.push(error) }); }
  await bind();
  let serial = 0;
  function request(action: "refresh" | "view"): Promise<McpManagerResponse> {
    const id = String(++serial);
    return new Promise((resolve) => {
      const off = bus.on(MCP_MANAGER_RESPONSE, (data) => {
        // The bus is deliberately untyped; this test consumes only the package response channel.
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
        const response = data as McpManagerResponse;
        if (response.id !== id) return;
        off(); resolve(response);
      });
      bus.emit(MCP_MANAGER_REQUEST, { id, action });
    });
  }
  return { cwd, globalPath, projectMarker, addProjectConfig, runtime: activeRuntime, bind, request, requests, errors, observations, onRequest: (handler: (() => void) | undefined) => { onRequest = handler; } };
}

describe("standalone MCP manager extension", () => {
  it("loads files before first prompt without a backend and preserves latest choices through resume and TUI forks", async () => {
    const f = await fixture();
    expect(f.observations.at(-1)?.names).toEqual(["always", "granted", "removed"]);
    await f.runtime.session.prompt("First checkpoint");
    expect(f.requests[0]).toContain("mcp__always__echo");
    expect(f.requests[0]).not.toContain("mcp__native_alias__echo");
    expect(f.requests[0]).not.toContain("mcp__granted__echo");
    writeManagedMcpSession(f.runtime.session.sessionManager, ["removed"]);
    await f.runtime.session.prompt("Second checkpoint");
    const parent = f.runtime.session;
    const checkpoint = parent.sessionManager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "user");
    if (!checkpoint) throw new Error("Missing checkpoint");
    writeManagedMcpSession(parent.sessionManager, ["granted"]);
    const originalFile = parent.sessionFile;
    if (originalFile === undefined) throw new Error("Missing persisted session");
    // A resumed session must restore choices before any management request.
    await f.runtime.switchSession(originalFile);
    await f.bind();
    expect(readManagedMcpSession(f.runtime.session.sessionManager)).toEqual(["granted"]);
    await f.runtime.session.prompt("Resumed checkpoint");
    expect(f.requests.at(-1)).toContain("mcp__granted__echo");
    expect(f.requests.at(-1)).not.toContain("mcp__removed__echo");
    await f.runtime.fork(checkpoint.id);
    await f.bind();
    expect(readManagedMcpSession(f.runtime.session.sessionManager)).toEqual(["granted"]);
    await f.runtime.session.prompt("Fork checkpoint");
    expect(f.requests.at(-1)).toContain("mcp__granted__echo");
    expect(f.requests.at(-1)).not.toContain("mcp__removed__echo");
    expect(readManagedMcpSession(SessionManager.open(originalFile))).toEqual(["granted"]);
    expect(f.errors).toEqual([]);
  }, 20_000);

  it("uses the optional safe protocol, defers busy refreshes, and honors generic state resets", async () => {
    const f = await fixture();
    writeManagedMcpSession(f.runtime.session.sessionManager, ["granted"]);
    const ready = await f.request("refresh");
    if (!("state" in ready)) throw new Error(ready.error);
    expect(ready.state.pending).toBe(false);
    expect(ready.state.servers.find((server) => server.name === "granted")?.enabled).toBe(true);
    let refresh: Promise<McpManagerResponse> | undefined;
    f.onRequest(() => {
      f.onRequest(undefined);
      f.runtime.session.sessionManager.appendCustomEntry(SESSION_STATE_RESET_CUSTOM_TYPE, { version: 1 });
      refresh = f.request("refresh");
    });
    await f.runtime.session.prompt("Refresh while busy");
    expect(await refresh).toMatchObject({ state: { pending: true } });
    const settled = await f.request("view");
    if (!("state" in settled)) throw new Error(settled.error);
    expect(settled.state.pending).toBe(false);
    expect(settled.state.servers.find((server) => server.name === "granted")).toMatchObject({ enabled: false, registeredEnabled: false });
    await writeFile(f.globalPath, '{ "Authorization": "secret-invalid-json');
    const failed = await f.request("refresh");
    expect(failed).toMatchObject({ state: { servers: [], errors: [{ code: "resolve_failed" }] } });
    expect(JSON.stringify(failed)).not.toMatch(/Authorization|secret-invalid-json/);
    expect(f.errors).toEqual([]);
  }, 20_000);

  it.each([false, true])("requires actual saved approval for config-only workspaces (saved=%s)", async (savedTrust) => {
    const f = await fixture({ project: true, savedTrust });
    expect(f.observations.at(-1)?.trusted).toBe(true); // SDK's no-native-resources shortcut.
    expect(f.observations.at(-1)?.names.includes("project_only")).toBe(savedTrust);
    expect(await f.request("view")).toMatchObject({ projectTrusted: savedTrust });
    await f.runtime.session.prompt("Check project tools");
    expect(f.requests.at(-1)?.includes("mcp__project_only__echo")).toBe(savedTrust);
    if (savedTrust) await expect(readFile(f.projectMarker, "utf8")).resolves.toBe("started");
    else await expect(readFile(f.projectMarker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  }, 20_000);

  it("does not convert empty-workspace auto-trust into approval when native resources appear before reload", async () => {
    const f = await fixture();
    expect(f.observations.at(-1)?.trusted).toBe(true);
    await f.addProjectConfig();
    await writeFile(join(f.cwd, ".pi", "settings.json"), "{}");
    expect(await f.request("refresh")).toMatchObject({ projectTrusted: false });
    await f.runtime.session.reload();
    expect(f.observations.at(-1)?.trusted).toBe(true);
    expect(f.observations.at(-1)?.names).not.toContain("project_only");
    expect(await f.request("view")).toMatchObject({ projectTrusted: false });
    await f.runtime.session.prompt("Check late project tools");
    expect(f.requests.at(-1)).not.toContain("mcp__project_only__echo");
    await expect(readFile(f.projectMarker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  }, 20_000);

  it("does not accept project settings that grant themselves default trust", async () => {
    const f = await fixture({ project: true, projectDefaultTrust: "always" });
    // The SDK's merged settings contain the spoofed policy, but only the global
    // settings file may authorize this package's executable project config.
    expect(f.observations.at(-1)).toMatchObject({ trusted: true, defaultTrust: "always" });
    expect(f.observations.at(-1)?.names).not.toContain("project_only");
    expect(await f.request("view")).toMatchObject({ projectTrusted: false });
    await f.runtime.session.prompt("Unapproved project settings");
    await expect(readFile(f.projectMarker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  }, 20_000);

  it("accepts global default trust without a saved decision", async () => {
    const f = await fixture({ project: true, globalDefaultTrust: "always" });
    expect(f.observations.at(-1)?.names).toContain("project_only");
    expect(await f.request("view")).toMatchObject({ projectTrusted: true });
    await f.runtime.session.prompt("Globally approved project");
    expect(f.requests.at(-1)).toContain("mcp__project_only__echo");
    await expect(readFile(f.projectMarker, "utf8")).resolves.toBe("started");
  }, 20_000);

  it("does not let saved trust bypass a live denial", async () => {
    const f = await fixture({ project: true, savedTrust: true, piTrusted: false });
    expect(f.observations.at(-1)?.names).not.toContain("project_only");
    expect(await f.request("view")).toMatchObject({ projectTrusted: false });
    await f.runtime.session.prompt("Denied project");
    await expect(readFile(f.projectMarker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  }, 20_000);
});
