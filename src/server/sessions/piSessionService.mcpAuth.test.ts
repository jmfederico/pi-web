import { afterEach, describe, expect, it, vi } from "vitest";
import { PiSessionService } from "./piSessionService.js";
import { CapturingSessionEventHub, emptyArchiveStore, fakeRuntime, runtimeCreator, sessionGateway, sessionRecord, sessionRef, testModelRuntime } from "./piSessionService.testSupport.js";
import { McpAuthFlowService } from "./mcpAuthFlowService.js";

const services: PiSessionService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map((service) => service.dispose())); });

async function fixture() {
  const fake = fakeRuntime("session-1");
  fake.session.settingsManager.isProjectTrusted = () => true;
  fake.session.extensionRunner.getRegisteredCommands = () => [{ invocationName: "mcp", sourceInfo: { path: "builtin:mcp" }, getArgumentCompletions: () => [{ value: "login alpha", label: "alpha", description: "Connected (unchanged)" }, { value: "login beta", label: "beta" }] }];
  const events = new CapturingSessionEventHub();
  let archived = false;
  const service = new PiSessionService(events, {
    agentDir: "/tmp/pi-web-test-agent", modelRuntime: testModelRuntime,
    sessionManager: sessionGateway([sessionRecord("session-1")]), archiveStore: {
      ...emptyArchiveStore(),
      get: () => Promise.resolve(archived ? { sessionId: "session-1", cwd: "/workspace", archivedAt: "2026-01-01T00:00:00.000Z" } : undefined),
    },
    createAgentRuntime: runtimeCreator(fake.runtime), heartbeatIntervalMs: 60_000,
  });
  services.push(service);
  await service.status(sessionRef("session-1"));
  const binding = required(fake.calls.bindExtensions.at(-1));
  return { fake, events, service, ui: required(binding.uiContext), binding, archive: () => { archived = true; } };
}

describe("PiSessionService MCP auth bridge", () => {
  it("awaits the actual prompt promise and scopes UI without replacing the ordinary bridge", async () => {
    const { fake, service, ui, events } = await fixture();
    let finish!: () => void;
    let background: (() => void) | undefined;
    fake.session.prompt = async (text) => {
      if (text === "/mcp") return;
      expect(text).toBe("/mcp login alpha");
      required(McpAuthFlowService.current()).openUrl("https://example.test/authorize");
      expect(await ui.input("Redirect")).toBe("redirect");
      await new Promise<void>((resolve) => { finish = resolve; });
      ui.notify("Pi final notice", "error");
      // A timer born in the command scope retains ALS ancestry after finish.
      void new Promise<void>((resolve) => { background = resolve; }).then(() => { ui.notify("background after finish", "info"); });
    };
    const flow = await service.startMcpAuth(sessionRef("session-1"), "login");
    expect(flow.select?.message).toBe("Choose an MCP server");
    expect(flow.select?.options[0]?.description).toBe("Connected (unchanged)");
    expect(events.sessionEvents.some(({ event }) => event.type === "dialog.opened")).toBe(false);
    expect(events.sessionEvents.some(({ event }) => event.type === "message.append")).toBe(false);
    expect(events.sessionEvents.some(({ event }) => event.type === "activity.update" && event.activity.label === "prompt accepted")).toBe(false);
    // Concurrent UI calls outside this operation still use chat.
    const ordinary = ui.select("Ordinary chat dialog", ["a"]);
    const opened = events.sessionEvents.find(({ event }) => event.type === "dialog.opened");
    expect(opened?.event.type).toBe("dialog.opened");
    service.mcpAuthFlows.respond(flow.flowId, required(flow.select).requestId, "alpha");
    await vi.waitFor(() => { expect(service.mcpAuthFlows.get(flow.flowId).prompt).toBeDefined(); });
    service.mcpAuthFlows.respond(flow.flowId, required(service.mcpAuthFlows.get(flow.flowId).prompt).requestId, "redirect");
    await vi.waitFor(() => { expect(finish).toBeDefined(); });
    expect(service.mcpAuthFlows.get(flow.flowId).status).toBe("running");
    await expect(service.startMcpAuth(sessionRef("session-1"), "logout")).rejects.toThrow();
    finish();
    await vi.waitFor(() => { expect(service.mcpAuthFlows.get(flow.flowId).status).toBe("complete"); });
    expect(service.mcpAuthFlows.get(flow.flowId).progress).toEqual(["Pi final notice"]);
    required(background)();
    await vi.waitFor(() => { expect(service.notificationInbox(sessionRef("session-1")).notifications.some((item) => item.message === "background after finish")).toBe(true); });
    expect(service.mcpAuthFlows.get(flow.flowId).progress).toEqual(["Pi final notice"]);
    await service.dispose();
    await ordinary;
  });

  it("captures the SDK's swallowed command error emission as flow error", async () => {
    const { fake, service, binding } = await fixture();
    fake.session.prompt = (text) => { if (text === "/mcp") return Promise.resolve(); binding.onError?.({ extensionPath: "builtin:mcp", event: "command", error: "broken" }); return Promise.resolve(); };
    const flow = await service.startMcpAuth(sessionRef("session-1"), "logout", "alpha");
    await vi.waitFor(() => { expect(service.mcpAuthFlows.get(flow.flowId)).toMatchObject({ status: "error", error: "builtin:mcp: broken" }); });
  });

  it("rejects a read-only original session ref before running a command", async () => {
    const { fake, service, archive } = await fixture();
    archive();
    await expect(service.startMcpAuth(sessionRef("session-1"), "login")).rejects.toThrow("read-only");
    await expect(service.mcpAuthServers(sessionRef("session-1"))).rejects.toThrow("read-only");
    expect(fake.calls.prompt).toEqual([]);
  });

  it("fails closed for untrusted workspaces and replacement commands", async () => {
    const { fake, service } = await fixture();
    fake.session.settingsManager.isProjectTrusted = () => false;
    await expect(service.startMcpAuth(sessionRef("session-1"), "login")).rejects.toThrow("trusted");
    await expect(service.mcpAuthServers(sessionRef("session-1"))).rejects.toThrow("trusted");
    fake.session.settingsManager.isProjectTrusted = () => true;
    fake.session.extensionRunner.getRegisteredCommands = () => [{ invocationName: "mcp", sourceInfo: { path: "/tmp/third-party.ts" } }];
    await expect(service.startMcpAuth(sessionRef("session-1"), "login")).rejects.toThrow("built-in MCP");
    await expect(service.mcpAuthServers(sessionRef("session-1"))).rejects.toThrow("built-in MCP");
    expect(fake.calls.prompt).toEqual([]);
  });
  it("always asks for a single server and targets exactly that name", async () => {
    const { fake, service } = await fixture();
    fake.session.extensionRunner.getRegisteredCommands = () => [{ invocationName: "mcp", sourceInfo: { path: "builtin:mcp" }, getArgumentCompletions: () => [{ value: "login only", label: "only" }] }];
    const flow = await service.startMcpAuth(sessionRef("session-1"), "login");
    expect(flow.select?.options).toEqual([{ value: "only", label: "only" }]);
    expect(fake.calls.prompt.map((call) => call.text)).toEqual(["/mcp"]);
    service.mcpAuthFlows.respond(flow.flowId, required(flow.select).requestId, "only");
    await vi.waitFor(() => { expect(service.mcpAuthFlows.get(flow.flowId).status).toBe("complete"); });
    expect(fake.calls.prompt.at(-1)?.text).toBe("/mcp login only");
    expect(service.mcpAuthFlows.get(flow.flowId)).toMatchObject({ providerName: "only", mcpMode: "login" });
  });

  it.each(["login", "logout"] as const)("explicit %s skips picker and retains Pi's final message without browser or revocation claims", async (mode) => {
    const { fake, service, ui } = await fixture();
    fake.session.prompt = (text) => {
      if (text !== "/mcp") {
        expect(text).toBe(`/mcp ${mode} beta`);
        ui.notify(mode === "login" ? "Already signed in." : "No stored credentials.", "info");
      }
      return Promise.resolve();
    };
    const flow = await service.startMcpAuth(sessionRef("session-1"), mode, "beta");
    await vi.waitFor(() => { expect(service.mcpAuthFlows.get(flow.flowId).status).toBe("complete"); });
    const final = service.mcpAuthFlows.get(flow.flowId);
    expect(final).toMatchObject({ providerName: "beta", mcpMode: mode, progress: [mode === "login" ? "Already signed in." : "No stored credentials."] });
    expect(final.auth).toBeUndefined();
    expect(final.select).toBeUndefined();
  });

  it.each(["missing", "alpha extra", "alpha\\n/mcp logout beta", ""])("rejects invalid target %j before auth command", async (name) => {
    const { fake, service } = await fixture();
    await expect(service.startMcpAuth(sessionRef("session-1"), "login", name)).rejects.toThrow("ineligible");
    expect(fake.calls.prompt.map((call) => call.text)).toEqual(["/mcp"]);
  });

  it("lists only bounded public completion metadata, suppressing status notices and URLs", async () => {
    const { fake, service, ui, events } = await fixture();
    const previous = events.sessionEvents.length;
    fake.session.prompt = (text) => {
      expect(text).toBe("/mcp");
      ui.notify("status with secret", "info");
      required(McpAuthFlowService.current()).openUrl("https://secret.test/token");
      return Promise.resolve();
    };
    expect(await service.mcpAuthServers(sessionRef("session-1"))).toEqual({ servers: [{ name: "alpha", description: "Connected (unchanged)" }, { name: "beta" }] });
    expect(events.sessionEvents.slice(previous).filter(({ event }) => ["message.append", "dialog.opened", "notification.added"].includes(event.type))).toEqual([]);
    expect(service.notificationInbox(sessionRef("session-1")).notifications).toEqual([]);
    expect(fake.calls.sendCustomMessage).toEqual([]);
  });

  it("blocks listing across sessions while machine auth is pending", async () => {
    const { service } = await fixture();
    const flow = await service.startMcpAuth(sessionRef("session-1"), "login");
    await expect(service.mcpAuthServers(sessionRef("session-1"))).rejects.toThrow();
    service.mcpAuthFlows.cancel(flow.flowId);
  });

  it("awaits startup before completions and prevents concurrent session mutation", async () => {
    const { fake, service } = await fixture();
    let ready = false;
    let release!: () => void;
    fake.session.prompt = (text) => {
      expect(text).toBe("/mcp");
      return new Promise<void>((resolve) => { release = () => { ready = true; resolve(); }; });
    };
    fake.session.extensionRunner.getRegisteredCommands = () => [{ invocationName: "mcp", sourceInfo: { path: "builtin:mcp" }, getArgumentCompletions: () => {
      expect(ready).toBe(true);
      return [{ value: "login alpha", label: "alpha" }];
    } }];
    const listing = service.mcpAuthServers(sessionRef("session-1"));
    await vi.waitFor(() => { expect(release).toBeDefined(); });
    await expect(service.prompt(sessionRef("session-1"), "do not run")).rejects.toThrow("MCP authentication operation");
    await expect(service.mcpAuthServers(sessionRef("session-1"))).rejects.toThrow();
    release();
    expect(await listing).toEqual({ servers: [{ name: "alpha" }] });
  });

  it("respects a machine lock held by another session", async () => {
    const { fake, service } = await fixture();
    const other = service.mcpAuthFlows.start({ sessionId: "other", identity: {}, isCurrent: () => true, run: async () => { await required(McpAuthFlowService.current()).input("Wait"); } });
    await expect(service.mcpAuthServers(sessionRef("session-1"))).rejects.toThrow("machine");
    expect(fake.calls.prompt).toEqual([]);
    service.mcpAuthFlows.cancel(other.flowId);
  });

  it("reports no eligible servers without an auth command or success assertion", async () => {
    const { fake, service } = await fixture();
    fake.session.extensionRunner.getRegisteredCommands = () => [{ invocationName: "mcp", sourceInfo: { path: "builtin:mcp" }, getArgumentCompletions: () => null }];
    const flow = await service.startMcpAuth(sessionRef("session-1"), "login");
    await vi.waitFor(() => { expect(service.mcpAuthFlows.get(flow.flowId).status).toBe("complete"); });
    expect(service.mcpAuthFlows.get(flow.flowId).progress).toEqual(["No eligible MCP servers are available for this action."]);
    expect(fake.calls.prompt.map((call) => call.text)).toEqual(["/mcp"]);
  });
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected value");
  return value;
}
