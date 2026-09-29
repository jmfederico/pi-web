import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { createAgentSession, createEventBus, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import companion from "../../../examples/session-bridge-plugin/src/companion.js";
import { collectReview } from "../../../examples/session-bridge-plugin/src/reviewRun.js";
import { reviewPrompt } from "../../../examples/session-bridge-plugin/src/browser/protocol.js";
import { PI_WEB_HOST_PI_SESSIONS_CAPABILITY } from "../../server-plugin-api.js";
import { createServerPluginPiSessionsCapabilityFactory } from "../plugins/serverPluginPiSessionsCapability.js";
import { PiSessionService, type PiSessionRuntime } from "./piSessionService.js";
import { PiSessionEventConnections } from "./piSessionEventConnections.js";
import { CapturingSessionEventHub, createTestModelRuntime, emptyArchiveStore, runtimeCreator, sessionGateway, testModel } from "./piSessionService.testSupport.js";

// Real native extension/reload/agent events, with only model transport and
// runtime construction isolated from user configuration and provider network.
describe("hosted package messaging with native Pi", () => {
  it("constructs a separate bus for each default hosted runtime and discovers its companion normally", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-web-default-events-"));
    const agentDir = join(directory, "agent");
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await writeFile(join(agentDir, "extensions", "companion.js"), `export default function(pi) {
      let id;
      pi.on("session_start", (_event, ctx) => { id = ctx.sessionManager.getSessionId(); });
      pi.events.on("request", data => pi.events.emit("reply", { id, data }));
    }`);
    const modelRuntime = await createTestModelRuntime();
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir, modelRuntime,
      sessionManager: { ...sessionGateway([]), create: (cwd) => SessionManager.inMemory(cwd) },
      archiveStore: emptyArchiveStore(), heartbeatIntervalMs: 60_000,
    });
    try {
      const first = await service.start(directory);
      const second = await service.start(directory);
      const lifetime = new AbortController();
      const one = service.connectSessionEvents({ id: first.id, cwd: directory }, lifetime.signal);
      const two = service.connectSessionEvents({ id: second.id, cwd: directory }, lifetime.signal);
      const received = vi.fn(), other = vi.fn();
      one.on("reply", received);
      two.on("reply", other);
      one.emit("request", "first");
      expect(received).toHaveBeenCalledWith({ id: first.id, data: "first" });
      expect(other).not.toHaveBeenCalled();
      two.emit("request", "second");
      expect(other).toHaveBeenCalledWith({ id: second.id, data: "second" });
      expect(received).toHaveBeenCalledTimes(1);
      await service.dispose();
      expect(one.signal.aborted).toBe(true);
      expect(two.signal.aborted).toBe(true);
    } finally {
      await service.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it.each(["existing", "launcher", "created"])("connects a selected %s conversation and observes extension work normally", async (kind) => {
    const directory = await mkdtemp(join(tmpdir(), "pi-web-events-"));
    const modelRuntime = await createTestModelRuntime();
    await modelRuntime.setRuntimeApiKey("anthropic", "isolated-test-key");
    const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
    const bus = createEventBus();
    let generation = 0;
    const loader = new DefaultResourceLoader({
      cwd: directory, agentDir: directory, settingsManager, eventBus: bus,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      agentsFilesOverride: () => ({ agentsFiles: [] }),
      extensionFactories: [companion, (pi) => {
        const current = ++generation;
        pi.on("session_start", () => { pi.events.emit("startup", current); });
        pi.events.on("request", (data) => { pi.events.emit("reply", { data, generation: current }); });
        pi.events.on("work", () => { pi.sendUserMessage("companion work"); });
        pi.on("agent_settled", () => { pi.events.emit("settled", current); });
      }],
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: directory, agentDir: directory, sessionManager: SessionManager.inMemory(directory),
      settingsManager, resourceLoader: loader, modelRuntime, model: testModel(), noTools: "all",
    });
    session.agent.streamFunction = () => {
      const message: AssistantMessage = {
        role: "assistant", content: [{ type: "text", text: "Companion work observed" }],
        api: "anthropic-messages", provider: "anthropic", model: testModel().id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop", timestamp: Date.now(),
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: "stop", message });
      stream.end(message);
      return stream;
    };
    const sessionEvents = new PiSessionEventConnections();
    sessionEvents.register(session, bus);
    const runtime: PiSessionRuntime = {
      cwd: directory, session, setRebindSession: () => undefined,
      fork: () => Promise.resolve({ cancelled: true }),
      dispose: () => { session.dispose(); return Promise.resolve(); },
    };
    const hub = new CapturingSessionEventHub();
    const service = new PiSessionService(hub, {
      agentDir: directory, modelRuntime, sessionEvents, createAgentRuntime: runtimeCreator(runtime),
      sessionManager: sessionGateway([]), archiveStore: emptyArchiveStore(), heartbeatIntervalMs: 60_000,
    });
    try {
      if (kind === "launcher") {
        const run = await service.startOneShotRun(directory, "initial", new AbortController().signal);
        await run.completion;
      } else if (kind === "created") {
        const project = { id: "project", name: "Project", path: directory, createdAt: new Date().toISOString() };
        const instance = createServerPluginPiSessionsCapabilityFactory({
          projects: { requireProject: () => Promise.resolve(project) },
          workspaces: { resolve: () => Promise.resolve({ status: "folder", projectId: project.id, workspaces: [
            { id: "workspace", projectId: project.id, path: directory, label: "Workspace", isMain: true },
          ], diagnostics: [] }) },
          sessions: service,
        }).create({ pluginId: "companion", packageRoot: directory, lifetimeSignal: new AbortController().signal });
        const created = await PI_WEB_HOST_PI_SESSIONS_CAPABILITY.parse(instance.value).create({ projectId: project.id, workspaceId: "workspace" });
        expect(created).toEqual({ sessionId: session.sessionId });
        expect(session.messages).toEqual([]);
        expect(hub.sessionEvents.some(({ event }) => event.type === "agent.start")).toBe(false);
        expect(hub.globalEvents.filter((event) => event.type === "session.created")).toHaveLength(1);
        await instance.dispose?.(AbortSignal.timeout(1_000));
        expect(service.activeCount()).toBe(1);
      } else await service.start(directory);
      const ref = { id: session.sessionId, cwd: directory };
      const lifetime = new AbortController();
      expect(() => service.connectSessionEvents({ ...ref, id: ref.id.slice(0, 8) }, lifetime.signal)).toThrow("not hosted");
      expect(() => service.connectSessionEvents({ ...ref, cwd: join(directory, "other") }, lifetime.signal)).toThrow("not hosted");
      const connection = service.connectSessionEvents(ref, lifetime.signal);
      const receive = vi.fn(), startup = vi.fn();
      connection.on("startup", startup);
      expect(startup).not.toHaveBeenCalled();
      connection.on("reply", receive);
      connection.emit("request", "hello");
      expect(receive).toHaveBeenLastCalledWith({ data: "hello", generation: 1 });
      await expect(service.runCommand(ref, "/reload")).resolves.toMatchObject({ type: "done" });
      expect(connection.signal.aborted).toBe(false);
      connection.emit("request", "reloaded");
      expect(receive).toHaveBeenCalledTimes(2);
      expect(receive).toHaveBeenLastCalledWith({ data: "reloaded", generation: 2 });
      expect(startup).toHaveBeenCalledWith(2);
      const settled = new Promise<void>((resolve) => { connection.on("settled", () => { resolve(); }); });
      connection.emit("work", null);
      await settled;
      expect(hub.sessionEvents.some(({ event }) => event.type === "agent.start")).toBe(true);
      expect(hub.globalEvents.some((event) => event.type === "status.update" && event.status.isStreaming)).toBe(true);
      expect(hub.sessionEvents.flatMap(({ event }) => event.type === "message.end" ? [event.message] : []))
        .toContainEqual(expect.objectContaining({ role: "user" }));
      expect(session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
      // Exercise the shipped companion after /reload, through a hosted connection.
      // Completion is captured through native hooks, not inferred from a receipt.
      const requestId = "11111111-1111-4111-8111-111111111111";
      await expect(collectReview(connection, requestId, lifetime.signal)).resolves.toBe("Companion work observed");
      connection.close();
      expect(session.messages).toContainEqual(expect.objectContaining({ role: "user", content: [
        { type: "text", text: reviewPrompt(requestId) },
      ] }));
      expect(service.activeCount()).toBe(1);
      await service.prompt(ref, "ordinary user work");
      const next = service.connectSessionEvents(ref, lifetime.signal);
      await service.stop(ref);
      expect(next.signal.aborted).toBe(true);
      expect(() => { next.emit("work", null); }).toThrow("connection closed");
      bus.emit("reply", "after close");
      expect(receive).toHaveBeenCalledTimes(2);
    } finally {
      await service.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
