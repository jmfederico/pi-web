import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, getCurrentTools, type AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createAgentSessionRuntime, hasTrustRequiringProjectResources, ProjectTrustStore, SessionManager, type AgentSession } from "../../piSdk.js";
import { createPiSessionManagerGateway } from "../sessions/piSessionManagerGateway.js";
import { PiSessionService, type PiSessionServiceDependencies } from "../sessions/piSessionService.js";
import { CapturingSessionEventHub, createTestModelRuntime, emptyArchiveStore, testModel } from "../sessions/piSessionService.testSupport.js";
import { createManagedMcpConfigService } from "./managedMcpConfig.js";
import { readManagedMcpSession } from "./managedMcpSession.js";

const stdioServer = String.raw`
const readline = require("node:readline").createInterface({ input: process.stdin });
readline.on("close", () => process.exit(0));
readline.on("line", line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const result = request.method === "initialize"
    ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "lifecycle", version: "1" } }
    : request.method === "tools/list"
      ? { tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object", properties: {} } }] }
      : { content: [{ type: "text", text: "echo" }] };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
});
`;

function assistant(): AssistantMessage {
  return {
    role: "assistant", api: "anthropic-messages", provider: testModel().provider, model: testModel().id,
    content: [{ type: "text", text: "Checkpoint answer" }], stopReason: "stop", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

async function fixture(options: { project?: boolean; trusted?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-web-managed-lifecycle-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const configPath = join(root, "web-config.json");
  const observationsPath = join(root, "startup.jsonl");
  const services: PiSessionService[] = [];
  onTestFinished(async () => {
    try {
      for (const service of services) await service.dispose();
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  });
  await mkdir(cwd);
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("PI_OFFLINE", "1");
  await writeFile(observationsPath, "");
  // Public observation only, after all session_start handlers and before any
  // browser refresh or prompt could accidentally repair missing registrations.
  await writeFile(join(agentDir, "extensions", "observe-managed.js"), `
    import { appendFileSync } from "node:fs";
    export default function(pi) {
      pi.on("resources_discover", (_event, ctx) => {
        appendFileSync(${JSON.stringify(observationsPath)}, JSON.stringify({
          id: ctx.sessionManager.getSessionId(), trusted: ctx.isProjectTrusted(),
          servers: pi.getMcpServers().map(server => ({ name: server.name, enabled: server.config.enabled }))
        }) + "\\n");
      });
    }
  `);
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({
    defaultProvider: testModel().provider, defaultModel: testModel().id,
    defaultThinkingLevel: "off", cacheWarming: "off", retry: { enabled: false }, compaction: { enabled: false },
    defaultProjectTrust: "ask",
  }));
  const config = { command: process.execPath, args: ["-e", stdioServer], exposure: "direct" };
  await writeFile(configPath, JSON.stringify({ mcp: {
    servers: { always: config, granted: config, removed: config }, enabledServers: ["always"],
  } }));
  const projectMarker = join(root, "project-process-started");
  async function addProjectConfig() {
    await mkdir(join(cwd, ".pi-web"), { recursive: true });
    const projectConfig = { ...config, args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(projectMarker)}, "started");\n${stdioServer}`] };
    await writeFile(join(cwd, ".pi-web", "config.json"), JSON.stringify({ mcp: { servers: { project_only: projectConfig }, enabledServers: ["project_only"] } }));
  }
  if (options.project === true) {
    await addProjectConfig();
    if (options.trusted === true) new ProjectTrustStore(agentDir).set(cwd, true);
  }
  const modelRuntime = await createTestModelRuntime();
  await modelRuntime.setRuntimeApiKey(testModel().provider, "isolated-test-key");
  const sessions: AgentSession[] = [];
  const requests: { id: string; tools: string[] }[] = [];
  // Keep the production default factory intact, including trust, extension
  // ordering, fork metadata copying and native MCP. Only replace model I/O.
  const createAgentRuntime: NonNullable<PiSessionServiceDependencies["createAgentRuntime"]> = async (factory, args) => {
    if (!(args.sessionManager instanceof SessionManager)) throw new Error("Expected native persistent session manager");
    return createAgentSessionRuntime(async (context) => {
      const result = await factory(context);
      sessions.push(result.session);
      result.session.agent.streamFunction = (_model, context) => {
        requests.push({ id: result.session.sessionId, tools: getCurrentTools(context.messages).map((tool) => tool.name) });
        const message = assistant();
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "done", reason: "stop", message });
        stream.end(message);
        return stream;
      };
      return result;
    }, { cwd: args.cwd, agentDir: args.agentDir, sessionManager: args.sessionManager });
  };
  const hub = new CapturingSessionEventHub();
  function host() {
    const service = new PiSessionService(hub, {
      agentDir, modelRuntime, createAgentRuntime, heartbeatIntervalMs: 60_000, archiveStore: emptyArchiveStore(),
      sessionManager: createPiSessionManagerGateway({ agentDir, env: { PI_CODING_AGENT_SESSION_DIR: join(root, "sessions") } }),
      managedMcpConfig: createManagedMcpConfigService({ env: { PI_WEB_CONFIG: configPath }, cwd }),
    });
    services.push(service);
    return service;
  }
  function session(id: string) {
    const result = [...sessions].reverse().find((entry) => entry.sessionId === id);
    if (!result) throw new Error(`No captured native session ${id}`);
    return result;
  }
  async function observations(): Promise<unknown[]> {
    return (await readFile(observationsPath, "utf8")).trim().split("\n").filter(Boolean).map((line): unknown => JSON.parse(line));
  }
  async function toggle(service: PiSessionService, id: string, serverName: string, enabled: boolean) {
    const view = await service.managedMcpView({ cwd, sessionId: id });
    return service.updateManagedMcp({ cwd, sessionId: id, scope: "session", serverName, enabled, revision: view.revision });
  }
  async function prompt(service: PiSessionService, id: string) {
    await service.prompt({ cwd, id }, "Record a checkpoint");
    await session(id).waitForIdle();
    // Let the host's prompt receipt release its mutation gate after native settlement.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return { cwd, host, session, observations, toggle, prompt, requests, hub, addProjectConfig, projectMarker };
}

describe("managed MCP in the default hosted session lifecycle", () => {
  it("registers for the first prompt, resumes saved grants, and forks earlier history with the latest choices", async () => {
    const f = await fixture();
    let service = f.host();
    const created = await service.start(f.cwd, { name: "Managed MCP lifecycle" });
    const ref = { id: created.id, cwd: f.cwd };
    expect((await f.observations()).at(-1)).toMatchObject({ id: created.id, servers: [
      { name: "always", enabled: true }, { name: "granted", enabled: false }, { name: "removed", enabled: false },
    ] });
    // No MCP polling/refresh before prompting: this proves default-factory order
    // and registration before native first-prompt direct-tool readiness.
    await f.prompt(service, created.id);
    expect(f.requests[0]?.tools).toContain("mcp__always__echo");
    expect(f.requests[0]?.tools).not.toContain("mcp__granted__echo");

    await f.toggle(service, created.id, "removed", true);
    await f.prompt(service, created.id);
    const original = f.session(created.id);
    const checkpoint = [...original.sessionManager.getBranch()].reverse().find((entry) => entry.type === "message" && entry.message.role === "assistant");
    if (!checkpoint) throw new Error("No assistant checkpoint");
    await f.toggle(service, created.id, "removed", false);
    await f.toggle(service, created.id, "granted", true);
    expect(readManagedMcpSession(original.sessionManager)).toEqual(["granted"]);
    const path = original.sessionFile;
    if (path === undefined) throw new Error("Session was not persisted");
    expect(readManagedMcpSession(SessionManager.open(path))).toEqual(["granted"]);

    await service.dispose();
    service = f.host();
    await service.status(ref); // Reopen through the production service/gateway.
    expect((await f.observations()).at(-1)).toMatchObject({ id: created.id, servers: [
      { name: "always", enabled: true }, { name: "granted", enabled: true }, { name: "removed", enabled: false },
    ] });
    const resumed = f.session(created.id);
    expect(readManagedMcpSession(resumed.sessionManager)).toEqual(["granted"]);
    const forked = await service.forkFromTree(ref, { entryId: checkpoint.id, expectedLeafId: resumed.sessionManager.getLeafId() });
    if (forked.cancelled) throw new Error("Fork was cancelled");
    const child = f.session(forked.session.id);
    expect(child.sessionId).not.toBe(created.id);
    expect(child.sessionManager.getBranch().some((entry) => entry.id === checkpoint.id)).toBe(true);
    expect(readManagedMcpSession(child.sessionManager)).toEqual(["granted"]);
    // Inspect startup, not a subsequent management GET (which itself refreshes).
    expect((await f.observations()).at(-1)).toMatchObject({ id: child.sessionId, servers: [
      { name: "always", enabled: true }, { name: "granted", enabled: true }, { name: "removed", enabled: false },
    ] });
    expect(readManagedMcpSession(SessionManager.open(path))).toEqual(["granted"]);
    expect(f.hub.sessionEvents.filter(({ event }) => event.type === "session.error")).toEqual([]);
  }, 20_000);

  it.each([false, true])("gates .pi-web-only project MCP resources on actual project trust (%s)", async (trusted) => {
    const f = await fixture({ project: true, trusted });
    // Pi alone sees no .pi/.agents resources. PI WEB must include its own config
    // in the trust decision rather than inheriting Pi's no-resources=true shortcut.
    expect(hasTrustRequiringProjectResources(f.cwd)).toBe(false);
    const service = f.host();
    const created = await service.start(f.cwd, { name: "Managed trust" });
    const recorded = (await f.observations()).at(-1);
    expect(recorded).toMatchObject({ id: created.id, trusted });
    expect(recorded).toMatchObject({ servers: [
      { name: "always", enabled: true }, { name: "granted", enabled: false }, { name: "removed", enabled: false },
      ...(trusted ? [{ name: "project_only", enabled: true }] : []),
    ] });
    const view = await service.managedMcpView({ cwd: f.cwd, sessionId: created.id });
    expect(view.projectTrusted).toBe(trusted);
    expect(view.servers.some((server) => server.name === "project_only")).toBe(trusted);
    await f.prompt(service, created.id);
    expect(f.requests.at(-1)?.tools.includes("mcp__project_only__echo")).toBe(trusted);
    if (trusted) await expect(readFile(f.projectMarker, "utf8")).resolves.toBe("started");
    else await expect(readFile(f.projectMarker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  }, 20_000);

  it("does not treat an initially empty workspace as trusted when project MCP config appears later", async () => {
    const f = await fixture();
    const service = f.host();
    const created = await service.start(f.cwd, { name: "Late project MCP config" });
    expect((await f.observations()).at(-1)).toMatchObject({ trusted: true });
    await f.addProjectConfig();
    // Both a management refresh and the before-run resolver must reject this
    // new executable config despite the original SDK context's trusted=true.
    const view = await service.managedMcpView({ cwd: f.cwd, sessionId: created.id });
    expect(view.projectTrusted).toBe(false);
    expect(view.servers.some((server) => server.name === "project_only")).toBe(false);
    await f.prompt(service, created.id);
    expect(f.requests.at(-1)?.tools).not.toContain("mcp__project_only__echo");
    await expect(readFile(f.projectMarker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  }, 20_000);
});
