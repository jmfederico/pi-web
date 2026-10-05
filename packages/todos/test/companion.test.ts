import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { createAgentSession, createEventBus, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { PluginBackendRegistry } from "../../../src/server/plugins/pluginBackendRegistry.js";
import { PiSessionEventConnections } from "../../../src/server/sessions/piSessionEventConnections.js";
import { createTestModelRuntime, testModel } from "../../../src/server/sessions/piSessionService.testSupport.js";
import companion from "../src/companion.js";
import { TodoStore } from "../src/store.js";
import { resultTask } from "../src/browser/protocol.js";

// Replace only model networking. Native schema admission, tool execution and
// failed-tool results are the invariant; the two-host test owns HTTP assembly.
it("executes shipped list/read/mutate tools through native Pi and reports a stale edit as a failed tool", async () => {
  const directory = await mkdtemp(join(tmpdir(), "todos-companion-"));
  const store = new TodoStore(join(directory, "todos.sqlite"));
  const task = resultTask(store.mutate({ title: "Personal tools", context: "One shared list" }));
  const registry = new PluginBackendRegistry({ contributions: [], machineContributions: [{ pluginId: "todos", backend: {
    request: ({ operation, input }) => {
      if (operation === "list") return store.list(input);
      if (operation === "read") return store.read(input);
      if (operation === "mutate") return store.mutate(input);
      throw new Error("Unknown operation");
    },
  } }], workspaces: { resolve: () => { throw new Error("No workspace required"); } } });
  const connections = new PiSessionEventConnections(registry), bus = createEventBus();
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager, eventBus: bus,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, agentsFilesOverride: () => ({ agentsFiles: [] }), extensionFactories: [companion] });
    await loader.reload(); expect(loader.getExtensions().errors).toEqual([]);
    const modelRuntime = await createTestModelRuntime(); await modelRuntime.setRuntimeApiKey("anthropic", "isolated-test-key");
    ({ session } = await createAgentSession({ cwd: directory, agentDir: directory, settingsManager, resourceLoader: loader, modelRuntime,
      sessionManager: SessionManager.inMemory(directory), model: testModel() }));
    connections.register(session, bus);
    const errors: unknown[] = []; await session.bindExtensions({ onError: (error) => errors.push(error) });
    const calls = [
      { name: "todos_list", arguments: { text: "personal", project: null } },
      { name: "todos_read", arguments: { id: task.id } },
      { name: "todos_mutate", arguments: { id: task.id, revision: 1, status: "On hold" } },
      { name: "todos_mutate", arguments: { id: task.id, revision: 1, context: "stale" } },
    ];
    let turn = 0;
    session.agent.streamFunction = () => {
      const call = calls[turn++];
      const message: AssistantMessage = { role: "assistant", api: "anthropic-messages", provider: "anthropic", model: testModel().id,
        content: call === undefined ? [{ type: "text", text: "Finished" }] : [{ type: "toolCall", id: `call-${String(turn)}`, ...call }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: call === undefined ? "stop" : "toolUse", timestamp: Date.now() };
      const stream = createAssistantMessageEventStream(); stream.push({ type: "done", reason: call === undefined ? "stop" : "toolUse", message }); stream.end(message); return stream;
    };
    await session.prompt("Manage the shared tasks");
    const results = session.messages.filter((message) => message.role === "toolResult");
    expect(results).toHaveLength(4);
    expect(results.slice(0, 3).map((message) => ({ name: message.toolName, error: message.isError }))).toEqual([
      { name: "todos_list", error: false }, { name: "todos_read", error: false }, { name: "todos_mutate", error: false },
    ]);
    expect(results[3]).toMatchObject({ toolName: "todos_mutate", isError: true });
    expect(JSON.stringify(results[3])).toContain("Task changed");
    expect(resultTask(store.read({ id: task.id }))).toMatchObject({ revision: 2, status: "On hold", context: task.context });
    expect(errors).toEqual([]);
  } finally {
    if (session !== undefined) { connections.close(session); await session.abort(); session.dispose(); }
    await registry.closeAll(); store.close(); await rm(directory, { recursive: true, force: true });
  }
});
