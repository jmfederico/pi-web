import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { createAgentSession, createEventBus, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import plugin from "../../../examples/session-bridge-plugin/src/server.js";
import { isReview } from "../../../examples/session-bridge-plugin/src/browser/protocol.js";
import { PiSessionEventConnections } from "./piSessionEventConnections.js";
import { createTestModelRuntime, testModel } from "./piSessionService.testSupport.js";

// Real copied package discovery, native message hooks, backend event connection and disk writes.
// Only host admission and provider transport are replaced; no live credentials or daemon used.
it.each(["stop", "error", "aborted", "length", "empty", "interference", "tools", "tool-error"] as const)("copied review package records native %s outcome", async (outcome) => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-native-"));
  const packageRoot = join(root, "package");
  // Exercise package discovery without copying a developer's installed dependencies/build output.
  await mkdir(packageRoot);
  await cp(resolve("examples/session-bridge-plugin/package.json"), join(packageRoot, "package.json"));
  await cp(resolve("examples/session-bridge-plugin/src"), join(packageRoot, "src"), { recursive: true });
  const manifest: unknown = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  expect(manifest).toMatchObject({ pi: { extensions: ["./src/companion.ts"] } });
  const modelRuntime = await createTestModelRuntime();
  await modelRuntime.setRuntimeApiKey("anthropic", "isolated-test-key");
  const settingsManager = SettingsManager.inMemory({ packages: [packageRoot], retry: { enabled: false }, compaction: { enabled: false } });
  const bus = createEventBus();
  const loader = new DefaultResourceLoader({
    cwd: root, agentDir: root, settingsManager, eventBus: bus,
    noSkills: true, noPromptTemplates: true, noThemes: true,
    agentsFilesOverride: () => ({ agentsFiles: [] }),
  });
  await loader.reload();
  expect(loader.getExtensions().errors).toEqual([]);
  expect(loader.getExtensions().extensions).toHaveLength(1);
  const { session } = await createAgentSession({
    cwd: root, agentDir: root, sessionManager: SessionManager.inMemory(root),
    settingsManager, resourceLoader: loader, modelRuntime, model: testModel(), tools: ["read"],
  });
  const hookErrors = vi.fn();
  await session.bindExtensions({ onError: hookErrors });
  const connections = new PiSessionEventConnections();
  connections.register(session, bus);
  const lifetime = new AbortController();
  let calls = 0;
  session.agent.streamFunction = () => {
    calls++;
    if (outcome === "interference" && calls === 1) void session.followUp("Unrelated user request");
    const usesTool = outcome === "tools" || outcome === "tool-error";
    const stopReason = usesTool ? (calls === 1 ? "toolUse" : "stop") : outcome === "empty" || outcome === "interference" ? "stop" : outcome;
    const message: AssistantMessage = {
      role: "assistant", content: usesTool && calls === 1
        ? [{ type: "toolCall", id: "read-source", name: "read", arguments: { path: join(packageRoot, outcome === "tools" ? "package.json" : "missing-file") } }]
        : outcome === "empty" ? [] : [{ type: "text", text: "Findings: src/file.ts:4 introduces a regression" }],
      api: "anthropic-messages", provider: "anthropic", model: testModel().id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason, timestamp: Date.now(),
      ...(outcome === "error" ? { errorMessage: "synthetic provider failure" } : {}),
    };
    const stream = createAssistantMessageEventStream();
    if (stopReason === "error" || stopReason === "aborted") stream.push({ type: "error", reason: stopReason, error: message });
    else stream.push({ type: "done", reason: stopReason, message });
    stream.end(message);
    return stream;
  };
  const activation = plugin.activate({
    apiVersion: 3, pluginId: "review", packageRoot, dataDirectory: root, settings: {},
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    signal: new AbortController().signal, lifetimeSignal: lifetime.signal,
    execFile: () => { throw new Error("No backend shell expected"); },
  });
  activation.start({
    signal: new AbortController().signal,
    capabilities: { resolve: (capability) => capability.parse(capability.id === "pi-sessions"
      ? { version: 1, create: () => Promise.resolve({ sessionId: session.sessionId }), run: () => { throw new Error("No core run API"); } }
      : { version: 1, connect: () => Promise.resolve(connections.connect(session, lifetime.signal)) }) },
  });
  const context = {
    project: { id: "project", name: "Project", path: root },
    workspace: { id: "workspace", projectId: "project", path: root, label: "Workspace", isMain: true },
    signal: new AbortController().signal,
  };
  try {
    const record = await activation.peer.request({ ...context, operation: "start", input: null });
    if (!isReview(record)) throw new Error("Invalid admitted review");
    await vi.waitFor(async () => {
      const saved = await activation.peer.request({ ...context, operation: "read", input: record.id });
      if (!isReview(saved)) throw new Error("Invalid saved review");
      expect(saved).toMatchObject({ status: outcome === "stop" || outcome === "tools" ? "completed" : "failed" });
      if (outcome === "stop") expect(saved).toMatchObject({ text: "Findings: src/file.ts:4 introduces a regression" });
      if (outcome === "error") expect(saved).toMatchObject({ text: "synthetic provider failure" });
      if (outcome === "interference") expect(saved.text).toContain("interfered");
      if (outcome === "tool-error") expect(saved.text).toContain("Review tool failed: read");
    });
    expect(hookErrors).not.toHaveBeenCalled();
    expect(session.messages.find((message) => message.role !== "system")).toMatchObject({ role: "user" });
  } finally {
    lifetime.abort();
    await activation.dispose();
    await session.abort();
    session.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
