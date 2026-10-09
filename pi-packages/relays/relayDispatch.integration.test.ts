import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, getCurrentTools, type AssistantMessage } from "@earendil-works/pi-ai";
import { createAgentSession, createEventBus, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createExtensionSessionDispatch } from "../../src/server/sessions/extensionSessionDispatch.js";
import type { SpawnSessionInvocation } from "../../src/server/sessions/spawnSessionTool.js";
import { createTestModelRuntime, testModel } from "../../src/server/sessions/piSessionService.testSupport.js";
import relayExtension from "./extensions/index.js";
import { RELAY_METADATA_NAMESPACE } from "./relayIdentity.js";

// Native Pi loading/tool invocation with isolated storage and fake transport.
// Packet semantics belong to relayDispatch.test; host validation to its bridge tests.
describe("Relay extension in Pi", () => {
  it.each([
    { hostAvailable: true, leg: "R1-a", validLeg: true },
    { hostAvailable: true, leg: "2", validLeg: true },
    { hostAvailable: false, leg: "R1-a", validLeg: true },
    ...[0, 1, 1.5, true, false, null].map((leg) => ({ hostAvailable: true, leg, validLeg: false })),
  ])("validates raw leg $leg before dispatch (host available=$hostAvailable)", async ({ hostAvailable, leg, validLeg }) => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-web-relay-extension-"));
    const packet = join(cwd, ".pi-web", "relays", "native");
    await mkdir(packet, { recursive: true });
    await Promise.all(["charter.md", "status.md", "log.md"].map((file) => writeFile(join(packet, file), "Saved packet")));
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    try {
      const spawn = vi.fn((input: SpawnSessionInvocation) => {
        void input;
        return Promise.resolve({ sessionId: "next-leg", cwd, model: "anthropic/child-model" });
      });
      const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
      const eventBus = createEventBus();
      const loader = new DefaultResourceLoader({
        cwd, agentDir: cwd, settingsManager, eventBus, noExtensions: true,
        noSkills: true, noPromptTemplates: true, noThemes: true,
        agentsFilesOverride: () => ({ agentsFiles: [] }),
        extensionFactories: [relayExtension, ...(hostAvailable ? [createExtensionSessionDispatch(cwd, { spawn, isEnabled: () => true })] : [])],
      });
      await loader.reload();
      expect(loader.getExtensions().errors).toEqual([]);
      const modelRuntime = await createTestModelRuntime();
      await modelRuntime.setRuntimeApiKey("anthropic", "isolated-test-key");
      ({ session } = await createAgentSession({
        cwd, agentDir: cwd, settingsManager, resourceLoader: loader,
        sessionManager: SessionManager.inMemory(cwd), modelRuntime, model: testModel(), thinkingLevel: "high", noTools: "builtin",
      }));
      const errors: unknown[] = [];
      await session.bindExtensions({ onError: (error) => errors.push(error) });
      const tool = session.getAllTools().find((item) => item.name === "dispatch_relay");
      expect(tool?.exposure).toBe("model-only");
      expect(tool?.parameters).toMatchObject({ additionalProperties: false });
      expect(tool?.parameters).toHaveProperty("properties.leg.type", "string");
      expect(tool?.parameters).not.toHaveProperty("properties.prompt");
      let turn = 0;
      session.agent.streamFunction = (_model, context) => {
        expect(getCurrentTools(context.messages).map((item) => item.name)).toContain("dispatch_relay");
        const first = ++turn === 1;
        const message: AssistantMessage = {
          role: "assistant", api: "anthropic-messages", provider: "anthropic", model: testModel().id,
          content: first ? [{ type: "toolCall", id: "dispatch-1", name: "dispatch_relay", arguments: { packet, leg, model: "anthropic/child-model", thinkingLevel: "low" } }] : [{ type: "text", text: "Handoff reported" }],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: first ? "toolUse" : "stop", timestamp: Date.now(),
        };
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "done", reason: first ? "toolUse" : "stop", message });
        stream.end(message);
        return stream;
      };
      await session.prompt("Dispatch the approved Relay");
      const result = session.messages.find((message) => message.role === "toolResult");
      expect(result).toMatchObject({ toolName: "dispatch_relay", isError: !hostAvailable || !validLeg });
      if (hostAvailable && validLeg) {
        expect(spawn).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
          spawningCwd: cwd, spawningSessionId: session.sessionId, cwd,
          name: `Leg ${String(leg)} – Relay native`, model: testModel(), modelSpec: "anthropic/child-model", thinkingLevel: "low",
          metadata: { [RELAY_METADATA_NAMESPACE]: { version: 1, packetPath: ".pi-web/relays/native", relayName: "native", leg } },
        }));
        expect(spawn.mock.calls[0]?.[0].prompt).toContain(JSON.stringify(join(packet, "status.md")));
        expect(result).toMatchObject({ details: { sessionId: "next-leg", cwd, model: "anthropic/child-model" } });
      } else {
        expect(spawn).not.toHaveBeenCalled();
        const text = result?.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
        expect(text).toContain(validLeg ? "no session was dispatched" : "Relay leg must be a string");
      }
      expect(session.thinkingLevel).toBe("high");
      expect(errors).toEqual([]);
    } finally {
      await session?.abort();
      session?.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  }, 30_000);
});
