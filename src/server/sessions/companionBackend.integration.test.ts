import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, Type, type AssistantMessage } from "@earendil-works/pi-ai";
import { createAgentSession, createEventBus, DefaultResourceLoader, defineTool, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { createCompanionBackend } from "../../server-plugin-api.js";
import { PluginBackendRegistry } from "../plugins/pluginBackendRegistry.js";
import { PiSessionEventConnections } from "./piSessionEventConnections.js";
import { createTestModelRuntime, testModel } from "./piSessionService.testSupport.js";

// Native tool admission/execution is the invariant, with only the model's
// network response replaced. The two-instance test owns HTTP and assembly.
it("executes a companion agent tool against its current-machine backend through native Pi", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-companion-backend-"));
  const registry = new PluginBackendRegistry({
    contributions: [], machineContributions: [{ pluginId: "example.transport", backend: {
      request: ({ operation, input }) => ({ operation, input }),
    } }], workspaces: { resolve: () => { throw new Error("Workspace scope is not needed"); } },
  });
  const events = new PiSessionEventConnections(registry), bus = createEventBus();
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
    const loader = new DefaultResourceLoader({
      cwd: directory, agentDir: directory, settingsManager, eventBus: bus,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      agentsFilesOverride: () => ({ agentsFiles: [] }),
      extensionFactories: [(pi) => {
        pi.registerTool(defineTool({
          name: "backend_probe", label: "Backend probe", description: "Request the package backend", parameters: Type.Object({}),
          execute: async (_id, _params, signal) => {
            const result = await createCompanionBackend(pi.events, "example.transport").request("echo", "agent tool", signal === undefined ? {} : { signal });
            return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
          },
        }));
      }],
    });
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    const modelRuntime = await createTestModelRuntime();
    await modelRuntime.setRuntimeApiKey("anthropic", "isolated-test-key");
    ({ session } = await createAgentSession({
      cwd: directory, agentDir: directory, settingsManager, resourceLoader: loader, modelRuntime,
      sessionManager: SessionManager.inMemory(directory), model: testModel(),
    }));
    events.register(session, bus);
    const errors: unknown[] = [];
    await session.bindExtensions({ onError: (error) => errors.push(error) });
    let requests = 0;
    session.agent.streamFunction = () => {
      requests++;
      const message: AssistantMessage = {
        role: "assistant", api: "anthropic-messages", provider: "anthropic", model: testModel().id,
        content: requests === 1
          ? [{ type: "toolCall", id: "probe", name: "backend_probe", arguments: {} }]
          : [{ type: "text", text: "Backend requested" }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: requests === 1 ? "toolUse" : "stop", timestamp: Date.now(),
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: requests === 1 ? "toolUse" : "stop", message });
      stream.end(message);
      return stream;
    };
    await session.prompt("Request the backend");
    expect(session.messages.find((message) => message.role === "toolResult")).toMatchObject({
      toolName: "backend_probe", isError: false, content: [{ type: "text", text: '{"operation":"echo","input":"agent tool"}' }],
    });
    expect(session.getLastAssistantText()).toBe("Backend requested");
    expect(requests).toBe(2);
    expect(errors).toEqual([]);
  } finally {
    if (session !== undefined) { events.close(session); await session.abort(); session.dispose(); }
    await registry.closeAll();
    await rm(directory, { recursive: true, force: true });
  }
});
