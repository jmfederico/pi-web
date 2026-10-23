import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, Type, type AssistantMessage } from "@earendil-works/pi-ai";
import { createAgentSession, createEventBus, DefaultResourceLoader, defineTool, SessionManager, SettingsManager } from "../../piSdk.js";
import { expect, it, vi } from "vitest";
import type { PluginBackend, PluginPeer } from "../../plugin-api.js";
import { createCompanionBackend, type ServerPluginPeerRequestContextV5 } from "../../server-plugin-api.js";
import { PluginBackendRegistry } from "../plugins/pluginBackendRegistry.js";
import type { ServerPluginPairedBackendContribution } from "../plugins/serverPluginRuntime.js";
import { bindCompanionBackend } from "./companionBackend.js";
import { PiSessionEventConnections } from "./piSessionEventConnections.js";
import { createTestModelRuntime, testModel } from "./piSessionService.testSupport.js";

// Native extension loading, tool admission, reload, and host lifetime are real;
// only the model response is replaced so this contract needs no network access.
it("loads a companion tool that calls its v5 peer across native reload and invalidates retained facades on close", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-companion-backend-"));
  const request = vi.fn(({ scope, operation, input }: ServerPluginPeerRequestContextV5) => ({ scope: scope.kind, operation, input }));
  const contributions: readonly ServerPluginPairedBackendContribution[] = [{
    apiVersion: 5, pluginId: "example.transport", pluginName: "Transport fixture",
    packageRoot: directory, source: "fixture", scope: "local", moduleRevision: "transport-r1",
    backend: { request },
  }];
  const resolveWorkspace = vi.fn(() => { throw new Error("Machine scope must not resolve a workspace"); });
  const requireProject = vi.fn(() => { throw new Error("Machine scope must not resolve a project"); });
  const registry = new PluginBackendRegistry({ contributions, workspaces: { resolve: resolveWorkspace } });
  const events = new PiSessionEventConnections((bus) => bindCompanionBackend(bus, {
    backends: registry, contributions, projects: { requireProject },
  }));
  const bus = createEventBus();
  const retained: { backend: PluginBackend; peer: PluginPeer }[] = [];
  let loads = 0;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    const settingsManager = SettingsManager.inMemory({
      defaultTools: [], cacheWarming: "off", retry: { enabled: false }, compaction: { enabled: false },
    });
    const loader = new DefaultResourceLoader({
      cwd: directory, agentDir: directory, settingsManager, eventBus: bus,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      agentsFilesOverride: () => ({ agentsFiles: [] }),
      extensionFactories: [(pi) => {
        loads++;
        pi.registerTool(defineTool({
          name: "backend_probe", label: "Backend probe", description: "Request the package backend",
          parameters: Type.Object({ value: Type.String() }),
          execute: async (_id, { value }, signal) => {
            const backend = createCompanionBackend(pi.events, "example.transport");
            const peer = backend.forScope({ kind: "machine" });
            retained.push({ backend, peer });
            if (peer.request === undefined) throw new Error("Expected a request-capable v5 peer");
            const result = await peer.request("echo", value, signal === undefined ? {} : { signal });
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
    const responses: AssistantMessage["content"][] = [
      [{ type: "toolCall", id: "before-reload", name: "backend_probe", arguments: { value: "before" } }],
      [{ type: "text", text: "Backend requested before reload" }],
      [{ type: "toolCall", id: "after-reload", name: "backend_probe", arguments: { value: "after" } }],
      [{ type: "text", text: "Backend requested after reload" }],
    ];
    let requests = 0;
    session.agent.streamFunction = () => {
      const content = responses[requests++];
      if (content === undefined) throw new Error("Unexpected model request");
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

    await session.prompt("Request the backend before reload");
    expect(session.messages).toContainEqual(expect.objectContaining({
      role: "toolResult", toolCallId: "before-reload", toolName: "backend_probe", isError: false,
      details: { scope: "machine", operation: "echo", input: "before" },
    }));
    expect(request).toHaveBeenCalledTimes(1);
    const initialLoads = loads;
    // This is the native SDK resource reload used by the host's /reload command,
    // not a replacement command registered by the companion extension.
    await session.reload();
    expect(loads).toBe(initialLoads + 1);
    expect(loader.getExtensions().errors).toEqual([]);
    expect(session.getActiveToolNames()).toContain("backend_probe");
    await session.prompt("Request the backend after reload");
    expect(session.messages).toContainEqual(expect.objectContaining({
      role: "toolResult", toolCallId: "after-reload", toolName: "backend_probe", isError: false,
      details: { scope: "machine", operation: "echo", input: "after" },
    }));
    expect(session.getLastAssistantText()).toBe("Backend requested after reload");
    expect(requests).toBe(4);
    expect(request).toHaveBeenCalledTimes(2);
    expect(retained).toHaveLength(2);
    expect(errors).toEqual([]);

    events.close(session);
    await session.abort();
    session.dispose();
    session = undefined;
    for (const { backend, peer } of retained) {
      expect(() => backend.forScope({ kind: "machine" })).toThrow();
      if (peer.request === undefined) throw new Error("Expected retained request-capable peer");
      await expect(peer.request("echo", "closed")).rejects.toThrow();
    }
    expect(request).toHaveBeenCalledTimes(2);
    expect(resolveWorkspace).not.toHaveBeenCalled();
    expect(requireProject).not.toHaveBeenCalled();
  } finally {
    if (session !== undefined) { events.close(session); await session.abort(); session.dispose(); }
    await registry.closeAll();
    await rm(directory, { recursive: true, force: true });
  }
});
