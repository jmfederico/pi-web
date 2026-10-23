import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSessionServices, createAgentSessionFromServices, createAgentSessionRuntime, createMcpExtension, SessionManager, SettingsManager, type ExtensionUIContext } from "../../piSdk.js";
import { expect, it, vi } from "vitest";
import { McpAuthFlowService } from "./mcpAuthFlowService.js";
import { createTestModelRuntime, testModel } from "./piSessionService.testSupport.js";

it.each(["manual", "browser", "cancel", "invalid", "cancel-exchange"] as const)("real SDK OAuth through MCP flow transport: %s", async (mode) => {
  const root = await mkdtemp(join(tmpdir(), "mcp-ui-oauth-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("PI_OFFLINE", "1");
  const flows = new McpAuthFlowService();
  const calls: { kind: string; scoped: boolean }[] = [];
  let authorization: URL | undefined;
  let tokenRequests = 0;
  let authenticatedConnections = 0;
  let inputAborted = false;
  let releaseToken: (() => void) | undefined;
  const tokenGate = mode === "cancel-exchange" ? new Promise<void>((resolve) => { releaseToken = resolve; }) : Promise.resolve();
  const serverErrors: unknown[] = [];
  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => { serverErrors.push(error); res.statusCode = 500; res.end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No fixture address");
  const base = `http://127.0.0.1:${String(address.port)}`;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      const value: unknown = chunk;
      if (typeof value === "string") chunks.push(Buffer.from(value));
      else if (Buffer.isBuffer(value)) chunks.push(value);
      else throw new Error("Unexpected HTTP body chunk");
    }
    const json = (value: unknown) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(value)); };
    const path = new URL(req.url ?? "/", base).pathname;
    if (path.startsWith("/.well-known/oauth-protected-resource")) {
      json({ resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ["read"] }); return;
    }
    if (path === "/.well-known/oauth-authorization-server") {
      json({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, response_types_supported: ["code"], grant_types_supported: ["authorization_code"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] }); return;
    }
    if (path === "/token") {
      tokenRequests++;
      await tokenGate;
      json({ access_token: "probe-access", token_type: "Bearer", expires_in: 3600, refresh_token: "probe-refresh" }); return;
    }
    if (path === "/mcp") {
      if (req.method !== "POST") { res.statusCode = req.method === "DELETE" ? 204 : 405; res.end(); return; }
      if (req.headers.authorization !== "Bearer probe-access") {
        res.statusCode = 401; res.setHeader("www-authenticate", `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`);
        json({ error: "unauthorized" }); return;
      }
      const rpc: unknown = JSON.parse(Buffer.concat(chunks).toString());
      if (!isRecord(rpc)) throw new Error("Invalid fixture RPC");
      if (rpc["id"] === undefined) { res.statusCode = 202; res.end(); return; }
      if (rpc["method"] === "initialize") {
        authenticatedConnections++;
        const params = rpc["params"];
        if (!isRecord(params)) throw new Error("Invalid initialize params");
        json({ jsonrpc: "2.0", id: rpc["id"], result: { protocolVersion: params["protocolVersion"], capabilities: { tools: {} }, serverInfo: { name: "probe", version: "1" } } }); return;
      }
      if (rpc["method"] === "tools/list") { json({ jsonrpc: "2.0", id: rpc["id"], result: { tools: [] } }); return; }
    }
    res.statusCode = 404; res.end();
  }

  let runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>> | undefined;
  try {
    const settingsManager = SettingsManager.inMemory({ defaultTools: [], retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" });
    const services = await createAgentSessionServices({ cwd: root, agentDir, settingsManager, modelRuntime: await createTestModelRuntime(), resourceLoaderOptions: {
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, agentsFilesOverride: () => ({ agentsFiles: [] }),
      extensionFactories: [createMcpExtension({
        loadConfig: () => ({ servers: ["alpha", "beta"].map((name) => ({ name, source: "probe", config: { url: `${base}/mcp`, exposure: "direct", oauth: { clientId: "probe-client" } } })), errors: [] }),
        openUrl: (url) => {
          calls.push({ kind: "openUrl", scoped: McpAuthFlowService.current() !== undefined });
          authorization = new URL(url);
          required(McpAuthFlowService.current()).openUrl(url);
        },
      })],
    } });
    runtime = await createAgentSessionRuntime(async ({ sessionManager }) => ({ ...await createAgentSessionFromServices({ services, sessionManager, model: testModel() }), services, diagnostics: services.diagnostics }), { cwd: root, agentDir, sessionManager: SessionManager.inMemory(root) });
    const session = runtime.session;
    session.agent.streamFunction = () => { throw new Error("Model must not be called"); };
    const ui = new Proxy(session.extensionRunner.getUIContext(), {
      get(target, property, receiver): unknown {
        if (property === "notify") return (message: string) => { McpAuthFlowService.current(session)?.notify(message); };
        if (property === "select") return (title: string, options: string[]) => {
          calls.push({ kind: "select", scoped: McpAuthFlowService.current(session) !== undefined });
          return required(McpAuthFlowService.current(session)).select(title, options);
        };
        if (property === "input") return (title: string, placeholder: string, options: { signal?: AbortSignal }) => {
          calls.push({ kind: "input", scoped: McpAuthFlowService.current(session) !== undefined });
          options.signal?.addEventListener("abort", () => { inputAborted = true; }, { once: true });
          return required(McpAuthFlowService.current(session)).input(title, placeholder, options);
        };
        const value: unknown = Reflect.get(target, property, receiver);
        return value;
      },
    }) satisfies ExtensionUIContext;
    await session.bindExtensions({ mode: "rpc", uiContext: ui, onError: (error) => { required(McpAuthFlowService.current(session)).error(error.error); } });
    const flow = flows.start({ sessionId: session.sessionId, identity: session, isCurrent: () => true, run: () => session.prompt("/mcp login") });
    await vi.waitFor(() => { expect(flows.get(flow.flowId).select).toBeDefined(); });
    flows.respond(flow.flowId, required(flows.get(flow.flowId).select).requestId, "alpha");
    await vi.waitFor(() => { expect(flows.get(flow.flowId).prompt).toBeDefined(); });
    const url = required(authorization);
    expect(flows.get(flow.flowId).auth?.url).toBe(url.href);
    const redirect = new URL(required(url.searchParams.get("redirect_uri")));
    redirect.searchParams.set("code", "probe-code");
    redirect.searchParams.set("state", mode === "invalid" ? "wrong-state" : required(url.searchParams.get("state")));
    redirect.searchParams.set("iss", base);
    if (mode === "browser" || mode === "cancel-exchange") await fetch(redirect);
    else if (mode === "cancel") expect(flows.cancel(flow.flowId)).toMatchObject({ status: "running", cancelRequested: true });
    else flows.respond(flow.flowId, required(flows.get(flow.flowId).prompt).requestId, redirect.href);
    if (mode === "cancel-exchange") {
      await vi.waitFor(() => { expect(tokenRequests).toBe(1); });
      expect(flows.cancel(flow.flowId)).toMatchObject({ status: "running", cancelRequested: true });
      required(releaseToken)();
    }
    await vi.waitFor(() => { expect(flows.get(flow.flowId).status).toBe("complete"); });
    expect(calls).toEqual(["select", "openUrl", "input"].map((kind) => ({ kind, scoped: true })));
    expect(flows.get(flow.flowId).prompt).toBeUndefined();
    expect(flows.get(flow.flowId).progress).toHaveLength(1);
    expect(flows.get(flow.flowId).cancelRequested).toBe(mode === "cancel" || mode === "cancel-exchange" ? true : undefined);
    if (mode === "manual" || mode === "browser" || mode === "cancel-exchange") {
      expect(tokenRequests).toBe(1); expect(authenticatedConnections).toBe(1);
      expect(await readFile(join(agentDir, "mcp-auth.json"), "utf8")).toContain("probe-access");
      expect(flows.get(flow.flowId).progress[0]).toContain('Signed in to MCP server "alpha"');
    } else {
      expect(tokenRequests).toBe(0); expect(authenticatedConnections).toBe(0);
      expect(flows.get(flow.flowId).progress[0]).toContain(mode === "cancel" ? "Sign-in cancelled." : "Sign-in failed:");
    }
    if (mode === "browser" || mode === "cancel-exchange") expect(inputAborted).toBe(true);
    await expect(fetch(redirect)).rejects.toThrow();
    if (mode === "manual") {
      const credentials = await readFile(join(agentDir, "mcp-auth.json"), "utf8");
      const messagesBefore = [...session.messages];
      const callsBefore = [...calls];
      const servers = await flows.discover({
        sessionId: session.sessionId, identity: session, isCurrent: () => true,
        run: async () => {
          await session.prompt("/mcp");
          return session.extensionRunner.getRegisteredCommands().find((command) => command.invocationName === "mcp")?.getArgumentCompletions?.("login ");
        },
      });
      expect(servers?.map((item) => item.value)).toEqual(["login alpha", "login beta"]);
      expect(await readFile(join(agentDir, "mcp-auth.json"), "utf8")).toBe(credentials);
      expect(session.messages).toEqual(messagesBefore);
      expect(calls).toEqual(callsBefore);
      expect(tokenRequests).toBe(1);

      // Let Pi reuse its own cached credentials, without a force-reauth option.
      const reuse = flows.start({ sessionId: session.sessionId, identity: session, isCurrent: () => true, run: () => session.prompt("/mcp login alpha") });
      await vi.waitFor(() => { expect(flows.get(reuse.flowId).status).toBe("complete"); });
      expect(flows.get(reuse.flowId).auth).toBeUndefined();
      expect(calls).toEqual(callsBefore);
      // Pi may refresh tokens as part of sign-in; no browser is required.
      expect(tokenRequests).toBe(2);

      const logout = flows.start({ sessionId: session.sessionId, identity: session, isCurrent: () => true, run: () => session.prompt("/mcp logout alpha") });
      await vi.waitFor(() => { expect(flows.get(logout.flowId).status).toBe("complete"); });
      expect(await readFile(join(agentDir, "mcp-auth.json"), "utf8")).not.toContain("probe-access");
      expect(flows.get(logout.flowId).progress).toEqual(['Signed out of MCP server "alpha".']);
      expect(flows.get(logout.flowId).progress.join(" ")).not.toMatch(/revok/iu);
    }
    expect(serverErrors).toEqual([]);
  } finally {
    releaseToken?.();
    flows.dispose();
    await runtime?.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => { if (error) reject(error); else resolve(); }));
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);

function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error("Expected fixture value");
  return value;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
