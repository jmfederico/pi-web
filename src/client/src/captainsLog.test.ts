// @vitest-environment happy-dom
import { html, render, svg } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import plugin from "../../../pi-packages/captains-log/src/browser/index.js";
import type { LogEntry } from "../../../pi-packages/captains-log/src/browser/protocol.js";
import { entryFrames, isCaptainClientFrame } from "../../../pi-packages/captains-log/src/browser/channelProtocol.js";
import type { JsonValue, PluginPeerChannelClose, PluginPeerChannelOptions, WorkspacePanelContext } from "../../plugin-api.js";
import { parsePluginBackendChannelServerEnvelope } from "../../shared/pluginBackendProtocol.js";

afterEach(() => { document.body.replaceChildren(); localStorage.clear(); vi.useRealTimers(); });
const source = { id: "source-session-a", name: "Fix the login flow", cwd: "/workspace", archived: false, pending: false };
const entry: LogEntry = { id: "11111111-1111-4111-8111-111111111111", createdAt: "2026-09-01", status: "running", text: "", sessionId: "captain-session", question: "Translate the last reply", stages: ["Backend admitted channel translation"], sourceSessionId: source.id };
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
async function setup(requestHandler: (operation: string) => Promise<JsonValue> = (operation) => Promise.resolve(operation === "list" ? [] : { ...entry })) {
  const container = document.createElement("div"); document.body.append(container);
  const lifetime = new AbortController();
  const activation = await plugin.activate({ apiVersion: 4, pluginId: "captains-log", runtimePluginId: "captains-log", html, svg, signal: new AbortController().signal, lifetimeSignal: lifetime.signal });
  const panel = required(activation.contributions.workspacePanels?.[0]);
  const channels: { options: PluginPeerChannelOptions; send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; finish: (close: PluginPeerChannelClose) => void }[] = [];
  const request = vi.fn(requestHandler);
  const openChannel = vi.fn((_operation: string, _input: unknown, options: PluginPeerChannelOptions) => {
    let finish!: (close: PluginPeerChannelClose) => void;
    const closed = new Promise<PluginPeerChannelClose>((resolve) => { finish = resolve; });
    // Match the host transport's immutable values, including nested records.
    const wireOptions: PluginPeerChannelOptions = { ...options, onData(data) {
      const envelope = parsePluginBackendChannelServerEnvelope(JSON.stringify({ version: 1, kind: "data", data }));
      if (envelope.kind !== "data") throw new Error("Expected data frame");
      options.onData(envelope.data);
    } };
    const channel = { options: wireOptions, send: vi.fn(), close: vi.fn(), finish };
    channels.push(channel);
    return Promise.resolve({ ...channel, closed });
  });
  const unused = () => { throw new Error("Unrelated host API called"); };
  const navigate = vi.fn<WorkspacePanelContext["navigate"]>(() => Promise.resolve());
  let context: WorkspacePanelContext = {
    navigate,
    machine: { id: "remote-a", name: "A", kind: "remote" },
    workspace: { id: "workspace", projectId: "project", path: "/workspace", label: "Workspace", isMain: true }, state: { selectedSession: source },
    files: { readFile: unused, listFiles: unused, writeFile: unused, deleteFile: unused, moveFile: unused },
    prompt: { insertText: unused, getText: unused, getSelection: unused }, terminal: { open: unused, runCommand: unused }, peer: { request, openChannel },
    host: { requestRender: () => { render(panel.render(context), container); } },
  };
  context.host.requestRender(); await flush();
  return { container, lifetime, activation, channels, request, openChannel, navigate,
    selectSession(selectedSession: NonNullable<WorkspacePanelContext["state"]>["selectedSession"]) { context = { ...context, state: selectedSession === undefined ? {} : { selectedSession } }; context.host.requestRender(); },
    selectMachine(id: string) { context = { ...context, state: { ...context.state, selectedMachine: { id, name: id, kind: "remote" } } }; context.host.requestRender(); },
    switchScope() { context = { ...context, machine: { id: "remote-b", name: "B", kind: "remote" } }; context.host.requestRender(); },
    async dispose() { lifetime.abort(); await activation.dispose?.(new AbortController().signal); } };
}
function button(label = "Let the Captain tell it") {
  const match = [...document.querySelectorAll("button")].find((element) => element.textContent === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}
it("translates the session selected at click time, renders frozen reply chunks, and never polls", async () => {
  vi.useFakeTimers();
  const app = await setup();
  try {
    const channel = required(app.channels[0]);
    expect(document.querySelector(".captain-source")?.textContent).toContain(source.name);
    expect(document.querySelector("textarea")).toBeNull();
    expect(document.body.textContent).not.toContain("Speak plainly!");
    expect(document.body.textContent).not.toContain("New voyage");
    button().click();
    const sent: unknown = channel.send.mock.calls[0]?.[0];
    if (!isCaptainClientFrame(sent)) throw new Error("Invalid translation frame");
    expect(sent).toMatchObject({ type: "translate", sourceSessionId: source.id });
    channel.options.onData({ type: "admitted", requestId: sent.requestId, id: entry.id });
    for (const frame of entryFrames(entry, true)) channel.options.onData(frame);
    expect(button().disabled).toBe(true);
    app.selectSession({ ...source, id: "source-session-b", name: "Second conversation" });
    expect(app.openChannel).toHaveBeenCalledTimes(1);
    const completed = { ...entry, status: "completed" as const, text: "Arrr, <script>not executable</script>" + " More booty.".repeat(500) };
    for (const frame of entryFrames(completed, true)) channel.options.onData(frame);
    expect(document.querySelector(".captain-answer")?.textContent).toBe(completed.text);
    expect(document.querySelector("script")).toBeNull();
    expect(button().disabled).toBe(false);
    button("Open source session").click();
    expect(app.navigate).toHaveBeenCalledExactlyOnceWith({ machineId: "remote-a", projectId: "project", workspaceId: "workspace", sessionId: source.id, view: "chat" });
    expect(required(document.querySelector(".captain-diagnostics")).hasAttribute("open")).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(app.request.mock.calls.map((call) => call[0])).toEqual(["list"]);
    button().click();
    expect(channel.send.mock.calls[1]?.[0]).toMatchObject({ type: "translate", sourceSessionId: "source-session-b" });
  } finally { await app.dispose(); }
});
it("disables translation without a usable source or when the pirate itself is selected", async () => {
  const app = await setup();
  try {
    for (const selected of [undefined, { ...source, archived: true }, { ...source, pending: true }, { ...source, cwd: "/other" }]) {
      app.selectSession(selected); expect(button().disabled).toBe(true);
    }
    app.selectSession({ ...source, name: " " });
    expect(document.querySelector(".captain-source")?.textContent).toContain(`Session ${source.id.slice(0, 8)}`);
    app.selectMachine("remote-b"); expect(button().disabled).toBe(true);
    app.selectMachine("remote-a"); expect(button().disabled).toBe(false);
    app.selectSession(source); expect(button().disabled).toBe(false);
    for (const frame of entryFrames({ ...entry, status: "completed", text: "Arrr" }, true)) required(app.channels[0]).options.onData(frame);
    app.selectSession({ ...source, id: entry.sessionId });
    expect(button().disabled).toBe(true);
    expect(document.querySelector('[role="status"]')?.textContent).toContain("this one is the pirate");
    expect(required(app.channels[0]).send).not.toHaveBeenCalled();
  } finally { await app.dispose(); }
});
it("reconnects without resending uncertain translations and cleans up scopes and lifetimes", async () => {
  const app = await setup();
  try {
    const first = required(app.channels[0]); button().click();
    first.finish({ code: 1006, reason: "lost", wasClean: false }); await flush();
    expect(document.body.textContent).toContain("will not be sent again");
    button("Reconnect").click(); await flush();
    expect(app.openChannel).toHaveBeenCalledTimes(2);
    expect(required(app.channels[1]).send).not.toHaveBeenCalled();
    for (const frame of entryFrames(entry, true)) first.options.onData(frame);
    expect(document.body.textContent).not.toContain(entry.id);
    app.switchScope(); await flush();
    expect(required(app.channels[1]).options.signal?.aborted).toBe(true);
    expect(required(app.channels[1]).close).toHaveBeenCalledTimes(1);
    render(html``, app.container);
    expect(required(app.channels[2]).options.signal?.aborted).toBe(true);
    app.lifetime.abort(); expect(first.send).toHaveBeenCalledTimes(1);
  } finally { await app.dispose(); }
});
it("merges an initial snapshot behind pushed results and restores translations on reconnect", async () => {
  const snapshot = deferred<JsonValue>(); const app = await setup(() => snapshot.promise);
  try {
    const channel = required(app.channels[0]); const final = { ...entry, status: "completed" as const, text: "Arrr, pushed completion wins" };
    for (const frame of entryFrames(final, true)) channel.options.onData(frame);
    snapshot.resolve([{ ...entry, text: "" }]); await flush();
    expect(document.querySelector(".captain-answer")?.textContent).toBe(final.text);
    expect(app.request).toHaveBeenCalledTimes(1);
    channel.finish({ code: 1006, reason: "lost", wasClean: false }); await flush();
    app.request.mockImplementation((operation) => Promise.resolve(operation === "list" ? [{ ...final, text: "" }] : { ...final, text: "Restored translation" }));
    button("Reconnect").click(); await flush();
    expect(document.querySelector(".captain-answer")?.textContent).toBe("Restored translation");
    expect(app.request.mock.calls.map((call) => call[0])).toEqual(["list", "list", "read"]);
    expect(required(app.channels[1]).send).not.toHaveBeenCalled();
  } finally { await app.dispose(); }
});
it("ignores saved reads completing after a scope switch and exposes source errors without recovery confirmations", async () => {
  const read = deferred<JsonValue>(); const app = await setup((operation) => operation === "list" ? Promise.resolve([{ ...entry, text: "" }]) : read.promise);
  try {
    app.request.mockImplementation(() => Promise.resolve([])); app.switchScope(); await flush();
    read.resolve({ ...entry, text: "Stale source text" }); await flush();
    expect(document.body.textContent).not.toContain("Stale source text");
    const failed = { ...entry, status: "failed" as const, text: "Wait for the source session to finish, then try again." };
    for (const frame of entryFrames(failed, true)) required(app.channels[1]).options.onData(frame);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(failed.text);
    expect(button().disabled).toBe(false);
    expect(document.body.textContent).not.toContain("Start voyage");
    app.lifetime.abort(); const before = document.body.textContent;
    for (const frame of entryFrames({ ...entry, text: "Late push" }, false)) required(app.channels[1]).options.onData(frame);
    expect(document.body.textContent).toBe(before);
  } finally { await app.dispose(); }
});
it("renders completed replies as Markdown without executable HTML or remote images", async () => {
  const app = await setup();
  try {
    const text = '# Ahoy, crew!\n\n**All aboard** with *care*.\n\n- Check the sails\n- Keep `npm test` exact\n\n```sh\nprintf "<captain>"\n```\n\n[Safe chart](https://example.com/chart)\n\n[Unsafe chart](javascript:alert(1))\n\n<img src="https://example.com/beacon" onerror="alert(1)">\n\n![Beacon](https://example.com/beacon.png)';
    for (const frame of entryFrames({ ...entry, status: "completed", text }, true)) required(app.channels[0]).options.onData(frame);
    const answer = required(document.querySelector(".captain-answer"));
    expect(answer.querySelector("h1,h2,h3,h4,h5,h6")?.textContent).toBe("Ahoy, crew!");
    expect(answer.querySelector("strong")?.textContent).toBe("All aboard");
    expect(answer.querySelector("em")?.textContent).toBe("care");
    expect(answer.querySelectorAll("li")).toHaveLength(2);
    expect(answer.querySelector("pre code")?.textContent.trimEnd()).toBe('printf "<captain>"');
    expect(answer.querySelector('a[href="https://example.com/chart"]')).not.toBeNull();
    expect(answer.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(answer.querySelector("img,script,iframe,[onerror]")).toBeNull();
  } finally { await app.dispose(); }
});
it("keeps legacy review records out of the translator view without changing saved data", async () => {
  const legacy = { ...entry, status: "completed" as const, text: "Old workspace review" };
  delete legacy.sourceSessionId;
  const app = await setup(() => Promise.resolve([legacy]));
  try {
    expect(document.querySelector(".captain-answer")).toBeNull();
    expect(document.body.textContent).not.toContain("Old workspace review");
    expect(button().disabled).toBe(false);
    expect(app.request.mock.calls.map((call) => call[0])).toEqual(["list"]);
  } finally { await app.dispose(); }
});
function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error("Deferred not initialized"); };
  const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve };
}
function required<T>(value: T | undefined | null): T { if (value === undefined || value === null) throw new Error("Missing test fixture"); return value; }
