import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "pi-web-typebox";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionRunner, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { PiSessionService } from "./piSessionService.js";
import { CapturingSessionEventHub, emptyArchiveStore, fakeRuntime, runtimeCreator, sessionGateway, sessionRef, testModelRuntime } from "./piSessionService.testSupport.js";

function setup() {
  const fake = fakeRuntime("session-1");
  const service = new PiSessionService(new CapturingSessionEventHub(), { agentDir: join(tmpdir(), "pi-web-activity-test"), modelRuntime: testModelRuntime,
    sessionManager: sessionGateway([]), archiveStore: emptyArchiveStore(), createAgentRuntime: runtimeCreator(fake.runtime), heartbeatIntervalMs: 60_000 });
  return { fake, service };
}

describe("selected runtime observability", () => {
  it("exposes live todos absent from chat, system RAM and native children without requiring a fleet exporter", async () => {
    const { fake, service } = setup();
    fake.session.extensionRunner.getAllRegisteredTools = () => [{
      sourceInfo: { path: "/packages/@juicesharp/rpiv-todo/index.ts", source: "npm:@juicesharp/rpiv-todo", scope: "user", origin: "top-level" },
      definition: { name: "todo", label: "Todo", description: "Tasks", parameters: Type.Object({}),
        execute: () => Promise.resolve({ content: [], details: { tasks: [{ id: 1, subject: "Live task", status: "in_progress" }] } }) },
    }];
    fake.session.extensionRunner.createToolContext = vi.fn<ExtensionRunner["createToolContext"]>();
    try {
      await service.start("/workspace");
      const value = await service.observability(sessionRef("session-1"));
      expect(value.sessionId).toBe("session-1"); expect(value.cwd).toBe("/workspace");
      expect(value.todos).toEqual({ state: "ready", value: [{ id: "1", title: "Live task", status: "in_progress", depth: 0 }] });
      expect(value.goal.state).toBe("unavailable"); expect(value.fleet.state).toBe("unavailable");
      expect(value.children).toEqual({ state: "ready", value: [] });
      expect(value.memory.state).toBe("ready");
      expect(fake.session.messages).toEqual([]);
    } finally { await service.dispose(); }
  });

  it("rejects a slow sample after an in-place extension runtime replacement", async () => {
    const { fake, service } = setup();
    let finish: ((result: Awaited<ReturnType<ToolDefinition["execute"]>>) => void) | undefined;
    const execute = vi.fn<ToolDefinition["execute"]>(() => new Promise((resolve) => { finish = resolve; }));
    fake.session.extensionRunner.getAllRegisteredTools = () => [{
      sourceInfo: { path: "/packages/@juicesharp/rpiv-todo/index.ts", source: "npm:@juicesharp/rpiv-todo", scope: "user", origin: "top-level" },
      definition: { name: "todo", label: "Todo", description: "Tasks", parameters: Type.Object({}), execute },
    }];
    fake.session.extensionRunner.createToolContext = vi.fn<ExtensionRunner["createToolContext"]>();
    try {
      await service.start("/workspace");
      const pending = service.observability(sessionRef("session-1"));
      await vi.waitFor(() => { expect(execute).toHaveBeenCalledOnce(); });
      fake.session.extensionRunner = { ...fake.session.extensionRunner };
      finish?.({ content: [], details: { tasks: [] } });
      await expect(pending).rejects.toThrow("runtime changed");
    } finally { await service.dispose(); }
  });
});
