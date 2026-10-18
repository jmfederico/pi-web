import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, getCurrentTools, type AssistantMessage } from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices,
  SessionManager, SettingsManager, type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { getBuiltinExtensionFactories } from "./builtinExtensionFactories.js";
import { createTestModelRuntime, testModel } from "./piSessionService.testSupport.js";

const endpoint = "https://search.parallel.ai/mcp";
const projectUserAgent = "pi-web (+https://github.com/jmfederico/pi-web)";
const searchTool = "mcp__pi_web_default_search__web_search";
const fetchTool = "mcp__pi_web_default_search__web_fetch";
type Runtime = Awaited<ReturnType<typeof createAgentSessionRuntime>>;
type Session = Runtime["session"];
interface Rpc { id?: number; method: string; params?: { name?: string; arguments?: unknown } }
interface RequestRecord { url: string; method: string; headers: Headers; rpc?: Rpc }

function parseRpc(body: string): Rpc {
  const value: unknown = JSON.parse(body);
  if (typeof value !== "object" || value === null || !("method" in value) || typeof value.method !== "string") {
    throw new Error("Expected a JSON-RPC method");
  }
  const params = "params" in value ? value.params : undefined;
  return {
    method: value.method,
    ...("id" in value && typeof value.id === "number" ? { id: value.id } : {}),
    ...(typeof params === "object" && params !== null ? { params: {
      ...("name" in params && typeof params.name === "string" ? { name: params.name } : {}),
      ...("arguments" in params ? { arguments: params.arguments } : {}),
    } } : {}),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// Use Pi's real loader, MCP HTTP transport, tool dispatcher, and agent loop.
// Only HTTP responses and model streaming are scripted; no inference is claimed.
function serveMcp(call?: (request: RequestRecord, signal?: AbortSignal | null) => Promise<Response>) {
  const requests: RequestRecord[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const request: RequestRecord = {
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      method: init?.method ?? "GET", headers: new Headers(init?.headers),
      ...(typeof init?.body === "string" ? { rpc: parseRpc(init.body) } : {}),
    };
    requests.push(request);
    if (request.method === "GET") return new Response(null, { status: 405 });
    if (request.method === "DELETE" || request.rpc?.method === "notifications/initialized"
      || request.rpc?.method === "notifications/cancelled") return new Response(null, { status: 202 });
    const rpc = request.rpc;
    if (!rpc) throw new Error("Expected a JSON-RPC request");
    let result: unknown;
    if (rpc.method === "initialize") {
      result = { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "Parallel fixture", version: "1" } };
    } else if (rpc.method === "tools/list") {
      result = { tools: [
        { name: "web_search", description: "Search current web sources", inputSchema: { type: "object", properties: { objective: { type: "string" } }, required: ["objective"] } },
        { name: "web_fetch", description: "Fetch web pages by URL", inputSchema: { type: "object", properties: { urls: { type: "array", items: { type: "string" } } }, required: ["urls"] } },
      ] };
    } else if (rpc.method === "tools/call") {
      if (call) return call(request, init?.signal);
      result = { content: [{ type: "text", text: request.rpc?.params?.name === "web_search"
        ? "Current documentation: https://example.org/docs?q=pi&v=1#api"
        : "# Current API\nUse the documented API from https://example.org/docs?q=pi&v=1#api" }] };
    } else throw new Error(`Unexpected MCP request: ${rpc.method}`);
    return Response.json({ jsonrpc: "2.0", id: rpc.id, result });
  });
  vi.stubGlobal("fetch", fetch);
  return requests;
}

interface Profile {
  globalConfig?: string;
  projectConfig?: string;
  credentials?: string;
  extensions?: ExtensionFactory[];
  settings?: Parameters<typeof SettingsManager.inMemory>[0];
}

async function withSession(profile: Profile, run: (session: Session, directory: string, agentDir: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-default-search-"));
  const agentDir = join(directory, "agent");
  let runtime: Runtime | undefined;
  try {
    await mkdir(agentDir);
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("PI_OFFLINE", "1");
    // The anonymous path must not depend on ambient provider keys or user stores.
    vi.stubEnv("PARALLEL_API_KEY", "");
    if (profile.globalConfig !== undefined) await writeFile(join(agentDir, "mcp.json"), profile.globalConfig);
    if (profile.credentials !== undefined) await writeFile(join(agentDir, "mcp-auth.json"), profile.credentials);
    if (profile.projectConfig !== undefined) {
      await mkdir(join(directory, ".pi"));
      await writeFile(join(directory, ".pi", "mcp.json"), profile.projectConfig);
    }
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({
      defaultTools: [], cacheWarming: "off", retry: { enabled: false }, compaction: { enabled: false }, ...profile.settings,
    }));
    const settingsManager = SettingsManager.create(directory, agentDir, { projectTrusted: true });
    const modelRuntime = await createTestModelRuntime();
    await modelRuntime.setRuntimeApiKey("anthropic", "isolated-scripted-model-key");
    const services = await createAgentSessionServices({
      cwd: directory, agentDir, settingsManager, modelRuntime,
      resourceLoaderOptions: {
        extensionFactories: [...await getBuiltinExtensionFactories(), ...profile.extensions ?? []],
        noSkills: true, noPromptTemplates: true, noThemes: true,
        agentsFilesOverride: () => ({ agentsFiles: [] }),
      },
    });
    expect(services.resourceLoader.getExtensions().errors).toEqual([]);
    runtime = await createAgentSessionRuntime(async ({ sessionManager }) => ({
      ...await createAgentSessionFromServices({ services, sessionManager, model: testModel() }),
      services, diagnostics: services.diagnostics,
    }), { cwd: directory, agentDir, sessionManager: SessionManager.inMemory(directory) });
    await runtime.session.bindExtensions({ onError: (error) => { throw new Error(JSON.stringify(error)); } });
    await run(runtime.session, directory, agentDir);
  } finally {
    await runtime?.session.abort();
    await runtime?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}

function script(session: Session, responses: AssistantMessage["content"][], consume?: (messages: readonly unknown[]) => void) {
  let index = 0;
  session.agent.streamFunction = (_model, context) => {
    const content = responses[index++];
    if (!content) throw new Error("Unexpected model request");
    if (index > 1) consume?.(context.messages);
    const names = getCurrentTools(context.messages).map((tool) => tool.name);
    for (const part of content) if (part.type === "toolCall") expect(names).toContain(part.name);
    const stopReason = content.some((part) => part.type === "toolCall") ? "toolUse" : "stop";
    const message: AssistantMessage = {
      role: "assistant", api: "anthropic-messages", provider: "anthropic", model: testModel().id,
      content, stopReason, timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "done", reason: stopReason, message });
    stream.end(message);
    return stream;
  };
}

const discover: AssistantMessage["content"] = [{ type: "toolCall", id: "discover", name: "tool_search", arguments: { query: "mcp__pi_web_default_search web search fetch", limit: 2 } }];
const search: AssistantMessage["content"] = [{ type: "toolCall", id: "search", name: searchTool, arguments: { objective: "Find current documentation" } }];
const done: AssistantMessage["content"] = [{ type: "text", text: "Source read" }];

it("gives a fresh no-key profile deferred search and fetch through the agent loop", async () => {
  const requests = serveMcp();
  await withSession({}, async (session, directory, agentDir) => {
    expect(session.getActiveToolNames()).not.toContain(searchTool);
    const contexts: string[] = [];
    script(session, [discover, search, [{ type: "toolCall", id: "fetch", name: fetchTool,
      arguments: { urls: ["https://example.org/docs?q=pi&v=1#api"] } }], done], (messages) => contexts.push(JSON.stringify(messages)));
    await session.prompt("Find and read the current documentation");
    expect(session.messages).toContainEqual(expect.objectContaining({ role: "toolResult", toolName: searchTool, isError: false }));
    expect(session.messages).toContainEqual(expect.objectContaining({ role: "toolResult", toolName: fetchTool, isError: false }));
    expect(contexts.at(-1)).toContain("# Current API");
    expect(session.getLastAssistantText()).toBe("Source read");
    expect(requests.filter((r) => r.rpc?.method === "tools/call").map((r) => ({
      name: r.rpc?.params?.name, arguments: r.rpc?.params?.arguments,
    }))).toEqual([
      { name: "web_search", arguments: { objective: "Find current documentation" } },
      { name: "web_fetch", arguments: { urls: ["https://example.org/docs?q=pi&v=1#api"] } },
    ]);
    for (const request of requests) {
      expect(request.url).toBe(endpoint);
      expect(request.headers.get("User-Agent")).toBe(projectUserAgent);
      expect(request.headers.has("Authorization")).toBe(false);
    }
    expect(requests.map((r) => r.rpc?.method)).toEqual(expect.arrayContaining(["initialize", "tools/list", "tools/call"]));
    await expect(readFile(join(agentDir, "mcp.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(directory, ".pi", "mcp.json"))).rejects.toMatchObject({ code: "ENOENT" });
    const requestCount = requests.length;
    await writeFile(join(agentDir, "mcp.json"), '{"mcpServers":{}}');
    await session.reload();
    expect(session.getActiveToolNames()).not.toContain(searchTool);
    expect(requests).toHaveLength(requestCount);
  });
});

it.each([
  { name: "empty saved configuration", globalConfig: '{"mcpServers":{}}' },
  { name: "invalid saved configuration", globalConfig: "{" },
  { name: "disabled server", globalConfig: JSON.stringify({ mcpServers: { parallel: { url: endpoint, enabled: false } } }) },
  { name: "project opt-out", projectConfig: '{"mcpServers":{}}' },
  { name: "saved MCP credentials", credentials: "{}" },
  { name: "disabled MCP builtin", settings: { extensions: ["-builtin:mcp"] } },
])("preserves $name without making an HTTP request", async (profile) => {
  const requests = serveMcp();
  await withSession(profile, async (session) => {
    script(session, [done]);
    await session.prompt("Continue without web search");
    expect(session.getActiveToolNames()).not.toContain(searchTool);
    expect(requests).toEqual([]);
  });
});

it("keeps configured credentials and project overrides instead of adding a default", async () => {
  const requests = serveMcp();
  const config = (url: string, token: string) => JSON.stringify({ mcpServers: { chosen: {
    url, headers: { Authorization: `Bearer ${token}` }, exposure: "direct",
  } } });
  await withSession({ globalConfig: config("https://global.example/mcp", "global-choice"),
    projectConfig: config("https://project.example/mcp", "project-choice") }, async (session) => {
    script(session, [done]);
    await session.prompt("Use my saved configuration");
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((r) => r.url === "https://project.example/mcp" && r.headers.get("Authorization") === "Bearer project-choice")).toBe(true);
    expect(session.getActiveToolNames()).not.toContain(searchTool);
  });
});

it("keeps extension-registered servers", async () => {
  const requests = serveMcp();
  const chosen: ExtensionFactory = (pi) => { pi.registerMcpServer("chosen", { url: "https://chosen.example/mcp", exposure: "direct" }); };
  await withSession({ extensions: [chosen] }, async (session) => {
    script(session, [done]);
    await session.prompt("Keep the extension's server");
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((r) => r.url === "https://chosen.example/mcp")).toBe(true);
  });
});

it.each(["chosen", "parallel"])("preserves %s registered by an extension during session_start", async (name) => {
  const requests = serveMcp();
  const chosen: ExtensionFactory = (pi) => { pi.on("session_start", () => {
    pi.registerMcpServer(name, { url: "https://chosen.example/mcp", exposure: "direct" });
  }); };
  await withSession({ extensions: [chosen] }, async (session) => {
    script(session, [done]);
    await session.prompt("Keep the server registered during startup");
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((request) => request.url === "https://chosen.example/mcp")).toBe(true);
  });
});

it("lets an explicit parallel server registered before a prompt replace the default", async () => {
  const requests = serveMcp();
  const chosen: ExtensionFactory = (pi) => { pi.on("before_agent_start", () => {
    pi.registerMcpServer("parallel", { url: "https://chosen.example/mcp", exposure: "direct" });
  }); };
  await withSession({ extensions: [chosen] }, async (session) => {
    script(session, [done]);
    await session.prompt("Keep the explicit Parallel server");
    await expect.poll(() => requests.some((request) => request.url === "https://chosen.example/mcp")).toBe(true);
    expect(session.getActiveToolNames()).not.toContain(searchTool);
    expect(requests.some((request) => request.url === endpoint)).toBe(false);
  });
});

it("withdraws only its own default when an extension registers a server during the session", async () => {
  const requests = serveMcp();
  let selectServer: () => void = () => { throw new Error("Extension not loaded"); };
  const chosen: ExtensionFactory = (pi) => { selectServer = () => {
    pi.registerMcpServer("chosen", { url: "https://chosen.example/mcp", exposure: "direct" });
  }; };
  await withSession({ extensions: [chosen] }, async (session) => {
    script(session, [discover, search, done]);
    await session.prompt("Use default search");
    const count = requests.length;
    selectServer();
    await expect.poll(() => session.getActiveToolNames()).not.toContain(searchTool);
    script(session, [done]);
    await session.prompt("Keep the newly selected server");
    expect(requests.slice(count).some((request) => request.url === "https://chosen.example/mcp")).toBe(true);
    expect(requests.slice(count).some((request) => request.url === endpoint && request.rpc?.method === "tools/call")).toBe(false);
  });
});

it("honors permission hooks before a search reaches HTTP", async () => {
  const requests = serveMcp();
  const deny: ExtensionFactory = (pi) => { pi.on("tool_call", (event) => {
    if (event.toolName === searchTool) return { block: true, reason: "Web access denied" };
    return undefined;
  }); };
  await withSession({ extensions: [deny] }, async (session) => {
    script(session, [discover, search, done]);
    await session.prompt("Try a search");
    expect(requests.some((r) => r.rpc?.method === "tools/call")).toBe(false);
    expect(session.messages).toContainEqual(expect.objectContaining({ role: "toolResult", toolName: searchTool, isError: true }));
    expect(JSON.stringify(session.messages)).toContain("Web access denied");
  });
});

it("surfaces server errors without falling back or inventing results", async () => {
  const requests = serveMcp((request) => Promise.resolve(Response.json({ jsonrpc: "2.0", id: request.rpc?.id, error: { code: -32603, message: "Search failed" } })));
  await withSession({}, async (session) => {
    script(session, [discover, search, done]);
    await session.prompt("Try a search");
    expect(session.messages).toContainEqual(expect.objectContaining({ role: "toolResult", toolName: searchTool, isError: true }));
    expect(JSON.stringify(session.messages)).toContain("Search failed");
    expect(requests.every((r) => r.url === endpoint)).toBe(true);
  });
});

it.each(["cancellation", "timeout"])("cancels a pending MCP search on %s", async (mode) => {
  let signal: AbortSignal | null | undefined;
  let markStarted: () => void = () => { throw new Error("Start signal not initialized"); };
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const requests = serveMcp((_request, requestSignal) => {
    signal = requestSignal;
    markStarted();
    return new Promise<Response>((_resolve, reject) => {
      requestSignal?.addEventListener("abort", () => { reject(new Error("HTTP connection closed")); }, { once: true });
    });
  });
  await withSession({}, async (session) => {
    if (mode === "timeout") vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    script(session, [discover, search, done]);
    const prompt = session.prompt("Search until cancelled or timed out");
    await started;
    if (mode === "cancellation") await session.abort();
    else await vi.advanceTimersByTimeAsync(30_001);
    await prompt;
    expect(requests.some((request) => request.rpc?.method === "notifications/cancelled")).toBe(true);
    if (mode === "timeout") {
      expect(session.messages).toContainEqual(expect.objectContaining({ role: "toolResult", toolName: searchTool, isError: true }));
      expect(JSON.stringify(session.messages)).toMatch(/timed out|timeout/i);
    }
  });
  // Pi keeps its shared HTTP connection until session shutdown; each cancelled
  // request sends MCP cancellation and cannot append a late tool result.
  expect(signal?.aborted).toBe(true);
});
