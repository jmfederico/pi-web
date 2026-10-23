import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { ExtensionUIDialogOptions } from "../../piSdk.js";
import type { McpAuthServerOption, OAuthFlowState } from "../../shared/apiTypes.js";

const execution = new AsyncLocalStorage<{ service: McpAuthFlowService; token: symbol; discovery?: boolean }>();
const MAX_TEXT = 32 * 1024;
const MAX_PROGRESS = 100;

interface Pending {
  id: string;
  values?: readonly string[];
  settle(value: string | undefined): void;
}
interface Flow {
  state: OAuthFlowState;
  identity: object;
  sessionId: string;
  token: symbol;
  isCurrent(): boolean;
  pending?: Pending;
  timer?: ReturnType<typeof setTimeout>;
  commandError?: string;
}

/** Operation transport only. Pi owns config, credentials, OAuth and reconnect. */
export class McpAuthFlowService {
  private readonly flows = new Map<string, Flow>();
  private readonly active = new Map<symbol, Flow>();
  private readonly sessions = new Map<string, Flow>();
  private disposed = false;

  constructor(private readonly options: { runningTtlMs?: number; terminalTtlMs?: number } = {}) {}

  start(options: { sessionId: string; identity: object; isCurrent(): boolean; mode?: "login" | "logout"; run(): Promise<void> }): OAuthFlowState {
    if (this.disposed) throw new Error("MCP authentication service is disposed");
    if (this.sessions.has(options.sessionId)) throw new Error("MCP authentication is already running for this session");
    // Pi persisted OAuth state is shared across sessions. Do not race two scoped logins against the same credentials.
    if (this.sessions.size > 0) throw new Error("Another MCP authentication operation is running on this machine. Finish it before starting another.");
    if (this.flows.size >= 100) throw new Error("Too many MCP authentication flows");
    const flow: Flow = {
      state: { flowId: randomUUID(), target: "mcp", providerId: "mcp", providerName: "MCP server", status: "running", progress: [], ...(options.mode === undefined ? {} : { mcpMode: options.mode }) },
      identity: options.identity, sessionId: options.sessionId, token: Symbol(), isCurrent: () => options.isCurrent(),
    };
    this.flows.set(flow.state.flowId, flow);
    this.active.set(flow.token, flow);
    this.sessions.set(flow.sessionId, flow);
    flow.timer = setTimeout(() => { this.requestCancel(flow); }, this.options.runningTtlMs ?? 30 * 60_000);
    flow.timer.unref();
    // Keep the real command promise in this scope, not its submission receipt.
    void execution.run({ service: this, token: flow.token }, async () => {
      try {
        await options.run();
        if (flow.commandError !== undefined) throw new Error(flow.commandError);
        flow.state.status = "complete";
      } catch (error) {
        flow.state.status = "error";
        flow.state.error = String(error instanceof Error ? error.message : error).slice(0, MAX_TEXT);
      } finally {
        this.active.delete(flow.token);
        this.sessions.delete(flow.sessionId);
        flow.pending?.settle(undefined);
        clearTimeout(flow.timer);
        if (!this.disposed) {
          flow.timer = setTimeout(() => { this.flows.delete(flow.state.flowId); }, this.options.terminalTtlMs ?? 5 * 60_000);
          flow.timer.unref();
        }
      }
    });
    return this.snapshot(flow);
  }

  /** Public /mcp waits for startup; its status UI must never escape into chat. */
  async discover<T>(options: { sessionId: string; identity: object; isCurrent(): boolean; run(): Promise<T> }): Promise<T> {
    const scope = execution.getStore();
    const own = scope?.service === this ? this.active.get(scope.token) : undefined;
    if (!own && (this.disposed || this.sessions.size > 0)) throw new Error("Another MCP authentication operation is running on this machine");
    const flow: Flow = own ?? {
      state: { flowId: randomUUID(), providerId: "mcp", providerName: "MCP server", status: "running", progress: [] },
      identity: options.identity, sessionId: options.sessionId, token: Symbol(), isCurrent: () => options.isCurrent(),
    };
    if (!own) {
      this.active.set(flow.token, flow);
      this.sessions.set(flow.sessionId, flow);
    }
    try {
      return await execution.run({ service: this, token: flow.token, discovery: true }, async () => {
        const result = await options.run();
        if (flow.commandError !== undefined) throw new Error("MCP server discovery failed");
        return result;
      });
    } finally {
      if (!own) {
        this.active.delete(flow.token);
        this.sessions.delete(flow.sessionId);
      }
    }
  }

  assertSessionAvailable(sessionId: string): void {
    const active = this.sessions.get(sessionId);
    const scope = execution.getStore();
    if (active && (scope?.service !== this || scope.token !== active.token)) throw new Error("MCP authentication operation is running for this session");
  }

  get(flowId: string): OAuthFlowState { return this.snapshot(this.requireFlow(flowId)); }

  respond(flowId: string, requestId: string, value: string): OAuthFlowState {
    const flow = this.requireFlow(flowId);
    const pending = flow.pending;
    if (flow.state.status !== "running" || pending?.id !== requestId) throw new Error("MCP authentication request is no longer pending");
    if (typeof value !== "string" || value.length > MAX_TEXT || (pending.values?.includes(value) === false)) throw new Error("Invalid MCP authentication response");
    pending.settle(value);
    return this.snapshot(flow);
  }

  cancel(flowId: string): OAuthFlowState {
    const flow = this.requireFlow(flowId);
    if (flow.state.status === "running") this.requestCancel(flow);
    return this.snapshot(flow);
  }

  cancelSession(sessionId: string): void {
    const flow = this.sessions.get(sessionId);
    if (flow) this.requestCancel(flow);
  }

  dispose(): void {
    this.disposed = true;
    for (const flow of this.flows.values()) {
      this.requestCancel(flow);
      clearTimeout(flow.timer);
    }
    this.active.clear();
    this.sessions.clear();
    this.flows.clear();
  }

  /** Invocation-time lookup: stale socket ancestry must use the ordinary bridge. */
  static current(identity?: object): McpAuthDispatcher | undefined {
    const scope = execution.getStore();
    const flow = scope?.service.active.get(scope.token);
    if (!scope || !flow || (identity !== undefined && identity !== flow.identity) || !flow.isCurrent()) return undefined;
    return new McpAuthDispatcher(scope.service, flow, scope.discovery === true);
  }

  private requireFlow(id: string): Flow {
    const flow = this.flows.get(id);
    if (!flow) throw new Error("MCP authentication flow not found");
    return flow;
  }

  private snapshot(flow: Flow): OAuthFlowState { return structuredClone(flow.state); }

  private requestCancel(flow: Flow): void {
    flow.state.cancelRequested = true;
    flow.pending?.settle(undefined);
  }

  wait(flow: Flow, title: string, options: ExtensionUIDialogOptions | undefined, values?: string[], placeholder?: string): Promise<string | undefined> {
    if (flow.state.cancelRequested === true || options?.signal?.aborted === true) return Promise.resolve(undefined);
    if (flow.pending) return Promise.reject(new Error("An MCP authentication request is already pending"));
    if (title.length > MAX_TEXT || (placeholder?.length ?? 0) > MAX_TEXT || (values && (values.length > 200 || values.some((value) => value.length > MAX_TEXT)))) return Promise.reject(new Error("MCP authentication prompt is too large"));
    const id = randomUUID();
    if (values) flow.state.select = { requestId: id, message: title, options: values.map((value) => ({ value, label: value })) };
    else flow.state.prompt = { requestId: id, message: title, promptType: "text", ...(placeholder === undefined ? {} : { placeholder }) };
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (value: string | undefined) => {
        if (flow.pending?.id !== id) return;
        clearTimeout(timer);
        options?.signal?.removeEventListener("abort", abort);
        delete flow.pending;
        delete flow.state.prompt;
        delete flow.state.select;
        resolve(value);
      };
      // Pi aborts the losing input when its browser callback wins. This only
      // dismisses the prompt; it is not cancellation of the auth operation.
      const abort = () => { settle(undefined); };
      flow.pending = { id, settle, ...(values === undefined ? {} : { values }) };
      if (options?.timeout !== undefined && options.timeout > 0) {
        timer = setTimeout(abort, options.timeout);
        timer.unref();
      }
      options?.signal?.addEventListener("abort", abort, { once: true });
      if (options?.signal?.aborted === true) abort();
    });
  }
}

/** Narrow adapter used by the stable session proxy and builtin openUrl hook. */
class McpAuthDispatcher {
  constructor(private readonly service: McpAuthFlowService, private readonly flow: Flow, private readonly discovery = false) {}
  selectServer(servers: McpAuthServerOption[]): Promise<string | undefined> {
    const result = this.select("Choose an MCP server", servers.map((server) => server.name));
    if (this.flow.state.select) this.flow.state.select.options = servers.map((server) => ({ value: server.name, label: server.name, ...(server.description === undefined ? {} : { description: server.description }) }));
    return result;
  }
  setServer(name: string): void { this.flow.state.providerName = name; }
  isCancelled(): boolean { return this.flow.state.cancelRequested === true; }
  notify(message: string): void {
    if (this.discovery) return;
    const url = this.flow.state.auth?.url;
    if (url !== undefined && message.includes(url)) return;
    this.flow.state.progress.push(message.slice(0, MAX_TEXT));
    this.flow.state.progress = this.flow.state.progress.slice(-MAX_PROGRESS);
  }
  openUrl(url: string): void {
    if (this.discovery) return;
    if (url.length > MAX_TEXT) throw new Error("MCP authorization URL is too large");
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("Unsupported MCP authorization URL");
    this.flow.state.auth = { url };
    this.flow.state.progress = this.flow.state.progress.filter((message) => !message.includes(url));
  }
  error(message: string): void { this.flow.commandError = message.slice(0, MAX_TEXT); this.notify(message); }
  input(title: string, placeholder?: string, options?: ExtensionUIDialogOptions): Promise<string | undefined> {
    if (this.discovery) { this.flow.commandError = "MCP discovery cannot request input"; return Promise.reject(new Error(this.flow.commandError)); }
    return this.service.wait(this.flow, title, options, undefined, placeholder);
  }
  select(title: string, values: string[], options?: ExtensionUIDialogOptions): Promise<string | undefined> {
    if (this.discovery) { this.flow.commandError = "MCP discovery cannot request input"; return Promise.reject(new Error(this.flow.commandError)); }
    return this.service.wait(this.flow, title, options, values);
  }
  async confirm(title: string, message: string, options?: ExtensionUIDialogOptions): Promise<boolean> {
    return await this.select(`${title}\n${message}`, ["Yes", "No"], options) === "Yes";
  }
}
