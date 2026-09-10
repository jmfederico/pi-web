import { describe, expect, it, vi } from "vitest";
import { EXTENSION_DIALOG_INPUT_MAX_LENGTH } from "../../../shared/apiTypes.js";
import { PendingExtensionDialogStore } from "../pendingExtensionDialogStore.js";
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

async function startedDialogSession() {
  const factory = fakeRpcClientFactory((client) => {
    client.onSuccess("new_session", NEW_SESSION_ACCEPTED);
    client.onSuccess("get_session_stats", sessionStatsPayload(TEST_NATIVE_ID_A));
  });
  const hub = new CapturingSessionEventHub();
  const dialogs = new PendingExtensionDialogStore({ createDialogId: () => "dialog-1" });
  const service = new OmpSessionService(hub, {
    agentDir: TEST_AGENT_DIR,
    createRpcClient: factory,
    store: new FakeOmpSessionStore(),
    pendingExtensionDialogStore: dialogs,
  });
  const session = await service.start("/workspace");
  const client = factory.clients[0];
  if (client === undefined) throw new Error("expected start to create an OMP client");
  return { service, hub, dialogs, client, ref: { id: session.id, cwd: session.cwd } };
}

describe("OmpSessionService: malformed extension UI requests", () => {
  it.each([
    ["missing title", { method: "confirm", message: "Proceed?" }],
    ["missing select options", { method: "select", title: "Pick one" }],
    ["overlong editor prefill", { method: "editor", title: "Edit", prefill: "x".repeat(EXTENSION_DIALOG_INPUT_MAX_LENGTH + 1) }],
  ])("cancels a correlated request with %s and reports the protocol failure", async (_case, request) => {
    const { hub, dialogs, client, ref } = await startedDialogSession();

    expect(() => {
      client.emit({ type: "extension_ui_request", id: "wire-invalid", ...request });
    }).not.toThrow();

    expect(client.sent).toContainEqual({ id: "wire-invalid", type: "extension_ui_response", cancelled: true });
    expect(dialogs.pendingDialogs(ref.id)).toEqual([]);
    expect(hub.eventsFor(ref.id)).toContainEqual(expect.objectContaining({ type: "session.error" }));
    expect(hub.eventsFor(ref.id).filter((event) => event.type === "dialog.opened")).toEqual([]);
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
  ])("reports and tears down a blocking request with a %s wire id", async (_case, id) => {
    const { service, hub, dialogs, client, ref } = await startedDialogSession();

    expect(() => {
      client.emit({ type: "extension_ui_request", ...(id === undefined ? {} : { id }), method: "confirm", title: "Continue?" });
    }).not.toThrow();

    await vi.waitFor(() => {
      expect(client.closed).toBe(true);
      expect(service.activeCount()).toBe(0);
    });
    expect(dialogs.pendingDialogs(ref.id)).toEqual([]);
    expect(hub.eventsFor(ref.id)).toContainEqual(expect.objectContaining({ type: "session.error" }));
    expect(client.sent.filter((frame) => frame.type === "extension_ui_response")).toEqual([]);
  });
});
