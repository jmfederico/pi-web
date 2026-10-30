import { describe, expect, it } from "vitest";
import { SessionManager } from "../../piSdk.js";
import { WorkspaceActivityService } from "../activity/workspaceActivityService.js";
import { PiSessionService } from "./piSessionService.js";
import { createRequestHumanInterventionToolDefinition } from "./requestHumanInterventionTool.js";
import { SESSION_INTERVENTION_CUSTOM_TYPE, sessionInterventionRequired } from "./sessionIntervention.js";
import { CapturingSessionEventHub, emptyArchiveStore, fakeRuntime, runtimeCreator, sessionGateway, sessionRecord, sessionRef, stubExtensionToolContext, testModelRuntime } from "./piSessionService.testSupport.js";

const id = "intervention-session";

function interventionService(required = false) {
  const manager = SessionManager.inMemory("/workspace", { id });
  manager.appendMessage({ role: "user", content: "Work on this", timestamp: Date.now() });
  if (required) manager.appendCustomEntry(SESSION_INTERVENTION_CUSTOM_TYPE, { version: 1, required });
  const fake = fakeRuntime(id, { sessionManager: manager });
  const events = new CapturingSessionEventHub();
  const workspaceActivity = new WorkspaceActivityService();
  const record = { ...sessionRecord(id), interventionRequired: required };
  const service = new PiSessionService(events, {
    agentDir: "/tmp/pi-web-intervention-test", modelRuntime: testModelRuntime,
    sessionManager: sessionGateway([record]), archiveStore: emptyArchiveStore(),
    createAgentRuntime: runtimeCreator(fake.runtime), workspaceActivity, heartbeatIntervalMs: 60_000,
  });
  return { manager, fake, events, service, workspaceActivity };
}

describe("generic human intervention", () => {
  it("terminates a prose-question run and emits a generic signal without a form", async () => {
    const tool = createRequestHumanInterventionToolDefinition();
    const result = await tool.execute("call", { reason: "Approve the migration described above" }, undefined, undefined, stubExtensionToolContext());
    expect(result.terminate).toBe(true);
    expect(result.details).toEqual({ interventionRequired: true });
    await expect(tool.execute("call", { reason: "  " }, undefined, undefined, stubExtensionToolContext())).rejects.toThrow("must not be empty");
  });

  it("persists explicit tool intent, ignores passive events, and clears on any new run before it settles", async () => {
    const { manager, fake, service, events } = interventionService();
    try {
      await service.status(sessionRef(id));
      fake.emit({ type: "message_end", message: { role: "toolResult", toolName: "an_extension_tool", isError: false, details: { interventionRequired: true } } });
      expect((await service.status(sessionRef(id))).interventionRequired).toBe(true);
      expect(sessionInterventionRequired(manager.getEntries())).toBe(true);

      fake.emit({ type: "agent_settled" });
      fake.emit({ type: "session_tree" });
      fake.emit({ type: "entry_appended", entry: { type: "custom_message", customType: "background.notice", content: "FYI" } });
      expect((await service.status(sessionRef(id))).interventionRequired).toBe(true);

      // Queueing input alone is not execution; only agent_start clears it,
      // regardless of whether a human, another agent, or a system woke the run.
      fake.session.pendingMessageCount = 1;
      expect((await service.status(sessionRef(id))).interventionRequired).toBe(true);
      fake.session.isStreaming = true;
      fake.emit({ type: "agent_start" });
      expect((await service.status(sessionRef(id))).interventionRequired).toBe(false);
      expect(sessionInterventionRequired(manager.getEntries())).toBe(false);
      expect(events.globalEvents.at(-1)).toMatchObject({ type: "status.update", status: { interventionRequired: false } });

      fake.emit({ type: "message_end", message: { role: "toolResult", toolName: "request_human_intervention", isError: false, details: { interventionRequired: true } } });
      expect((await service.status(sessionRef(id))).interventionRequired).toBe(true);
    } finally { await service.dispose(); }
  });

  it("recovers cold flags for rollup without opening runtimes, then clears the hosted state on resume", async () => {
    const { service, fake, workspaceActivity } = interventionService(true);
    try {
      await service.restoreInterventionState();
      expect(service.activeCount()).toBe(0);
      expect(workspaceActivity.snapshot().interventionSessions).toEqual([{ sessionId: id, cwd: "/workspace" }]);
      expect((await service.list("/workspace"))[0]?.interventionRequired).toBe(true);
      expect((await service.status(sessionRef(id))).interventionRequired).toBe(true);
      fake.emit({ type: "agent_start" });
      expect((await service.status(sessionRef(id))).interventionRequired).toBe(false);
      expect(workspaceActivity.snapshot().interventionSessions).toEqual([]);
    } finally { await service.dispose(); }
  });
});
