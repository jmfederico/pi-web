import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, getCurrentTools, type AssistantMessage } from "@earendil-works/pi-ai";
import { expect, it, vi } from "vitest";
import {
  createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices,
  createMcpExtension, SessionManager, SettingsManager,
} from "../../piSdk.js";
import { createTestModelRuntime, testModel } from "../sessions/piSessionService.testSupport.js";
import { createManagedMcpController, createManagedMcpExtension, type ManagedMcpSnapshot } from "./managedMcpRuntime.js";

// A real stdio transport protects startup ordering and dynamic removal; only the
// provider transport is fake. No private Pi manager or connection-state API is used.
const mcpFixture = String.raw`
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
lines.on("close", () => process.exit(0));
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result;
  switch (request.method) {
    case "initialize":
      result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "managed-fixture", version: "1" } };
      break;
    case "tools/list":
      result = { tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object", properties: {} } }] };
      break;
    case "tools/call":
      result = { content: [{ type: "text", text: "managed-echo" }] };
      break;
    default:
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Unknown method" } }) + "\n");
      return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
});
`;

it("waits for startup direct tools, defers removal through tool execution, and preserves native overrides on reload", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-managed-mcp-"));
  const agentDir = join(directory, "agent");
  const errors: unknown[] = [];
  let runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>> | undefined;
  try {
    await mkdir(agentDir);
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("PI_OFFLINE", "1");
    const fixturePath = join(directory, "mcp-fixture.mjs");
    await writeFile(fixturePath, mcpFixture);
    const config = { command: process.execPath, args: [fixturePath], exposure: "direct" as const };
    await writeFile(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { native: config } }));
    let desired: ManagedMcpSnapshot = {
      definitions: { "team-docs": config, native: config }, enabled: { native: false },
    };
    const controller = createManagedMcpController({ resolve: () => desired, onError: (error) => errors.push(error) });
    const settingsManager = SettingsManager.inMemory({ defaultTools: [], cacheWarming: "off", retry: { enabled: false }, compaction: { enabled: false } });
    const modelRuntime = await createTestModelRuntime();
    await modelRuntime.setRuntimeApiKey("anthropic", "isolated-test-key");
    const services = await createAgentSessionServices({
      cwd: directory, agentDir, settingsManager, modelRuntime,
      resourceLoaderOptions: {
        extensionFactories: [createManagedMcpExtension(controller), createMcpExtension()],
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
        agentsFilesOverride: () => ({ agentsFiles: [] }),
      },
    });
    expect(services.resourceLoader.getExtensions().errors).toEqual([]);
    runtime = await createAgentSessionRuntime(async ({ sessionManager }) => ({
      ...await createAgentSessionFromServices({ services, sessionManager, model: testModel() }),
      services, diagnostics: services.diagnostics,
    }), { cwd: directory, agentDir, sessionManager: SessionManager.inMemory(directory) });
    const session = runtime.session;
    await session.bindExtensions({ onError: (error) => errors.push(error) });
    const toolName = "mcp__team_docs__echo";
    let requests = 0;
    const declarations: string[][] = [];
    session.agent.streamFunction = (_model, context) => {
      requests += 1;
      declarations.push(getCurrentTools(context.messages).map((tool) => tool.name));
      if (requests === 1) {
        desired = { definitions: { native: config }, enabled: { native: false } };
        controller.apply(desired);
      }
      const calling = requests === 1 || requests === 3;
      const message: AssistantMessage = {
        role: "assistant", api: "anthropic-messages", provider: "anthropic", model: testModel().id,
        content: calling ? [{ type: "toolCall", id: `call-${String(requests)}`, name: toolName, arguments: {} }] : [{ type: "text", text: "Done" }],
        stopReason: calling ? "toolUse" : "stop", timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: calling ? "toolUse" : "stop", message });
      stream.end(message);
      return stream;
    };
    // No connection polling before the first prompt: the managed registration must
    // participate in Pi's startup wait, or its tool is absent from this request.
    await session.prompt("Call the managed tool");
    expect(declarations[0]).toEqual(expect.arrayContaining([toolName, "mcp__native__echo"]));
    expect(session.messages).toContainEqual(expect.objectContaining({
      role: "toolResult", toolCallId: "call-1", isError: false, content: [{ type: "text", text: "managed-echo" }],
    }));
    await expect.poll(() => session.getActiveToolNames()).not.toContain(toolName);
    expect(controller.getState()).toMatchObject({ pending: false, servers: [{ name: "native", enabled: false, registered: true, registeredEnabled: false }] });
    // The managed disabled intent does not pretend to disable Pi's native override.
    expect(session.getActiveToolNames()).toContain("mcp__native__echo");

    await session.prompt("Try the withdrawn tool");
    expect(declarations[2]).not.toContain(toolName);
    expect(session.messages).toContainEqual(expect.objectContaining({ role: "toolResult", toolCallId: "call-3", isError: true }));
    await session.reload();
    expect(controller.getState()).toMatchObject({ bound: true, pending: false });
    await expect.poll(() => session.getActiveToolNames(), { timeout: 5_000 }).toContain("mcp__native__echo");
    expect(session.getActiveToolNames()).not.toContain(toolName);
    expect(errors).toEqual([]);
    await runtime.dispose();
    runtime = undefined;
    expect(controller.getState().bound).toBe(false);
  } finally {
    try {
      await runtime?.session.abort();
      await runtime?.dispose();
    } finally {
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  }
}, 20_000);
