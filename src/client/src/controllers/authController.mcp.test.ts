import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, type OAuthFlowState, type SessionInfo } from "../api";
import { initialAppState, type AppState } from "../appState";
import { AuthController } from "./authController";

const session: SessionInfo = { id: "session-a", cwd: "/repo", path: "/repo/a.jsonl", created: "now", modified: "now", firstMessage: "", messageCount: 0 };
const machine = { id: "remote-a", name: "Remote", kind: "remote" as const, createdAt: "now", updatedAt: "now" };
const controllers: AuthController[] = [];
let poll: (() => void) | undefined;

beforeEach(() => {
  poll = undefined;
  vi.stubGlobal("window", { setInterval: (callback: () => void) => { poll = callback; return 1; }, clearInterval: () => undefined });
});
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
  vi.unstubAllGlobals();
});

function flow(patch: Partial<OAuthFlowState> = {}): OAuthFlowState {
  return { flowId: "mcp-flow", target: "mcp", providerId: "mcp", providerName: "MCP server", status: "running", progress: [], ...patch };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}
function fixture(overrides: Partial<typeof api>, patch: Partial<AppState> = {}) {
  let state = { ...initialAppState(), selectedMachine: machine, selectedSession: session, ...patch };
  const controller = new AuthController(() => state, (update) => { state = { ...state, ...update }; }, () => undefined, {
    api: { ...api, status: () => Promise.resolve({ sessionId: session.id, isStreaming: false, isCompacting: false, isBashRunning: false, pendingMessageCount: 0, queuedMessages: [], tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }), ...overrides },
  });
  controllers.push(controller);
  return { controller, state: () => state, setState: (update: Partial<AppState>) => { state = { ...state, ...update }; } };
}
async function tick() { poll?.(); await Promise.resolve(); await Promise.resolve(); }

describe("unified MCP auth controller", () => {
  it("uses the captured machine/session and shared modal through selection, input and command completion", async () => {
    const pending = deferred<OAuthFlowState>();
    const start = vi.fn(() => pending.promise);
    const respond = vi.fn<typeof api.respondMcpAuthFlow>()
      .mockResolvedValueOnce(flow({ auth: { url: "https://auth.example/authorize" }, prompt: { requestId: "redirect", message: "Paste redirect URL", promptType: "manual_code" } }))
      .mockResolvedValueOnce(flow({ status: "complete", progress: ["Signed in to MCP server."] }));
    const { controller, state, setState } = fixture({ startMcpAuth: start, respondMcpAuthFlow: respond });
    const starting = controller.openMcpAuth("login");
    expect(state().authDialog).toMatchObject({ step: "starting", machineId: machine.id });
    expect(start).toHaveBeenCalledWith(session, "login", machine.id);
    setState({ selectedMachine: undefined, selectedSession: { ...session, id: "session-b" } });
    pending.resolve(flow({ select: { requestId: "server", message: "MCP server", options: [{ value: "alpha", label: "alpha" }] } }));
    await starting;
    await controller.respondOAuth("alpha");
    expect(respond).toHaveBeenLastCalledWith("mcp-flow", "server", "alpha", machine.id);
    controller.updateOAuthInput("http://127.0.0.1/callback?code=abc&state=xyz");
    await controller.respondOAuth();
    expect(respond).toHaveBeenLastCalledWith("mcp-flow", "redirect", "http://127.0.0.1/callback?code=abc&state=xyz", machine.id);
    expect(state().authDialog).toMatchObject({ step: "oauth", flow: { target: "mcp", status: "complete", progress: ["Signed in to MCP server."] } });
    await controller.cancelOAuth();
    expect(state().authDialog).toBeUndefined();
  });

  it("polls the MCP endpoint and removes a callback prompt without cancelling the operation", async () => {
    const prompt = { requestId: "redirect", message: "Paste URL", promptType: "manual_code" as const };
    const read = vi.fn<typeof api.mcpAuthFlow>()
      .mockResolvedValueOnce(flow({ prompt }))
      .mockResolvedValueOnce(flow())
      .mockResolvedValueOnce(flow({ status: "complete", progress: ["Pi finished"] }));
    const { controller, state } = fixture({ startMcpAuth: () => Promise.resolve(flow({ prompt })), mcpAuthFlow: read });
    await controller.openMcpAuth("login");
    controller.updateOAuthInput("half-typed URL");
    await tick();
    expect(state().authDialog).toMatchObject({ inputValue: "half-typed URL" });
    await tick();
    expect(state().authDialog).toMatchObject({ step: "oauth", flow: { status: "running" }, inputValue: "" });
    const dialog = state().authDialog;
    expect(dialog?.step === "oauth" ? dialog.flow.prompt : undefined).toBeUndefined();
    await tick();
    expect(read).toHaveBeenLastCalledWith("mcp-flow", machine.id);
    expect(state().authDialog).toMatchObject({ flow: { status: "complete" } });
  });

  it("keeps cancellation visible, ignores pre-cancel polls, and waits for Pi to finish", async () => {
    const oldRead = deferred<OAuthFlowState>();
    const read = vi.fn<typeof api.mcpAuthFlow>()
      .mockReturnValueOnce(oldRead.promise)
      .mockResolvedValueOnce(flow({ status: "complete", cancelRequested: true, progress: ["Pi finished"] }));
    const cancel = vi.fn(() => Promise.resolve(flow({ cancelRequested: true })));
    const { controller, state } = fixture({ startMcpAuth: () => Promise.resolve(flow()), mcpAuthFlow: read, cancelMcpAuthFlow: cancel });
    await controller.openMcpAuth("login");
    await tick();
    await controller.cancelOAuth();
    expect(cancel).toHaveBeenCalledWith("mcp-flow", machine.id);
    expect(state().authDialog).toMatchObject({ flow: { status: "running", cancelRequested: true } });
    oldRead.resolve(flow());
    await Promise.resolve(); await Promise.resolve();
    expect(state().authDialog).toMatchObject({ flow: { cancelRequested: true } });
    await tick();
    expect(state().authDialog).toMatchObject({ flow: { status: "complete", cancelRequested: true } });
  });

  it("cancels an allocated MCP flow after the start dialog was closed", async () => {
    const pending = deferred<OAuthFlowState>();
    const cancel = vi.fn(() => Promise.resolve(flow({ cancelRequested: true })));
    const { controller, state } = fixture({ startMcpAuth: () => pending.promise, cancelMcpAuthFlow: cancel });
    const starting = controller.openMcpAuth("login");
    controller.closeDialog();
    pending.resolve(flow());
    await starting;
    expect(cancel).toHaveBeenCalledWith("mcp-flow", machine.id);
    expect(state().authDialog).toBeUndefined();
  });

  it("shows a failed start in the same modal", async () => {
    const { controller, state } = fixture({ startMcpAuth: () => Promise.reject(new Error("Restart the session daemon")) });
    await controller.openMcpAuth("login");
    expect(state().authDialog).toMatchObject({ step: "starting", error: "Error: Restart the session daemon" });
  });

  it("allows retrying cancellation after a transport failure", async () => {
    const cancel = vi.fn<typeof api.cancelMcpAuthFlow>().mockRejectedValueOnce(new Error("Offline")).mockResolvedValueOnce(flow({ cancelRequested: true }));
    const { controller, state } = fixture({ startMcpAuth: () => Promise.resolve(flow()), cancelMcpAuthFlow: cancel });
    await controller.openMcpAuth("login");
    await controller.cancelOAuth();
    expect(state().authDialog).toMatchObject({ flow: { cancelRequested: false }, error: "Error: Offline" });
    await controller.cancelOAuth();
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it("uses the explicit settings target without falling back to the newly selected session", async () => {
    const start = vi.fn(() => Promise.resolve(flow({ mcpMode: "logout", providerName: "Budgeter", status: "complete", progress: ["Signed out of Budgeter"] })));
    const origin = { session: { id: "original-session", cwd: "/original" }, machineId: "original-machine" };
    const { controller, state } = fixture({ startMcpAuth: start }, { selectedSession: { ...session, id: "other-session" } });
    await controller.openMcpAuth("logout", "Budgeter", origin);
    expect(start).toHaveBeenCalledWith(origin.session, "logout", origin.machineId, "Budgeter");
    expect(state().authDialog).toMatchObject({ machineId: origin.machineId, flow: { providerName: "Budgeter", mcpMode: "logout" } });
  });

  it("starts sign-out through the same scoped API", async () => {
    const start = vi.fn(() => Promise.resolve(flow({ status: "complete", progress: ["Signed out"] })));
    const { controller, state } = fixture({ startMcpAuth: start });
    await controller.openMcpAuth("logout");
    expect(start).toHaveBeenCalledWith(session, "logout", machine.id);
    expect(state().authDialog).toMatchObject({ step: "oauth", flow: { status: "complete", progress: ["Signed out"] } });
  });

  it.each([undefined, { ...session, archived: true }])("requires a selected nonarchived session", async (selectedSession) => {
    const start = vi.fn();
    const { controller } = fixture({ startMcpAuth: start }, { selectedSession });
    await controller.openMcpAuth("login");
    expect(start).not.toHaveBeenCalled();
  });
});
