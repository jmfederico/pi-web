import { describe, expect, it, vi } from "vitest";
import type { SessionUiEvent } from "../../../shared/apiTypes.js";
import { OmpSessionService } from "./ompSessionService.js";
import {
  CapturingSessionEventHub,
  fakeRpcClientFactory,
  FakeOmpRpcClient,
  FakeOmpSessionStore,
  getStatePayload,
  NEW_SESSION_ACCEPTED,
  sessionStatsPayload,
  TEST_AGENT_DIR,
  TEST_NATIVE_ID_A,
} from "./ompSessionService.testSupport.js";

type EventOfType<T extends SessionUiEvent["type"]> = Extract<SessionUiEvent, { type: T }>;

async function startedShellSession(configureClient?: (client: FakeOmpRpcClient) => void) {
  const factory = fakeRpcClientFactory((client) => {
    client.onSuccess("new_session", NEW_SESSION_ACCEPTED);
    client.onSuccess("get_session_stats", sessionStatsPayload(TEST_NATIVE_ID_A));
    client.onSuccess("get_state", getStatePayload(TEST_NATIVE_ID_A));
    client.onSuccess("bash", { output: "browser-omp-smoke\n", exitCode: 0, cancelled: false, truncated: false });
    configureClient?.(client);
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

async function settleMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("OmpSessionService: public shell command contract", () => {

  it("strips the public ! prefix before sending the native OMP bash command and publishes its output", async () => {
    const { service, hub, client, ref } = await startedShellSession();

    await service.shell(ref, "!printf 'browser-omp-smoke\\n'");

    expect(client.requested.find((command) => command.type === "bash")).toEqual({ type: "bash", command: "printf 'browser-omp-smoke\\n'" });
    const events = hub.eventsFor(ref.id);
    const start = events.find((event): event is EventOfType<"shell.start"> => event.type === "shell.start");
    expect(start).toMatchObject({ command: "printf 'browser-omp-smoke\\n'", excludeFromContext: false });
    await vi.waitFor(() => {
      const end = hub.eventsFor(ref.id).find((event): event is EventOfType<"shell.end"> => event.type === "shell.end");
      expect(end).toMatchObject({ output: "browser-omp-smoke\n", exitCode: 0, cancelled: false, truncated: false });
    });
  });

  it("rejects an empty ! command without executing native bash", async () => {
    const { service, client, ref } = await startedShellSession();

    await expect(service.shell(ref, "!   ")).rejects.toThrow();

    expect(client.requested.some((command) => command.type === "bash")).toBe(false);
  });

  it("rejects !! explicitly without execution because OMP cannot exclude shell output from context", async () => {
    const { service, client, ref } = await startedShellSession();

    await expect(service.shell(ref, "!!printf secret")).rejects.toThrow();

    expect(client.requested.some((command) => command.type === "bash")).toBe(false);
  });
  it("tracks one deferred native bash run, accepts immediately, rejects overlap, and aborts the correct operation", async () => {
    let releaseBash: ((result: { output: string; exitCode: number; cancelled: boolean; truncated: boolean }) => void) | undefined;
    const bashGate = new Promise<{ output: string; exitCode: number; cancelled: boolean; truncated: boolean }>((resolve) => {
      releaseBash = resolve;
    });
    let bashRequests = 0;
    const { service, hub, client, ref } = await startedShellSession((configured) => {
      configured.on("bash", () => {
        bashRequests++;
        if (bashRequests > 1) throw new Error("duplicate reached native bash");
        return bashGate;
      });
      configured.onSuccess("abort_bash", {});
      configured.onSuccess("abort", {});
    });

    let firstOutcome = "pending";
    const first = service.shell(ref, "!sleep 10").then(
      () => { firstOutcome = "accepted"; },
      () => { firstOutcome = "rejected"; },
    );
    await settleMicrotasks();
    const outcomeBeforeCompletion = firstOutcome;
    const pendingStatus = await service.status(ref);
    const duplicateError = await service.shell(ref, "!echo overlap").then(
      () => undefined,
      (error: unknown) => error,
    );
    await service.abort(ref);
    const requestsWhileRunning = [...client.requested];

    releaseBash?.({ output: "stopped\n", exitCode: 130, cancelled: true, truncated: false });
    await first;
    await settleMicrotasks();
    const settledStatus = await service.status(ref);
    await service.abort(ref);

    expect(outcomeBeforeCompletion).toBe("accepted");
    expect(pendingStatus.isBashRunning).toBe(true);
    expect(duplicateError).toBeInstanceOf(Error);
    if (!(duplicateError instanceof Error)) throw new Error("expected duplicate bash call to reject with an Error");
    expect(duplicateError.message).toMatch(/bash command is already running/i);
    expect(bashRequests).toBe(1);
    expect(requestsWhileRunning.some((command) => command.type === "abort_bash")).toBe(true);
    expect(requestsWhileRunning.some((command) => command.type === "abort")).toBe(false);
    expect(settledStatus.isBashRunning).toBe(false);
    expect(client.requested.at(-1)).toEqual({ type: "abort" });
    const end = hub.eventsFor(ref.id).find((event): event is EventOfType<"shell.end"> => event.type === "shell.end");
    expect(end).toMatchObject({ output: "stopped\n", exitCode: 130, cancelled: true, truncated: false });
  });

  it("clears the running flag and publishes the native failure after a deferred bash rejection", async () => {
    let rejectBash: ((error: Error) => void) | undefined;
    const bashGate = new Promise<never>((_resolve, reject) => {
      rejectBash = reject;
    });
    const { service, hub, ref } = await startedShellSession((client) => {
      client.on("bash", () => bashGate);
    });

    let shellOutcome = "pending";
    const shell = service.shell(ref, "!false").then(
      () => { shellOutcome = "accepted"; },
      () => { shellOutcome = "rejected"; },
    );
    await settleMicrotasks();
    const outcomeBeforeFailure = shellOutcome;
    const pendingStatus = await service.status(ref);
    rejectBash?.(new Error("native bash failed"));
    await shell;
    await settleMicrotasks();
    const settledStatus = await service.status(ref);

    expect(outcomeBeforeFailure).toBe("accepted");
    expect(pendingStatus.isBashRunning).toBe(true);
    expect(settledStatus.isBashRunning).toBe(false);
    const end = hub.eventsFor(ref.id).find((event): event is EventOfType<"shell.end"> => event.type === "shell.end");
    expect(end).toMatchObject({ isError: true, output: "native bash failed" });
  });

});
