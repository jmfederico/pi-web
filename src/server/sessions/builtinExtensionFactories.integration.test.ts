import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, getCurrentTools, type AssistantMessage } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, createEventBus } from "../../piSdk.js";
import { describe, expect, it, vi } from "vitest";
import { getBuiltinExtensionFactories } from "./builtinExtensionFactories.js";
import { createAskUserToolDefinition } from "./askUserTool.js";
import { createSubsessionToolDefinitions } from "./spawnSubsessionTool.js";
import { createTestModelRuntime, testModel } from "./piSessionService.testSupport.js";

// Real SDK discovery, settings, and codemode execution with isolated configuration
// and a fake model transport. No live daemon, user MCP servers, or paid API.
describe("builtin extension factories load through DefaultResourceLoader", () => {
  let directory: string;

  it("loads mcp, codemode, and tool-search builtins when factories are provided", async () => {
    directory = await mkdtemp(join(tmpdir(), "pi-web-builtin-integration-"));
    try {
      // Create an empty mcp.json so MCP servers don't try to connect to the network.
      await writeFile(join(directory, "mcp.json"), JSON.stringify({ mcpServers: {} }), "utf-8");

      const factories = await getBuiltinExtensionFactories();
      expect(factories).toHaveLength(3);

      const eventBus = createEventBus();
      const loader = new DefaultResourceLoader({
        cwd: directory,
        agentDir: directory,
        eventBus,
        extensionFactories: factories,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
      });

      await loader.reload();

      // The loader should have resolved builtin extension paths.
      const extensionsResult = loader.getExtensions();
      const builtinPaths = extensionsResult.extensions
        .map((ext) => ext.path)
        .filter((p) => p.startsWith("builtin:"));

      expect(extensionsResult.errors).toEqual([]);
      expect(builtinPaths).toContain("builtin:mcp");
      expect(builtinPaths).toContain("builtin:codemode");
      expect(builtinPaths).toContain("builtin:tool-search");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["noExtensions", "settings"])("respects builtin disablement through %s", async (disablement) => {
    directory = await mkdtemp(join(tmpdir(), "pi-web-builtin-empty-"));
    try {
      const loader = new DefaultResourceLoader({
        cwd: directory,
        agentDir: directory,
        extensionFactories: await getBuiltinExtensionFactories(),
        noExtensions: disablement === "noExtensions",
        settingsManager: SettingsManager.inMemory(disablement === "settings" ? {
          extensions: ["-builtin:mcp", "-builtin:codemode", "-builtin:tool-search"],
        } : {}),
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
      });

      await loader.reload();
      expect(loader.getExtensions().errors).toEqual([]);
      const extensionsResult = loader.getExtensions();
      const builtinPaths = extensionsResult.extensions
        .map((ext) => ext.path)
        .filter((p) => p.startsWith("builtin:"));
      expect(builtinPaths).toHaveLength(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("executes codemode-only nested reads without exposing run-ending tools to scripts", async () => {
    directory = await mkdtemp(join(tmpdir(), "pi-web-codemode-integration-"));
    const errors: unknown[] = [];
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    try {
      await writeFile(join(directory, "mcp.json"), JSON.stringify({ mcpServers: {} }));
      await writeFile(join(directory, "marker.txt"), "pi-1-codemode-marker");
      const settingsManager = SettingsManager.inMemory({
        defaultTools: ["+codemode", "+tool_search"], codemode: { mode: "only" },
        retry: { enabled: false }, compaction: { enabled: false },
      });
      const loader = new DefaultResourceLoader({
        cwd: directory, agentDir: directory, settingsManager,
        extensionFactories: await getBuiltinExtensionFactories(),
        noSkills: true, noPromptTemplates: true, noThemes: true,
        agentsFilesOverride: () => ({ agentsFiles: [] }),
      });
      await loader.reload();
      expect(loader.getExtensions().errors).toEqual([]);
      const modelRuntime = await createTestModelRuntime();
      await modelRuntime.setRuntimeApiKey("anthropic", "isolated-test-key");
      const unexpectedRunEndingCall = vi.fn(() => { throw new Error("Run-ending tools must not be called from codemode"); });
      ({ session } = await createAgentSession({
        cwd: directory, agentDir: directory, settingsManager, resourceLoader: loader,
        sessionManager: SessionManager.inMemory(directory), modelRuntime, model: testModel(),
        customTools: [createAskUserToolDefinition({ createAskId: unexpectedRunEndingCall }),
          ...createSubsessionToolDefinitions(directory, {
            spawn: unexpectedRunEndingCall, list: unexpectedRunEndingCall, join: unexpectedRunEndingCall,
            check: unexpectedRunEndingCall, read: unexpectedRunEndingCall,
            stop: unexpectedRunEndingCall, resume: unexpectedRunEndingCall, archive: unexpectedRunEndingCall,
          })],
      }));
      await session.bindExtensions({ onError: (error) => errors.push(error) });
      expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["read", "codemode", "tool_search"]));
      let requests = 0;
      session.agent.streamFunction = (_model, context) => {
        const declaredNames = getCurrentTools(context.messages).map((tool) => tool.name);
        expect(declaredNames).toEqual(expect.arrayContaining(["codemode", "ask_user", "yield_to_subsessions"]));
        expect(declaredNames).not.toContain("read");
        requests++;
        const message: AssistantMessage = {
          role: "assistant", api: "anthropic-messages", provider: "anthropic", model: testModel().id,
          content: requests === 1
            ? [{ type: "toolCall", id: "codemode-test", name: "codemode", arguments: { code: 'text({askCallable: "ask_user" in tools, yieldCallable: "yield_to_subsessions" in tools}); text(await tools.read({path: "marker.txt"}));' } }]
            : [{ type: "text", text: "Read completed" }],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: requests === 1 ? "toolUse" : "stop", timestamp: Date.now(),
        };
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "done", reason: requests === 1 ? "toolUse" : "stop", message });
        stream.end(message);
        return stream;
      };
      await session.prompt("Read marker.txt using codemode");
      const result = session.messages.find((message) => message.role === "toolResult");
      expect(result).toMatchObject({ role: "toolResult", toolName: "codemode", isError: false,
        nestedCalls: { calls: [expect.objectContaining({ name: "read", status: "ok" })] } });
      const resultText = result?.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
      expect(resultText).toContain("pi-1-codemode-marker");
      expect(resultText).toContain('"askCallable":false');
      expect(resultText).toContain('"yieldCallable":false');
      expect(unexpectedRunEndingCall).not.toHaveBeenCalled();
      expect(session.getLastAssistantText()).toBe("Read completed");
      expect(requests).toBe(2);
      expect(errors).toEqual([]);
    } finally {
      await session?.abort();
      session?.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
