import type { ExtensionAPI, ExtensionContext, ExtensionHandler, SessionShutdownEvent, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { KNOWN_THINKING_LEVELS } from "../../shared/thinkingLevels.js";
import { createExtensionSessionDispatch, SESSION_DISPATCH_CHANNEL } from "./extensionSessionDispatch.js";
import { stubExtensionToolContext } from "./piSessionService.testSupport.js";
import { SESSION_UI_METADATA_MAX_BYTES } from "./sessionMetadata.js";
import type { SpawnSessionModel, SpawnSessionResult, SpawnSessionThinkingLevel, SpawnSessionToolDeps } from "./spawnSessionTool.js";

const spawned: SpawnSessionResult = { sessionId: "new-1", cwd: "/repos/a-feature", model: "openai/worker" };
const dispatchModel: SpawnSessionModel = {
  provider: "anthropic", id: "caller-model", name: "Caller model", api: "anthropic-messages",
  baseUrl: "https://example.invalid", input: ["text"], reasoning: true,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 4096,
};

type LifecycleEvent = SessionStartEvent | SessionShutdownEvent;

function contextFor(sessionId = "caller-1", model?: SpawnSessionModel, thinkingLevel?: SpawnSessionThinkingLevel): ExtensionContext {
  return stubExtensionToolContext({
    cwd: "/different-context-cwd",
    sessionManager: { getSessionId: () => sessionId },
    model,
    thinkingLevel,
  });
}

/** Fake only registration, not Pi's session runtime or the bridge's validation. */
async function registerDispatch(deps: Partial<Parameters<typeof createExtensionSessionDispatch>[1]> = {}) {
  const lifecycle = new Map<string, ExtensionHandler<LifecycleEvent>>();
  const channels = new Map<string, (envelope: unknown) => void>();
  const api = {
    on(event: string, handler: ExtensionHandler<LifecycleEvent>) {
      lifecycle.set(event, handler);
      return () => { lifecycle.delete(event); };
    },
    events: {
      on(channel: string, handler: (envelope: unknown) => void) {
        channels.set(channel, handler);
        return () => { channels.delete(channel); };
      },
    },
  };
  // The factory only needs these registration methods; a full ExtensionAPI fake would obscure the seam.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  await createExtensionSessionDispatch("/repos/a", { isEnabled: () => true, ...deps })(api as unknown as ExtensionAPI);

  function emit(envelope: unknown): void {
    const handler = channels.get("pi-web:session-dispatch:v1");
    if (handler === undefined) throw new Error("Session dispatch channel was not registered");
    handler(envelope);
  }

  function dispatch(input: unknown): Promise<SpawnSessionResult> {
    const accept = vi.fn<(promise: Promise<SpawnSessionResult>) => void>();
    emit({ input, accept });
    // Check before yielding: delayed acknowledgement is a protocol failure, even if spawn succeeds.
    expect(accept).toHaveBeenCalledTimes(1);
    const promise = accept.mock.calls[0]?.[0];
    expect(promise).toBeInstanceOf(Promise);
    if (promise === undefined) throw new Error("Dispatch did not synchronously accept a result promise");
    return promise;
  }

  async function notify(event: LifecycleEvent, ctx: ExtensionContext): Promise<void> {
    const handler = lifecycle.get(event.type);
    if (handler === undefined) throw new Error(`Lifecycle handler ${event.type} was not registered`);
    await handler(event, ctx);
  }

  return {
    emit,
    dispatch,
    start: (ctx = contextFor()) => notify({ type: "session_start", reason: "startup" }, ctx),
    shutdown: (ctx = contextFor()) => notify({ type: "session_shutdown", reason: "quit" }, ctx),
  };
}

function pendingSpawnResult() {
  let resolve!: (result: SpawnSessionResult) => void;
  const promise = new Promise<SpawnSessionResult>((settle) => { resolve = settle; });
  return { promise, resolve };
}

describe("extension session dispatch protocol", () => {
  it("exports the versioned channel and synchronously accepts a promise while spawn is pending", async () => {
    expect(SESSION_DISPATCH_CHANNEL).toBe("pi-web:session-dispatch:v1");
    const pending = pendingSpawnResult();
    const spawn = vi.fn<SpawnSessionToolDeps["spawn"]>(() => pending.promise);
    const bridge = await registerDispatch({ spawn });
    await bridge.start();

    const result = bridge.dispatch({ prompt: "Start independent work" });
    pending.resolve(spawned);

    await expect(result).resolves.toBe(spawned);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("derives identity, model, and thinking defaults from the captured context, with the factory's cwd", async () => {
    const spawn = vi.fn<SpawnSessionToolDeps["spawn"]>().mockResolvedValue(spawned);
    const bridge = await registerDispatch({ spawn });
    await bridge.start(contextFor("trusted-caller", dispatchModel, "high"));

    await bridge.dispatch({ prompt: "  Preserve the prompt verbatim\n" });

    expect(spawn).toHaveBeenCalledExactlyOnceWith({
      spawningCwd: "/repos/a", spawningSessionId: "trusted-caller",
      prompt: "  Preserve the prompt verbatim\n", cwd: undefined, model: dispatchModel, thinkingLevel: "high",
    });
  });

  it("omits unavailable model and thinking defaults and optional request fields", async () => {
    const spawn = vi.fn<SpawnSessionToolDeps["spawn"]>().mockResolvedValue(spawned);
    const bridge = await registerDispatch({ spawn });
    await bridge.start();

    await bridge.dispatch({ prompt: "Work" });

    expect(spawn).toHaveBeenCalledExactlyOnceWith({
      spawningCwd: "/repos/a", spawningSessionId: "caller-1", prompt: "Work", cwd: undefined,
    });
  });

  it.each(KNOWN_THINKING_LEVELS)("forwards model overrides as modelSpec and overrides thinking with %s without mutating the caller", async (thinkingLevel) => {
    const spawn = vi.fn<SpawnSessionToolDeps["spawn"]>().mockResolvedValue(spawned);
    const bridge = await registerDispatch({ spawn });
    const ctx = contextFor("caller-1", dispatchModel, "high");
    await bridge.start(ctx);

    await bridge.dispatch({ prompt: "Work", model: "openai/worker", thinkingLevel });

    expect(spawn).toHaveBeenCalledExactlyOnceWith({
      spawningCwd: "/repos/a", spawningSessionId: "caller-1", prompt: "Work", cwd: undefined,
      model: dispatchModel, modelSpec: "openai/worker", thinkingLevel,
    });
    expect(ctx.model).toBe(dispatchModel);
    expect(ctx.thinkingLevel).toBe("high");
  });

  it.each([
    { label: "model only", input: { model: "openai/worker" }, forwarded: { modelSpec: "openai/worker", thinkingLevel: "high" } },
    { label: "thinking only", input: { thinkingLevel: "off" }, forwarded: { thinkingLevel: "off" } },
  ])("overrides $label while inheriting the other default", async ({ input, forwarded }) => {
    const spawn = vi.fn<SpawnSessionToolDeps["spawn"]>().mockResolvedValue(spawned);
    const bridge = await registerDispatch({ spawn });
    await bridge.start(contextFor("caller-1", dispatchModel, "high"));

    await bridge.dispatch({ prompt: "Work", ...input });

    expect(spawn).toHaveBeenCalledExactlyOnceWith({
      spawningCwd: "/repos/a", spawningSessionId: "caller-1", prompt: "Work", cwd: undefined,
      model: dispatchModel, ...forwarded,
    });
  });

  it("reads current model and thinking defaults from the captured context on each request", async () => {
    const spawn = vi.fn<SpawnSessionToolDeps["spawn"]>().mockResolvedValue(spawned);
    const bridge = await registerDispatch({ spawn });
    const ctx = contextFor("caller-1", dispatchModel, "high");
    await bridge.start(ctx);
    await bridge.dispatch({ prompt: "Before model selection" });
    const selectedModel: SpawnSessionModel = { ...dispatchModel, id: "selected-model" };
    ctx.model = selectedModel;
    ctx.thinkingLevel = "off";

    await bridge.dispatch({ prompt: "After model selection" });

    expect(spawn).toHaveBeenLastCalledWith({
      spawningCwd: "/repos/a", spawningSessionId: "caller-1", prompt: "After model selection", cwd: undefined,
      model: selectedModel, thinkingLevel: "off",
    });
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("snapshots the complete request and deeply detaches UI metadata before any await", async () => {
    const pending = pendingSpawnResult();
    const spawn = vi.fn<SpawnSessionToolDeps["spawn"]>(() => pending.promise);
    const bridge = await registerDispatch({ spawn });
    await bridge.start(contextFor("trusted-caller", dispatchModel, "high"));
    const metadata = { "@example/workflow": { identity: { leg: 1 }, flags: [true, null] } };
    const input = {
      prompt: "Original prompt", cwd: "/repos/a-feature", name: "Feature work", metadata,
      model: "openai/worker", thinkingLevel: "low",
    };

    const result = bridge.dispatch(input);
    input.prompt = "Changed prompt";
    input.cwd = "/elsewhere";
    input.name = "Changed name";
    input.model = "other/model";
    input.thinkingLevel = "max";
    metadata["@example/workflow"].identity.leg = 99;
    metadata["@example/workflow"].flags.push(false);
    input.metadata = { "@example/workflow": { identity: { leg: 100 }, flags: [] } };
    pending.resolve(spawned);
    await expect(result).resolves.toBe(spawned);

    expect(spawn).toHaveBeenCalledExactlyOnceWith({
      spawningCwd: "/repos/a", spawningSessionId: "trusted-caller",
      prompt: "Original prompt", cwd: "/repos/a-feature", name: "Feature work",
      metadata: { "@example/workflow": { identity: { leg: 1 }, flags: [true, null] } },
      model: dispatchModel, modelSpec: "openai/worker", thinkingLevel: "low",
    });
    const invocation = spawn.mock.calls[0]?.[0];
    expect(invocation?.metadata).not.toBe(metadata);
    expect(Object.isFrozen(invocation?.metadata)).toBe(true);
    expect(Object.isFrozen(invocation?.metadata?.["@example/workflow"])).toBe(true);
  });

  it.each(["throw", "reject"])("forwards the exact spawn error through the accepted promise when spawn callbacks %s", async (mode) => {
    const failure = new Error("cwd must be a workspace of this project");
    const spawn = vi.fn<SpawnSessionToolDeps["spawn"]>(() => {
      if (mode === "throw") throw failure;
      return Promise.reject(failure);
    });
    const bridge = await registerDispatch({ spawn });
    await bridge.start();

    await expect(bridge.dispatch({ prompt: "Work", cwd: "/elsewhere" })).rejects.toBe(failure);
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});

describe("extension session dispatch lifecycle and capabilities", () => {
  it("denies dispatch before session_start and after shutdown, then uses the replacement context", async () => {
    const spawn = vi.fn<SpawnSessionToolDeps["spawn"]>().mockResolvedValue(spawned);
    const bridge = await registerDispatch({ spawn });

    await expect(bridge.dispatch({ prompt: "Too early" })).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled();
    await bridge.start(contextFor("first-caller", dispatchModel, "high"));
    await bridge.dispatch({ prompt: "First session" });
    await bridge.shutdown();
    await expect(bridge.dispatch({ prompt: "Too late" })).rejects.toThrow();
    expect(spawn).toHaveBeenCalledTimes(1);

    await bridge.start(contextFor("replacement-caller"));
    await bridge.dispatch({ prompt: "Replacement session" });
    expect(spawn).toHaveBeenLastCalledWith({
      spawningCwd: "/repos/a", spawningSessionId: "replacement-caller", prompt: "Replacement session", cwd: undefined,
    });
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("checks the live capability on every request, including revocation after startup", async () => {
    let enabled = false;
    const spawn = vi.fn<SpawnSessionToolDeps["spawn"]>().mockResolvedValue(spawned);
    const bridge = await registerDispatch({ spawn, isEnabled: () => enabled });
    await bridge.start();

    await expect(bridge.dispatch({ prompt: "Disabled" })).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled();
    enabled = true;
    await expect(bridge.dispatch({ prompt: "Enabled" })).resolves.toBe(spawned);
    enabled = false;
    await expect(bridge.dispatch({ prompt: "Revoked" })).rejects.toThrow();
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("rejects through the accepted promise when no spawn callback is installed", async () => {
    const bridge = await registerDispatch({ isEnabled: () => true });
    await bridge.start();

    await expect(bridge.dispatch({ prompt: "Work" })).rejects.toThrow();
  });

  it("ignores malformed envelopes and envelopes without a function accept without reading input or checking capabilities", async () => {
    const spawn = vi.fn<SpawnSessionToolDeps["spawn"]>().mockResolvedValue(spawned);
    const isEnabled = vi.fn(() => true);
    const bridge = await registerDispatch({ spawn, isEnabled });
    await bridge.start();
    const withoutAccept = {
      get input(): unknown { throw new Error("Ignored envelope input must not be read"); },
    };

    for (const envelope of [undefined, null, [], "text", 1, {}, withoutAccept,
      { input: { prompt: "Work" }, accept: undefined },
      { input: { prompt: "Work" }, accept: null },
      { input: { prompt: "Work" }, accept: "not a callback" },
      { input: { prompt: "Work" }, accept: {} },
    ]) {
      expect(() => { bridge.emit(envelope); }).not.toThrow();
    }
    expect(spawn).not.toHaveBeenCalled();
    expect(isEnabled).not.toHaveBeenCalled();
  });
});

describe("extension session dispatch input schema", () => {
  it.each([
    { label: "missing input", input: undefined },
    { label: "null input", input: null },
    { label: "array input", input: [] },
    { label: "string input", input: "Work" },
    { label: "numeric input", input: 1 },
    { label: "missing prompt", input: {} },
    { label: "null prompt", input: { prompt: null } },
    { label: "numeric prompt", input: { prompt: 1 } },
    { label: "empty prompt", input: { prompt: "" } },
    { label: "blank prompt", input: { prompt: " \t\n" } },
    { label: "prompt over the character limit", input: { prompt: "x".repeat(64 * 1024 + 1) } },
    { label: "prompt over the UTF-8 byte limit", input: { prompt: "é".repeat(32 * 1024 + 1) } },
    { label: "null cwd", input: { prompt: "Work", cwd: null } },
    { label: "numeric cwd", input: { prompt: "Work", cwd: 1 } },
    { label: "empty cwd", input: { prompt: "Work", cwd: "" } },
    { label: "blank cwd", input: { prompt: "Work", cwd: " \t" } },
    { label: "cwd over the limit", input: { prompt: "Work", cwd: "x".repeat(4097) } },
    { label: "null name", input: { prompt: "Work", name: null } },
    { label: "numeric name", input: { prompt: "Work", name: 1 } },
    { label: "empty name", input: { prompt: "Work", name: "" } },
    { label: "blank name", input: { prompt: "Work", name: " " } },
    { label: "untrimmed name", input: { prompt: "Work", name: " Work " } },
    { label: "name over the limit", input: { prompt: "Work", name: "x".repeat(61) } },
    { label: "NUL in name", input: { prompt: "Work", name: "Work\u0000item" } },
    { label: "newline in name", input: { prompt: "Work", name: "Work\nitem" } },
    { label: "DEL in name", input: { prompt: "Work", name: "Work\u007fitem" } },
    { label: "null model", input: { prompt: "Work", model: null } },
    { label: "model object instead of spec", input: { prompt: "Work", model: dispatchModel } },
    { label: "empty model", input: { prompt: "Work", model: "" } },
    { label: "blank model", input: { prompt: "Work", model: " \t" } },
    { label: "model over the limit", input: { prompt: "Work", model: "x".repeat(513) } },
    { label: "unknown thinking level", input: { prompt: "Work", thinkingLevel: "unknown" } },
    { label: "empty thinking level", input: { prompt: "Work", thinkingLevel: "" } },
    { label: "null thinking level", input: { prompt: "Work", thinkingLevel: null } },
    { label: "numeric thinking level", input: { prompt: "Work", thinkingLevel: 1 } },
  ])("rejects $label through the accepted promise without spawning", async ({ input }) => {
    const spawn = vi.fn<SpawnSessionToolDeps["spawn"]>().mockResolvedValue(spawned);
    const bridge = await registerDispatch({ spawn });
    await bridge.start();

    await expect(bridge.dispatch(input)).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([
    { label: "prompt at 64 KiB", input: { prompt: "x".repeat(64 * 1024) }, forwarded: { prompt: "x".repeat(64 * 1024) } },
    { label: "UTF-8 prompt at 64 KiB", input: { prompt: "é".repeat(32 * 1024) }, forwarded: { prompt: "é".repeat(32 * 1024) } },
    { label: "cwd at 4096 characters", input: { prompt: "Work", cwd: "x".repeat(4096) }, forwarded: { cwd: "x".repeat(4096) } },
    { label: "name at 60 characters", input: { prompt: "Work", name: "x".repeat(60) }, forwarded: { name: "x".repeat(60) } },
    { label: "model at 512 characters", input: { prompt: "Work", model: "x".repeat(512) }, forwarded: { modelSpec: "x".repeat(512) } },
    { label: "empty metadata snapshot", input: { prompt: "Work", metadata: {} }, forwarded: { metadata: {} } },
  ])("accepts $label", async ({ input, forwarded }) => {
    const spawn = vi.fn<SpawnSessionToolDeps["spawn"]>().mockResolvedValue(spawned);
    const bridge = await registerDispatch({ spawn });
    await bridge.start();

    await expect(bridge.dispatch(input)).resolves.toBe(spawned);
    expect(spawn).toHaveBeenCalledExactlyOnceWith({
      spawningCwd: "/repos/a", spawningSessionId: "caller-1", prompt: "Work", cwd: undefined, ...forwarded,
    });
  });

  it.each(["spawningSessionId", "spawningCwd", "sessionId", "parentSessionId", "modelSpec", "extra"])("rejects forbidden field %s rather than allowing identity or internal-field spoofing", async (field) => {
    const spawn = vi.fn<SpawnSessionToolDeps["spawn"]>().mockResolvedValue(spawned);
    const bridge = await registerDispatch({ spawn });
    await bridge.start(contextFor("trusted-caller", dispatchModel, "high"));

    await expect(bridge.dispatch({ prompt: "Work", [field]: "spoofed" })).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects unknown non-enumerable and symbol keys as well as ordinary keys", async () => {
    const spawn = vi.fn<SpawnSessionToolDeps["spawn"]>().mockResolvedValue(spawned);
    const bridge = await registerDispatch({ spawn });
    await bridge.start();
    const hiddenIdentity = Object.defineProperty({ prompt: "Work" }, "spawningSessionId", { value: "spoofed" });
    const symbolKey = { prompt: "Work", [Symbol("identity")]: "spoofed" };

    await expect(bridge.dispatch(hiddenIdentity)).rejects.toThrow();
    await expect(bridge.dispatch(symbolKey)).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled();
  });

  const cyclicMetadata: Record<string, unknown> = {};
  cyclicMetadata["example"] = cyclicMetadata;
  it.each([
    { label: "null", metadata: null },
    { label: "array", metadata: [] },
    { label: "invalid namespace", metadata: { "bad namespace": {} } },
    { label: "non-object namespace value", metadata: { example: [] } },
    { label: "undefined JSON value", metadata: { example: { invalid: undefined } } },
    { label: "non-finite JSON value", metadata: { example: { invalid: Number.NaN } } },
    { label: "cyclic JSON", metadata: cyclicMetadata },
    { label: "oversized JSON", metadata: { example: { text: "x".repeat(SESSION_UI_METADATA_MAX_BYTES) } } },
  ])("validates metadata ($label) before invoking spawn", async ({ metadata }) => {
    const spawn = vi.fn<SpawnSessionToolDeps["spawn"]>().mockResolvedValue(spawned);
    const bridge = await registerDispatch({ spawn });
    await bridge.start();

    await expect(bridge.dispatch({ prompt: "Work", metadata })).rejects.toThrow(/metadata/i);
    expect(spawn).not.toHaveBeenCalled();
  });
});
