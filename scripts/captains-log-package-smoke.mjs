import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

// Exercise shipped JS, not source imports or a simulated ExtensionAPI. The only
// replacements are host admission and provider transport; no daemon or paid API.
export async function smokeInstalledCaptainsLog({ packageRoot, fixtureRoot }) {
  const captainRoot = join(packageRoot, "dist", "pi-packages", "captains-log");
  const manifest = JSON.parse(await readFile(join(captainRoot, "package.json"), "utf8"));
  const entry = manifest.piWeb.plugins.find((plugin) => plugin.id === "captains-log");
  assert.ok(entry, "Installed Captain's Log manifest entry missing");
  assert.equal(entry.machineSpecific, true);
  assert.equal(entry.defaultEnabled, false, "Installing must not implicitly enable Captain's Log");
  for (const path of [entry.module, entry.serverModule, ...manifest.pi.extensions]) {
    assert.match(path, /\.js$/, "Installed manifest must select compiled JavaScript");
    await readFile(join(captainRoot, path));
  }
  const { default: plugin } = await import(pathToFileURL(join(captainRoot, entry.serverModule)).href);
  const { default: browser } = await import(pathToFileURL(join(captainRoot, entry.module)).href);
  const { isLogEntry, PIRATE_INTRO, captainPrompt } = await import(pathToFileURL(join(captainRoot, dirname(entry.module), "protocol.js")).href);
  const { LOG_CHANNEL, isCaptainServerFrame } = await import(pathToFileURL(join(captainRoot, dirname(entry.module), "channelProtocol.js")).href);
  assert.equal(plugin.apiVersion, 3);
  assert.equal(browser.apiVersion, 4);

  const root = join(fixtureRoot, "captains-log-roundtrip");
  await mkdir(root, { recursive: true });
  // Resolve import-only SDK exports against installed dependencies, not the
  // checkout's toolchain (createRequire.resolve uses the wrong condition).
  await symlink(join(packageRoot, "node_modules"), join(root, "node_modules"), "dir");
  await writeFile(join(root, "runtime.mjs"), `
    export * as sdk from "@earendil-works/pi-coding-agent";
    export * as ai from "@earendil-works/pi-ai";
  `);
  const { sdk, ai } = await import(pathToFileURL(join(root, "runtime.mjs")).href);
  const { PiSessionEventConnections } = await import(pathToFileURL(join(packageRoot, "dist/server/sessions/piSessionEventConnections.js")).href);
  const modelRuntime = await sdk.ModelRuntime.create({
    credentials: new ai.InMemoryCredentialStore(), modelsPath: null,
    modelsStorePath: join(root, "models-store.json"), allowModelNetwork: false,
  });
  await modelRuntime.setRuntimeApiKey("anthropic", "isolated-smoke-key");
  const model = modelRuntime.getModel("anthropic", "claude-sonnet-4-5-20250929");
  assert.ok(model, "Smoke model missing from installed SDK catalog");
  const lifetime = new AbortController();
  const connections = new PiSessionEventConnections();
  const errors = [];
  const turns = [];
  const sessions = new Map();
  const connectFailures = new Map();
  const createRealSession = async (sessionManager = sdk.SessionManager.inMemory(root)) => {
    const settingsManager = sdk.SettingsManager.inMemory({
      packages: [captainRoot], retry: { enabled: false }, compaction: { enabled: false },
    });
    const bus = sdk.createEventBus();
    const loader = new sdk.DefaultResourceLoader({
      cwd: root, agentDir: root, settingsManager, eventBus: bus,
      noSkills: true, noPromptTemplates: true, noThemes: true,
      agentsFilesOverride: () => ({ agentsFiles: [] }),
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    assert.equal(loader.getExtensions().extensions.length, 1, "Only installed native companion should load");
    const { session } = await sdk.createAgentSession({
      cwd: root, agentDir: root, resourceLoader: loader, settingsManager,
      sessionManager, modelRuntime, model, noTools: "all",
    });
    sessions.set(session.sessionId, session);
    // Install before binding extensions: even an unexpected startup prompt cannot
    // reach the real provider. Every turn is explicitly released below.
    session.agent.streamFunction = (streamModel, context) => {
      const stream = ai.createAssistantMessageEventStream();
      let released = false;
      const finish = (text, stopReason = "stop") => {
        if (released) return;
        released = true;
        const message = {
          role: "assistant", content: [{ type: "text", text }],
          api: streamModel.api, provider: streamModel.provider, model: streamModel.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason, timestamp: Date.now(),
        };
        stream.push(stopReason === "aborted"
          ? { type: "error", reason: stopReason, error: message }
          : { type: "done", reason: stopReason, message });
        stream.end(message);
      };
      turns.push({ sessionId: session.sessionId, messages: structuredClone(context.messages), finish });
      return stream;
    };
    await session.bindExtensions({ onError: (error) => errors.push(error) });
    connections.register(session, bus);
    return session;
  };
  let activation;
  let createCount = 0;
  const selectedSessions = [];
  const channelClosures = new Set();
  try {
    const source = await createRealSession();
    const startBackend = async () => {
      const backend = plugin.activate({
        apiVersion: 3, pluginId: entry.id, packageRoot: captainRoot,
        dataDirectory: join(root, "log-data"), settings: {},
        signal: lifetime.signal, lifetimeSignal: lifetime.signal,
        logger: { debug() {}, info() {}, warn() {}, error: (error) => errors.push(error) },
        execFile() { throw new Error("Unexpected backend shell execution"); },
      });
      await backend.start({
        signal: lifetime.signal,
        capabilities: { resolve: (capability) => {
          if (capability.id === "pi-sessions") return capability.parse({
            version: 1,
            create: async (selection) => {
              assert.deepEqual(selection, { projectId: "project", workspaceId: "workspace" });
              createCount++;
              const created = await createRealSession();
              return { sessionId: created.sessionId };
            },
            run() { throw new Error("Captain must message its native companion, not call run"); },
          });
          assert.equal(capability.id, "pi-session-events");
          return capability.parse({ version: 1, connect: async (selection) => {
            assert.deepEqual(selection, { projectId: "project", workspaceId: "workspace", sessionId: selection.sessionId });
            selectedSessions.push(selection.sessionId);
            if (connectFailures.has(selection.sessionId)) throw new Error(connectFailures.get(selection.sessionId));
            const selected = sessions.get(selection.sessionId);
            assert.ok(selected, "Connect must select a real fixture session");
            return connections.connect(selected, lifetime.signal);
          } });
        } },
      });
      return backend;
    };
    activation = await startBackend();
    const context = {
      project: { id: "project", name: "Project", path: root },
      workspace: { id: "workspace", projectId: "project", path: root, label: "Workspace", isMain: true },
      signal: lifetime.signal,
    };
    const request = (operation, input = null) => activation.peer.request({ ...context, operation, input });
    const read = async (id) => {
      const record = await request("read", id);
      assert.ok(isLogEntry(record), "read must return a protocol LogEntry");
      return record;
    };
    const openLog = async () => {
      const controller = new AbortController();
      const frames = [];
      const pushed = new Map();
      const channel = await activation.peer.openChannel({
        ...context, operation: LOG_CHANNEL, input: null, signal: controller.signal,
        send(frame) {
          const json = JSON.stringify(frame);
          assert.ok(Buffer.byteLength(json) <= 64 * 1024, "Push must fit the host channel frame limit");
          const data = JSON.parse(json);
          assert.ok(isCaptainServerFrame(data), "Backend must push valid browser protocol frames");
          frames.push(data);
          if (data.type === "entry") pushed.set(data.entry.id, { ...data.entry });
          if (data.type === "text") {
            const record = pushed.get(data.id);
            assert.ok(record, "Text chunks must follow an entry frame");
            record.text += data.text;
          }
        },
      });
      const close = async () => {
        controller.abort();
        await channel.close?.({ code: 1000, reason: "Smoke disconnect", signal: new AbortController().signal });
        channelClosures.delete(close);
      };
      channelClosures.add(close);
      return { frames, pushed, close, send: (data) => channel.receive(data, controller.signal) };
    };
    const records = [];
    const seedReply = async (session, question, answer) => {
      const index = turns.length;
      const pending = session.prompt(question);
      // Attach immediately so a fixture failure cannot become an unhandled rejection.
      pending.catch(() => {});
      await eventually(() => assert.equal(turns.length, index + 1), "fixture model turn starts");
      assert.equal(turns[index].sessionId, session.sessionId);
      turns[index].finish(answer);
      await withDeadline(pending, "fixture reply settles");
    };
    const sourceSnapshot = () => structuredClone({
      entries: source.sessionManager.getEntries(),
      messages: source.messages,
      name: source.sessionManager.getSessionName(),
    });
    const sourceTurns = () => turns.filter((turn) => turn.sessionId === source.sessionId).length;
    const admit = async (sourceSessionId = source.sessionId) => {
      const log = await openLog();
      const requestId = randomUUID();
      await withDeadline(log.send({ type: "translate", requestId, sourceSessionId }), "translation admission before model completion");
      const admission = log.frames.find((frame) => frame.type === "admitted" && frame.requestId === requestId);
      assert.ok(admission, JSON.stringify(log.frames));
      return { log, id: admission.id };
    };
    const saved = async ({ log, id }, status) => {
      await eventually(() => {
        assert.equal(log.pushed.get(id)?.status, status, JSON.stringify(log.pushed.get(id)));
        assert.ok(log.frames.some((frame) => frame.type === "entry" && frame.entry.id === id && frame.entry.status === status && frame.saved));
      }, `pushed, durable ${status} result`);
      const record = await read(id);
      assert.equal(record.text, log.pushed.get(id).text);
      records.push(record);
      await log.close();
      return record;
    };
    const reloadBackend = async () => {
      await activation.dispose();
      activation = await startBackend();
    };
    const translate = async ({ text, answer, fresh, expectedId, previousAnswer, reconnect = false }) => {
      const snapshot = sourceSnapshot();
      const count = sourceTurns();
      let index = turns.length;
      const operation = await admit();
      await eventually(() => assert.equal(turns.length, index + 1), "pirate model turn starts");
      const pirateId = turns[index].sessionId;
      assert.notEqual(pirateId, source.sessionId);
      if (expectedId) assert.equal(pirateId, expectedId);
      if (fresh) {
        const introduction = messageText(turns[index].messages.at(-1));
        assert.equal(introduction, PIRATE_INTRO);
        assert.match(introduction, /pirate/i);
        assert.ok(introduction.length < 100, "Introduction must be very short");
        assert.ok(!introduction.includes(text), "Introduction precedes translation as a separate turn");
        turns[index].finish("Arrr, ready!");
        index++;
        await eventually(() => assert.equal(turns.length, index + 1), "translation follows introduction");
      }
      const turn = turns[index];
      assert.equal(turn.sessionId, pirateId);
      assert.equal(messageText(turn.messages.at(-1)), captainPrompt(text), "Latest source final text must reach pirate intact");
      assert.equal(turn.messages.filter((message) => message.role === "user" && messageText(message) === PIRATE_INTRO).length, 1, "Introduce each pirate conversation exactly once");
      if (previousAnswer) assert.ok(turn.messages.some((message) => message.role === "assistant" && messageText(message) === previousAnswer), "Reused pirate retains prior translation context");
      assert.equal(operation.log.pushed.get(operation.id)?.status, "running");
      if (reconnect) {
        await operation.log.close();
        assert.equal(sessions.get(pirateId).isStreaming, true, "Browser disconnect must not cancel pirate");
        operation.log = await openLog();
        assert.equal((await read(operation.id)).status, "running");
        assert.equal(turns.length, index + 1, "Reconnect must not resend translation");
      }
      turn.finish(answer);
      const record = await saved(operation, "completed");
      assert.equal(record.text, answer);
      assert.equal(record.sourceSessionId, source.sessionId);
      assert.equal(record.sessionId, pirateId);
      await eventually(() => assert.equal(sessions.get(pirateId).isStreaming, false), "pirate settles");
      assert.equal(turns.length, index + 1, "No extra introduction or source model turn");
      assert.equal(sourceTurns(), count, "Reading source must never start a model turn");
      assert.deepEqual(sourceSnapshot(), snapshot, "Source transcript and name must remain untouched");
      return pirateId;
    };

    await seedReply(source, "An older finding", "Old reply: do not translate this one.");
    const firstText = "Latest finding: smoke-context-marker-742, check src/example.ts:4.\nKeep Unicode intact: ⚓.";
    await seedReply(source, "Inspect changes", firstText);
    const firstAnswer = "Arrr, inspect src/example.ts:4, matey!";
    const pirateId = await translate({ text: firstText, answer: firstAnswer, fresh: true, reconnect: true });
    assert.equal(createCount, 1);
    await reloadBackend();
    const secondText = "The previous risk means callers may receive stale results.";
    await seedReply(source, "Explain the risk", secondText);
    const secondAnswer = "Arrr, stale results off the starboard bow!";
    await translate({ text: secondText, answer: secondAnswer, expectedId: pirateId, previousAnswer: firstAnswer });
    assert.equal(createCount, 1, "Second translation reuses the dedicated pirate");

    // Model a human reopening the previous conversation: a new native runtime
    // loads its existing Pi transcript, then the host admits that same ID.
    const previous = sessions.get(pirateId);
    connections.close(previous);
    previous.dispose();
    const reopened = await createRealSession(previous.sessionManager);
    assert.equal(reopened.sessionId, pirateId);
    await reloadBackend();
    await translate({ text: secondText, answer: "Arrr, still aboard!", expectedId: pirateId, previousAnswer: secondAnswer });
    assert.equal(createCount, 1, "Human-opened previous pirate remains reusable");

    const beforeFailure = turns.length;
    const beforeFailureSource = sourceSnapshot();
    connectFailures.set(pirateId, "Host transport disconnected unexpectedly");
    const failed = await saved(await admit(), "failed");
    assert.match(failed.text, /Host transport disconnected unexpectedly/);
    assert.equal(failed.sessionId, pirateId);
    assert.equal(createCount, 1, "Arbitrary connection errors must not create replacement sessions");
    assert.equal(turns.length, beforeFailure, "Ambiguous failures must not send or retry a model prompt");
    assert.deepEqual(sourceSnapshot(), beforeFailureSource);
    await reloadBackend();

    connectFailures.set(pirateId, "Selected session is not hosted in this workspace on this machine");
    const replacementId = await translate({ text: secondText, answer: "Arrr, a fresh ship!", fresh: true });
    assert.notEqual(replacementId, pirateId);
    assert.equal(createCount, 2, "Exact unhosted rejection automatically creates a pirate with no confirmation frame");
    await reloadBackend();
    await translate({ text: secondText, answer: "Arrr, same fresh ship!", expectedId: replacementId, previousAnswer: "Arrr, a fresh ship!" });
    assert.equal(createCount, 2);

    // Native read-only error paths: real companions, no simulated ExtensionAPI.
    const empty = await createRealSession();
    const emptyEntries = structuredClone(empty.sessionManager.getEntries());
    const beforeInvalid = turns.length;
    const noFinal = await saved(await admit(empty.sessionId), "failed");
    assert.match(noFinal.text, /no completed assistant text reply/i);
    assert.equal(turns.length, beforeInvalid);
    assert.deepEqual(empty.sessionManager.getEntries(), emptyEntries);
    const self = await openLog();
    const selfRequest = randomUUID();
    await self.send({ type: "translate", requestId: selfRequest, sourceSessionId: replacementId });
    assert.ok(self.frames.some((frame) => frame.type === "rejected" && frame.requestId === selfRequest && /other than the pirate/i.test(frame.message)));
    await self.close();
    assert.equal(turns.length, beforeInvalid);
    assert.equal(createCount, 2);

    const busyPrompt = source.prompt("A human is still waiting for this answer");
    busyPrompt.catch(() => {});
    await eventually(() => assert.equal(turns.length, beforeInvalid + 1), "human source prompt starts");
    const busySnapshot = sourceSnapshot();
    const busy = await saved(await admit(), "failed");
    assert.match(busy.text, /idle|pending|finish/i);
    assert.equal(turns.length, beforeInvalid + 1, "Busy source must not trigger another model turn");
    assert.deepEqual(sourceSnapshot(), busySnapshot, "Rejected source read must not mutate the in-flight transcript");
    assert.equal(createCount, 2);
    turns.at(-1).finish("Human's source answer, not a translation.");
    await withDeadline(busyPrompt, "human source prompt settles");

    await reloadBackend();
    const archive = await request("list");
    assert.equal(archive.length, records.length, "Recovery preserves completed and failed translations");
    for (const record of records) {
      assert.deepEqual(await read(record.id), record, "Archive survives backend reload");
      assert.deepEqual(archive.find((item) => item.id === record.id), { ...record, text: "" });
    }
    assert.ok(selectedSessions.includes(source.sessionId));
    assert.deepEqual(errors, []);
    console.log("Installed Captain's Log translator passed: source unchanged/no source turns, latest final text, first-only short introduction, context reuse, human reopen, automatic exact-unhosted replacement, arbitrary failure without replacement, busy/no-final/self-source errors, reconnect and durable archive.");
  } finally {
    lifetime.abort();
    for (const close of channelClosures) await close();
    for (const turn of turns) turn.finish("Smoke cleanup", "aborted");
    for (const session of sessions.values()) connections.close(session);
    await activation?.dispose();
    for (const session of sessions.values()) {
      await session.abort();
      session.dispose();
    }
  }
}

function messageText(message) {
  return typeof message.content === "string" ? message.content
    : message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

async function withDeadline(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Captain's Log smoke timed out: ${label}`)), 10_000);
    })]);
  } finally { clearTimeout(timer); }
}

async function eventually(check, label) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try { await check(); return; }
    catch (error) {
      if (Date.now() >= deadline) throw new Error(`Captain's Log smoke timed out: ${label}`, { cause: error });
      await delay(10);
    }
  }
}
