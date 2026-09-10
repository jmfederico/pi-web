import { describe, expect, it } from "vitest";
import type { SessionUiEvent } from "../../../shared/apiTypes.js";
import { applyTranscriptEvent } from "../../../client/src/chatTranscript.js";
import { OmpSessionService } from "./ompSessionService.js";
import {
  CapturingSessionEventHub,
  fakeRpcClientFactory,
  FakeOmpSessionStore,
  NEW_SESSION_ACCEPTED,
  sessionStatsPayload,
  TEST_AGENT_DIR,
  TEST_NATIVE_ID_A,
} from "./ompSessionService.testSupport.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

async function startedCommandSession(promptResponse: Promise<{ agentInvoked?: boolean }>) {
  const factory = fakeRpcClientFactory((client) => {
    client.onSuccess("new_session", NEW_SESSION_ACCEPTED);
    client.onSuccess("get_session_stats", sessionStatsPayload(TEST_NATIVE_ID_A));
    client.on("prompt", () => promptResponse);
  });
  const hub = new CapturingSessionEventHub();
  const service = new OmpSessionService(hub, {
    agentDir: TEST_AGENT_DIR,
    createRpcClient: factory,
    store: new FakeOmpSessionStore(),
  });
  const session = await service.start("/workspace");
  const client = factory.clients[0];
  if (client === undefined) throw new Error("expected start to create an OMP client");
  return { service, hub, client, ref: { id: session.id, cwd: session.cwd } };
}

describe("OmpSessionService: native slash-command event contract", () => {
  it("renders native command output and consumes a local-only completion without inventing agent lifecycle", async () => {
    const response = deferred<{ agentInvoked?: boolean }>();
    const { service, hub, client, ref } = await startedCommandSession(response.promise);
    client.emit({ type: "agent_start" });
    client.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "real turn remains active" },
      message: { role: "assistant", content: [] },
    });
    const running = service.runCommand(ref, "/help");
    await Promise.resolve();

    client.emit({ type: "command_output", text: "Available commands:\n/help" });
    client.emit({ type: "prompt_result", id: "r3", agentInvoked: false });
    response.resolve({ agentInvoked: false });

    await expect(running).resolves.toEqual({ type: "done" });
    const output = hub.eventsFor(ref.id).find(
      (event): event is Extract<SessionUiEvent, { type: "command.output" }> => event.type === "command.output",
    );
    if (output === undefined) throw new Error("expected a command.output event");
    expect(output).toMatchObject({ type: "command.output", level: "info", message: "Available commands:\n/help" });
    expect(applyTranscriptEvent([], output)).toMatchObject([
      { role: "tool", parts: [{ type: "text", text: "Available commands:\n/help" }] },
    ]);
    expect(hub.eventsFor(ref.id).filter((event) => event.type === "agent.end")).toEqual([]);
    await expect(service.streamSnapshot(ref)).resolves.toMatchObject({
      partial: { role: "assistant", content: [{ type: "text", text: "real turn remains active" }] },
    });
  });
});
