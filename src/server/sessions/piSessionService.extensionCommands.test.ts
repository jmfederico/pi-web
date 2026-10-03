import type { ExtensionCommandContextActions } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiSessionService, type PiAgentSession } from "./piSessionService.js";
import { CapturingSessionEventHub, emptyArchiveStore, fakeRuntime, fakeSessionManager, runtimeCreator, sessionGateway, sessionRecord, sessionRef, testModelRuntime } from "./piSessionService.testSupport.js";

const SESSION_ID = "extension-command-session";
const ref = sessionRef(SESSION_ID);
const services: PiSessionService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()));
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function harness() {
  let leafId: string | null = "leaf-1";
  const hub = new CapturingSessionEventHub();
  const archiveStore = emptyArchiveStore();
  const navigateTree = vi.fn<NonNullable<PiAgentSession["navigateTree"]>>(() => Promise.resolve({ cancelled: false, editorText: "edit this prompt" }));
  const fake = fakeRuntime(SESSION_ID, {
    sessionManager: fakeSessionManager(ref.cwd, { getSessionId: () => SESSION_ID, getLeafId: () => leafId }),
    navigateTree,
  });
  fake.session.extensionRunner.getRegisteredCommands = () => [{ invocationName: "control" }];
  const fork = vi.fn<typeof fake.runtime.fork>(() => Promise.resolve({ cancelled: false, selectedText: "fork draft" }));
  fake.runtime.fork = fork;
  const gateway = sessionGateway([sessionRecord(SESSION_ID)]);
  const service = new PiSessionService(hub, {
    agentDir: "/tmp/pi-web-test-agent", modelRuntime: testModelRuntime,
    createAgentRuntime: runtimeCreator(fake.runtime), sessionManager: gateway,
    archiveStore, heartbeatIntervalMs: 60_000,
  });
  services.push(service);
  await service.status(ref);
  const actions = fake.calls.bindExtensions.at(-1)?.commandContextActions;
  if (actions === undefined) throw new Error("Hosted extensions have no command-context actions");
  const run = async (handler: (actions: ExtensionCommandContextActions) => Promise<unknown>) => {
    const completion = deferred<{ value?: unknown; error?: unknown }>();
    fake.session.prompt = async () => {
      try { completion.resolve({ value: await handler(actions) }); }
      catch (error) { completion.resolve({ error }); throw error; }
    };
    await service.runCommand(ref, "/control");
    return completion.promise;
  };
  return { service, hub, fake, actions, navigateTree, fork, archiveStore, gateway, run, setLeaf: (id: string | null) => { leafId = id; } };
}

describe("PiSessionService extension command-context actions", () => {
  it("allows a hosted command to navigate without treating its own receipt as active work", async () => {
    const h = await harness();
    const options = { summarize: true, customInstructions: "focus", replaceInstructions: true, label: "checkpoint" };
    expect(await h.run((actions) => actions.navigateTree("target", options))).toEqual({ value: { cancelled: false } });
    expect(h.navigateTree).toHaveBeenCalledWith("target", options);
    expect(h.hub.sessionEvents).toContainEqual({ sessionId: SESSION_ID,
      event: { type: "session.tree.navigated", result: { cancelled: false, editorText: "edit this prompt" } },
    });
  });

  it.each([undefined, "before", "at"] as const)("preserves extension fork position %s", async (position) => {
    const h = await harness();
    expect(await h.run((actions) => actions.fork("entry", position === undefined ? undefined : { position })))
      .toEqual({ value: { cancelled: false } });
    expect(h.fork).toHaveBeenCalledWith("entry", { position: position ?? "before" });
    expect(h.hub.sessionEvents.find(({ event }) => event.type === "session.tree.forked")).toMatchObject({
      sessionId: SESSION_ID, event: { type: "session.tree.forked", result: { cancelled: false, promptDraft: "fork draft" } },
    });
  });

  it.each(["navigateTree", "fork"] as const)("does not announce changes when %s is cancelled", async (action) => {
    const h = await harness();
    h.navigateTree.mockResolvedValue({ cancelled: true });
    h.fork.mockResolvedValue({ cancelled: true });
    expect(await h.actions[action]("target")).toEqual({ cancelled: true });
    expect(h.hub.sessionEvents.some(({ event }) => event.type === "session.tree.navigated" || event.type === "session.tree.forked")).toBe(false);
  });

  it.each(["isStreaming", "isCompacting", "isBashRunning", "pendingMessageCount"] as const)("preserves %s protection during an extension command", async (flag) => {
    const h = await harness();
    const outcome = await h.run((actions) => {
      if (flag === "pendingMessageCount") h.fake.session.pendingMessageCount = 1;
      else h.fake.session[flag] = true;
      return actions.navigateTree("target");
    });
    expect(outcome.error).toEqual(expect.objectContaining({ message: "Stop current session activity before navigating the session tree" }));
    expect(h.navigateTree).not.toHaveBeenCalled();
  });

  it("does not exempt another prompt mutation or allow HTTP tree navigation during a command", async () => {
    const h = await harness();
    const ordinary = deferred<undefined>();
    const commandReady = deferred<undefined>();
    const resume = deferred<undefined>();
    h.fake.session.prompt = (text) => text === "ordinary" ? ordinary.promise : Promise.resolve();
    await h.service.prompt(ref, "ordinary");
    const command = h.run(async (actions) => {
      commandReady.resolve(undefined);
      await resume.promise;
      return actions.navigateTree("target");
    });
    await commandReady.promise;
    await expect(h.service.navigateTree(ref, { targetId: "target", expectedLeafId: "leaf-1", summary: { mode: "none" } }))
      .rejects.toThrow("Stop current session activity");
    resume.resolve(undefined);
    expect((await command).error).toEqual(expect.objectContaining({ message: "Stop current session activity before navigating the session tree" }));
    expect(h.navigateTree).not.toHaveBeenCalled();
    ordinary.resolve(undefined);
  });

  it("expires a completed command's receipt exemption even for detached asynchronous callbacks", async () => {
    const h = await harness();
    const trigger = deferred<undefined>();
    let late: Promise<unknown> | undefined;
    expect(await h.run(() => {
      late = trigger.promise.then(() => h.actions.navigateTree("target"));
      return Promise.resolve();
    })).toEqual({ value: undefined });
    const ordinary = deferred<undefined>();
    h.fake.session.prompt = () => ordinary.promise;
    await h.service.prompt(ref, "ordinary");
    const rejection = expect(late).rejects.toThrow("Stop current session activity");
    trigger.resolve(undefined);
    await rejection;
    expect(h.navigateTree).not.toHaveBeenCalled();
    ordinary.resolve(undefined);
  });

  it.each(["navigateTree", "fork"] as const)("rejects a stale leaf captured by an extension %s", async (action) => {
    const h = await harness();
    const entered = deferred<undefined>();
    const resume = deferred<undefined>();
    h.archiveStore.get = async () => { entered.resolve(undefined); await resume.promise; return undefined; };
    const operation = h.actions[action]("target");
    const rejection = expect(operation).rejects.toThrow("The session changed since /tree was opened");
    await entered.promise;
    h.setLeaf("changed-leaf");
    resume.resolve(undefined);
    await rejection;
    expect(h.navigateTree).not.toHaveBeenCalled();
    expect(h.fork).not.toHaveBeenCalled();
  });

  it("rejects a replaced runtime even when its copied leaf ID is unchanged", async () => {
    const h = await harness();
    const entered = deferred<undefined>();
    const names = deferred<ReturnType<typeof sessionRecord>[]>();
    h.gateway.list = () => { entered.resolve(undefined); return names.promise; };
    const operation = h.actions.fork("entry");
    const rejection = expect(operation).rejects.toThrow("The session runtime changed before forking");
    await entered.promise;
    const replacement = fakeRuntime(SESSION_ID, { sessionManager: h.fake.session.sessionManager });
    expect(Reflect.set(h.fake.runtime, "session", replacement.session)).toBe(true);
    names.resolve([]);
    await rejection;
    expect(h.fork).not.toHaveBeenCalled();
  });

  it("retains the tree-exclusive gate across asynchronous extension navigation", async () => {
    const h = await harness();
    const completed = deferred<{ cancelled: boolean }>();
    h.navigateTree.mockImplementation(() => completed.promise);
    const operation = h.actions.navigateTree("target");
    await vi.waitFor(() => { expect(h.navigateTree).toHaveBeenCalledOnce(); });
    await expect(h.actions.fork("entry")).rejects.toThrow("Stop current session activity");
    await expect(h.service.prompt(ref, "unrelated")).rejects.toThrow("while session tree navigation is active");
    completed.resolve({ cancelled: false });
    await operation;
  });

  it.each(["navigateTree", "fork", "reload"] as const)("rejects archived sessions for extension %s", async (action) => {
    const h = await harness();
    h.archiveStore.get = () => Promise.resolve({ sessionId: SESSION_ID, cwd: ref.cwd,
      archivedAt: "2026-01-01T00:00:00.000Z", archivePath: "/archive/session.jsonl" });
    await expect(action === "reload" ? h.actions.reload() : h.actions[action]("target")).rejects.toThrow("Archived sessions are read-only");
    expect(h.navigateTree).not.toHaveBeenCalled();
    expect(h.fork).not.toHaveBeenCalled();
    expect(h.fake.calls.reload).toBe(0);
  });

  it("binds idle/reload operations and fails visibly for unsupported session replacements", async () => {
    const h = await harness();
    const idle = deferred<undefined>();
    const waitForIdle = vi.fn(() => idle.promise);
    h.fake.session.waitForIdle = waitForIdle;
    const waiting = h.actions.waitForIdle();
    expect(waitForIdle).toHaveBeenCalledOnce();
    idle.resolve(undefined);
    await waiting;
    expect(await h.run((actions) => actions.reload())).toEqual({ value: undefined });
    expect(h.fake.calls.reload).toBe(1);
    await expect(h.actions.newSession()).rejects.toThrow("ctx.newSession() is not supported in PI WEB");
    await expect(h.actions.switchSession("/tmp/other.jsonl")).rejects.toThrow("ctx.switchSession() is not supported in PI WEB");
  });

  it("refuses retained command actions after their runtime is closed", async () => {
    const h = await harness();
    await h.service.stop(ref);
    await expect(h.actions.navigateTree("target")).rejects.toThrow("unavailable session runtime");
    expect(h.navigateTree).not.toHaveBeenCalled();
  });
});
