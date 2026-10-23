import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, getCurrentTools, type AssistantMessage } from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices,
  DefaultResourceLoader, SessionManager, SettingsManager,
} from "../../piSdk.js";
import { expect, it, vi } from "vitest";
import { getBuiltinExtensionFactories } from "./builtinExtensionFactories.js";
import { createTestModelRuntime, testModel } from "./piSessionService.testSupport.js";

// Real stdio JSON-RPC and SDK lifecycle; only the model transport is stubbed.
const mcpFixture = String.raw`
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
const markers = process.argv[2];
writeFileSync(join(markers, process.pid + ".started"), "started");
process.on("exit", () => writeFileSync(join(markers, process.pid + ".stopped"), "stopped"));
process.on("SIGTERM", () => process.exit(0));
const lines = createInterface({ input: process.stdin });
lines.on("close", () => process.exit(0));
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return; // notifications/initialized
  let result;
  switch (request.method) {
    case "initialize":
      result = {
        protocolVersion: request.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "regression-fixture", version: "1.0.0" },
      };
      break;
    case "tools/list":
      result = { tools: [{
        name: "regression_echo", description: "Echo a regression marker for lifecycle checks",
        inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
      }] };
      break;
    case "tools/call":
      if (request.params.name !== "regression_echo") throw new Error("Unexpected tool");
      result = { content: [{ type: "text", text: "fixture:" + request.params.arguments.value + ":" + process.pid }] };
      break;
    default:
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } }) + "\n");
      return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
});
`;

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

it("discovers a deferred MCP tool, preserves activation on reload, and disposes every stdio process", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-builtin-mcp-"));
  const agentDir = join(directory, "agent");
  const markers = join(directory, "processes");
  const toolName = "mcp__fixture__regression_echo";
  const errors: unknown[] = [];
  let runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>> | undefined;
  const fixturePids = async () => (await readdir(markers))
    .filter((name) => name.endsWith(".started"))
    .map((name) => Number(name.split(".")[0]))
    .sort((a, b) => a - b);

  try {
    await mkdir(agentDir);
    await mkdir(markers);
    // MCP's default config/log paths use getAgentDir(), not the loader's agentDir.
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("PI_OFFLINE", "1");
    await writeFile(join(directory, "mcp-fixture.mjs"), mcpFixture);
    await writeFile(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: {
      fixture: { command: process.execPath, args: [join(directory, "mcp-fixture.mjs"), markers], exposure: "deferred" },
    } }));
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({
      defaultTools: [], cacheWarming: "off", retry: { enabled: false }, compaction: { enabled: false },
    }));
    const settingsManager = SettingsManager.create(directory, agentDir);
    const modelRuntime = await createTestModelRuntime();
    await modelRuntime.setRuntimeApiKey("anthropic", "isolated-test-key");
    const services = await createAgentSessionServices({
      cwd: directory, agentDir, settingsManager, modelRuntime,
      resourceLoaderOptions: {
        extensionFactories: await getBuiltinExtensionFactories(),
        noSkills: true, noPromptTemplates: true, noThemes: true,
        agentsFilesOverride: () => ({ agentsFiles: [] }),
      },
    });
    expect(services.resourceLoader).toBeInstanceOf(DefaultResourceLoader);
    expect(services.resourceLoader.getExtensions().errors).toEqual([]);
    runtime = await createAgentSessionRuntime(async ({ sessionManager }) => ({
      ...await createAgentSessionFromServices({ services, sessionManager, model: testModel() }),
      services, diagnostics: services.diagnostics,
    }), { cwd: directory, agentDir, sessionManager: SessionManager.inMemory(directory) });
    const session = runtime.session;
    // An error binding also lets reload emit session_start automatically.
    await session.bindExtensions({ onError: (error) => errors.push(error) });
    expect(session.getActiveToolNames()).toContain("tool_search");
    expect(session.getActiveToolNames()).not.toContain(toolName);

    const responses: AssistantMessage["content"][] = [
      [{ type: "toolCall", id: "discover", name: "tool_search", arguments: { query: "regression echo", limit: 1 } }],
      [{ type: "toolCall", id: "before-reload", name: toolName, arguments: { value: "before-reload" } }],
      [{ type: "text", text: "Discovered and called" }],
      [{ type: "toolCall", id: "after-reload", name: toolName, arguments: { value: "after-reload" } }],
      [{ type: "text", text: "Called without searching again" }],
    ];
    let requests = 0;
    session.agent.streamFunction = (_model, context) => {
      const content = responses[requests++];
      if (!content) throw new Error("Unexpected model request");
      const declared = getCurrentTools(context.messages).map((tool) => tool.name);
      expect(declared).toContain("tool_search");
      if (requests === 1) expect(declared).not.toContain(toolName);
      else expect(declared).toContain(toolName);
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

    await session.prompt("Discover and call the regression echo tool");
    expect(requests).toBe(3);
    expect(session.messages).toContainEqual(expect.objectContaining({
      role: "toolResult", toolName: "tool_search", isError: false, details: { loaded: [toolName] },
    }));
    const initialPids = await fixturePids();
    expect(initialPids).toHaveLength(1);
    const [firstPid] = initialPids;
    if (firstPid === undefined) throw new Error("Fixture did not start");
    expect(processIsAlive(firstPid)).toBe(true);
    expect(session.messages).toContainEqual(expect.objectContaining({
      role: "toolResult", toolCallId: "before-reload", toolName, isError: false,
      content: [{ type: "text", text: `fixture:before-reload:${String(firstPid)}` }],
    }));

    await session.reload();
    await expect.poll(() => session.getActiveToolNames(), { timeout: 5_000 }).toContain(toolName);
    await expect.poll(fixturePids, { timeout: 5_000 }).toHaveLength(2);
    const pids = await fixturePids();
    const secondPid = pids.find((pid) => pid !== firstPid);
    if (secondPid === undefined) throw new Error("Reload did not start a new fixture process");
    await expect.poll(() => processIsAlive(firstPid), { timeout: 5_000 }).toBe(false);
    expect(processIsAlive(secondPid)).toBe(true);
    await session.prompt("Call the already activated echo tool after reload");
    expect(requests).toBe(5);
    expect(session.messages).toContainEqual(expect.objectContaining({
      role: "toolResult", toolCallId: "after-reload", toolName, isError: false,
      content: [{ type: "text", text: `fixture:after-reload:${String(secondPid)}` }],
    }));

    // Pi 1.0's runtime owns session_shutdown; bare AgentSession.dispose only invalidates contexts.
    await runtime.dispose();
    runtime = undefined;
    await expect.poll(() => readdir(markers), { timeout: 5_000 })
      .toEqual(expect.arrayContaining(pids.map((pid) => `${String(pid)}.stopped`)));
    await expect.poll(() => pids.filter(processIsAlive), { timeout: 5_000 }).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    try {
      await runtime?.session.abort();
      await runtime?.dispose();
    } finally {
      // Assertion-failure safety net, deliberately after the disposal assertions above.
      const pids = await fixturePids().catch(() => []);
      try {
        for (const pid of pids.filter(processIsAlive)) process.kill(pid, "SIGKILL");
        await expect.poll(() => pids.filter(processIsAlive), { timeout: 5_000 }).toEqual([]);
      } finally {
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
}, 20_000);
