import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSessionNamingConfig } from "./config.js";
import { registerSessionNaming } from "./extensions/index.js";
import { cleanSessionName, fallbackSessionName } from "./generator.js";

const model: Model<Api> = {
  id: "fake", name: "Fake", api: "anthropic-messages", provider: "anthropic", baseUrl: "https://example.test",
  reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100,
};
function message(text: string): AssistantMessage {
  return {
    role: "assistant", content: [{ type: "text", text }], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop", timestamp: 0,
  };
}

function harness(config: unknown = {}) {
  type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;
  const handlers = new Map<string, Handler>();
  const manager = SessionManager.inMemory();
  const stream = createAssistantMessageEventStream();
  const streamSimple = vi.fn<ExtensionContext["modelRegistry"]["streamSimple"]>(() => stream);
  const find = vi.fn<ExtensionContext["modelRegistry"]["find"]>();
  // Deliberately partial SDK boundary: only methods the extension consumes are supplied.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- partial public SDK test boundary.
  const ctx = { model, sessionManager: manager, modelRegistry: { streamSimple, find } } as unknown as ExtensionContext;
  const setSessionName = vi.fn((name: string) => manager.appendSessionInfo(name));
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- capture overloaded SDK event registrations without implementing unrelated APIs.
  const pi = { on: (event: string, handler: Handler) => handlers.set(event, handler),
    getSessionName: () => manager.getSessionName(), setSessionName } as unknown as ExtensionAPI;
  const warn = vi.fn();
  const loadConfig = vi.fn(() => Promise.resolve().then(() => resolveSessionNamingConfig(config)));
  registerSessionNaming(pi, { loadConfig, warn });
  const emit = (type: string, event: Record<string, unknown> = {}) => handlers.get(type)?.({ type, ...event }, ctx);
  const start = (prompt = "Please fix the login bug") => emit("before_agent_start", { messageType: "user", prompt });
  const finish = (text = "Fix login bug") => { const result = message(text); stream.push({ type: "done", reason: "stop", message: result }); stream.end(result); };
  const flush = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };
  return { manager, stream, streamSimple, ctx, find, setSessionName, warn, loadConfig, emit, start, finish, flush };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("session naming extension", () => {
  it("starts nonblocking, uses a model snapshot, and is single-flight/once-only", async () => {
    const h = harness();
    expect(h.start()).toBeUndefined();
    h.ctx.model = { ...model, id: "changed" };
    h.start("Second prompt");
    await h.flush();
    expect(h.streamSimple).toHaveBeenCalledTimes(1);
    expect(h.streamSimple.mock.calls[0]?.[0]).toBe(model);
    expect(h.streamSimple.mock.calls[0]?.[2]).toMatchObject({ maxTokens: 24, reasoning: "minimal" });
    h.finish('Title: "Fix login bug."');
    await h.flush();
    expect(h.setSessionName).toHaveBeenCalledWith("Fix login bug");
    h.start();
    expect(h.loadConfig).toHaveBeenCalledTimes(1);
  });

  it("uses the configured exact model through the registry without changing the session model", async () => {
    const h = harness({ model: "vendor/title/model", maxTokens: 60, thinkingLevel: "off" });
    const selected = { ...model, id: "title/model", provider: "vendor" };
    h.find.mockReturnValue(selected);
    h.start(); await h.flush();
    expect(h.find).toHaveBeenCalledWith("vendor", "title/model");
    expect(h.streamSimple.mock.calls[0]?.[0]).toBe(selected);
    expect(h.streamSimple.mock.calls[0]?.[2]).toMatchObject({ maxTokens: 60 });
    expect(h.streamSimple.mock.calls[0]?.[2]?.reasoning).toBeUndefined();
    expect(h.ctx.model).toBe(model);
    h.finish(); await h.flush();
  });

  it.each(["named", "history", "custom"])("skips %s sessions or runs", async (kind) => {
    const h = harness();
    if (kind === "named") h.manager.appendSessionInfo("Workflow leg");
    if (kind === "history") h.manager.appendMessage({ role: "user", content: "Earlier", timestamp: 0 });
    if (kind === "custom") h.emit("before_agent_start", { messageType: "custom" }); else h.start();
    await h.flush();
    expect(h.loadConfig).not.toHaveBeenCalled();
    expect(h.setSessionName).not.toHaveBeenCalled();
  });

  it.each(["missing model", "bad config", "provider error", "empty title"])("warns and falls back on %s", async (kind) => {
    const h = harness(kind === "missing model" ? { model: "vendor/missing" } : kind === "bad config" ? { enabled: true } : {});
    h.start(); await h.flush();
    if (kind === "provider error") {
      const error = { ...message(""), stopReason: "error" as const, errorMessage: "denied" };
      h.stream.push({ type: "error", reason: "error", error }); h.stream.end(error);
    } else h.finish("");
    await h.flush();
    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(h.setSessionName).toHaveBeenCalledWith("Please fix the login bug");
  });

  it("bounds an uncooperative provider and ignores its late result", async () => {
    vi.useFakeTimers();
    const h = harness({ timeoutMs: 5 });
    h.start(); await h.flush();
    await vi.advanceTimersByTimeAsync(5);
    expect(h.streamSimple.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
    expect(h.setSessionName).toHaveBeenCalledWith("Please fix the login bug");
    h.finish("Too late"); await h.flush();
    expect(h.setSessionName).toHaveBeenCalledTimes(1);
  });

  it.each(["session_shutdown", "session_before_tree", "session_start", "session_info_changed"])("cancels on %s without fallback or late writes", async (event) => {
    const h = harness(); h.start(); await h.flush();
    h.emit(event);
    expect(h.streamSimple.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
    h.finish(); await h.flush();
    expect(h.setSessionName).not.toHaveBeenCalled();
    expect(h.warn).not.toHaveBeenCalled();
  });

  it("lets manual and extension names win even without an event notification", async () => {
    const h = harness(); h.start(); await h.flush();
    h.manager.appendSessionInfo("My chosen name");
    h.finish(); await h.flush();
    expect(h.setSessionName).not.toHaveBeenCalled();
    expect(h.manager.getSessionName()).toBe("My chosen name");
  });

  it("guards session identity even if replacement omits lifecycle events", async () => {
    const h = harness(); h.start(); await h.flush();
    vi.spyOn(h.manager, "getSessionId").mockReturnValue("replacement");
    h.finish(); await h.flush();
    expect(h.setSessionName).not.toHaveBeenCalled();
  });

  it("captures the request signal and suppresses late names and fallback after a stopped turn", async () => {
    const h = harness();
    const request = new AbortController();
    Object.defineProperty(h.ctx, "signal", { configurable: true, get: () => request.signal });
    h.start(); await h.flush();
    Object.defineProperty(h.ctx, "signal", { get: () => undefined });
    request.abort();
    expect(h.streamSimple.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
    h.finish(); await h.flush();
    expect(h.setSessionName).not.toHaveBeenCalled();
    expect(h.warn).not.toHaveBeenCalled();
  });

  it("does not call a provider when cancelled during config loading", async () => {
    const h = harness(); h.start(); h.emit("session_shutdown"); await h.flush();
    expect(h.streamSimple).not.toHaveBeenCalled();
    expect(h.setSessionName).not.toHaveBeenCalled();
  });
});

describe("loaded Pi package prompt integration", () => {
  it("names the first actual SDK prompt and emits the generic session-info event", async () => {
    const dir = await mkdtemp(join(tmpdir(), "naming-sdk-"));
    vi.stubEnv("PI_CODING_AGENT_DIR", dir);
    vi.stubEnv("PI_WEB_SESSION_NAMING", "{}");
    let dispose: (() => void) | undefined;
    try {
      const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
      vi.spyOn(runtime, "hasConfiguredAuth").mockReturnValue(true);
      const namingStream = createAssistantMessageEventStream();
      let namingStarted: () => void = vi.fn();
      const started = new Promise<void>((resolve) => { namingStarted = resolve; });
      vi.spyOn(runtime, "streamSimple").mockImplementation((_model, context) => {
        if (context.systemPrompt?.startsWith("Generate a concise title") === true) {
          namingStarted();
          return namingStream;
        }
        const stream = createAssistantMessageEventStream();
        const result = message("Main agent reply");
        stream.push({ type: "done", reason: "stop", message: result }); stream.end(result);
        return stream;
      });
      const settings = SettingsManager.inMemory({ packages: [fileURLToPath(new URL(".", import.meta.url))], compaction: { enabled: false }, cacheWarming: "off" });
      const names: (string | undefined)[] = [];
      const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings,
        noThemes: true, noSkills: true, noPromptTemplates: true,
        extensionFactories: [(pi) => { pi.on("session_info_changed", (event) => { names.push(event.name); }); }],
      });
      await loader.reload();
      expect(loader.getExtensions().errors).toEqual([]);
      const { session } = await createAgentSession({ cwd: dir, agentDir: dir, model, modelRuntime: runtime,
        resourceLoader: loader, settingsManager: settings, sessionManager: SessionManager.inMemory(dir), tools: [], thinkingLevel: "off" });
      dispose = () => { session.dispose(); };
      await session.bindExtensions({});
      const prompt = session.prompt("Please fix the login bug");
      await started;
      const result = message("Fix login bug");
      namingStream.push({ type: "done", reason: "stop", message: result }); namingStream.end(result);
      await prompt;
      await vi.waitFor(() => { expect(session.sessionManager.getSessionName()).toBe("Fix login bug"); });
      expect(names).toContain("Fix login bug");
    } finally {
      dispose?.();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("safe first-request fallback", () => {
  it("retains the existing six-word rule and ignores skill/code blocks", () => {
    expect(fallbackSessionName("Seems like auto name for sessions is not working")).toBe("Seems like auto name for sessions");
    expect(fallbackSessionName('<skill name="x" location="/x">\nDo x\n</skill>\n```code```\nCheck the UI now')).toBe("Check the UI now");
    expect(fallbackSessionName(undefined)).toBeUndefined();
    expect(cleanSessionName("A\0safe title" )).toBe("A safe title");
    expect(cleanSessionName("a".repeat(90))).toHaveLength(60);
  });
});
