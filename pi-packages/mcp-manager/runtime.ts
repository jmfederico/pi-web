import type { ExtensionAPI, ExtensionContext, InlineExtension, McpServerConfig } from "@earendil-works/pi-coding-agent";

export interface ManagedMcpSnapshot {
  /** Already validated and trust-filtered by the resolver; no file I/O in this controller. */
  definitions: Record<string, McpServerConfig>;
  /** Missing choices inherit the definition's enabled value (default true). */
  enabled?: Record<string, boolean>;
}

export interface ManagedMcpRuntimeError {
  code: "resolve_failed" | "name_conflict" | "register_failed" | "unregister_failed";
  name?: string;
  /** Safe for API responses: never includes config values or upstream exception text. */
  message: string;
}

export interface ManagedMcpRuntimeState {
  bound: boolean;
  pending: boolean;
  servers: {
    name: string;
    configured: boolean;
    enabled: boolean;
    registered: boolean;
    registeredEnabled?: boolean;
    pending: boolean;
  }[];
  errors: ManagedMcpRuntimeError[];
}

export interface ManagedMcpControllerOptions {
  /** The host must filter project definitions using ctx.isProjectTrusted(). */
  resolve?: (ctx: ExtensionContext) => ManagedMcpSnapshot | Promise<ManagedMcpSnapshot>;
  /** Report to the host's visible diagnostics; raw exceptions may contain credentials. */
  onError?: (error: ManagedMcpRuntimeError) => void;
}

interface Binding { pi: ExtensionAPI; ctx: ExtensionContext }
interface OwnedRegistration { config: McpServerConfig; extensionPath: string }
const namespace = (name: string) => name.replaceAll("-", "_");
// Preserve toolExposure pattern order, which Pi uses to choose the first match.
const sameConfig = (a: McpServerConfig | undefined, b: McpServerConfig | undefined) => JSON.stringify(a) === JSON.stringify(b);

/** One controller per session runtime. It owns registration intent, not MCP connections. */
export class ManagedMcpController {
  private desired = new Map<string, McpServerConfig>();
  private owned = new Map<string, OwnedRegistration>();
  private binding: Binding | undefined;
  private revision = 0;
  private resolving = 0;
  private refreshPending = false;
  private loadError: ManagedMcpRuntimeError | undefined;
  private errors: ManagedMcpRuntimeError[] = [];

  constructor(private readonly options: ManagedMcpControllerOptions = {}) {}

  /** Replace the entire managed snapshot; busy runs keep their existing registrations. */
  apply(snapshot: ManagedMcpSnapshot): ManagedMcpRuntimeState {
    this.setDesired(snapshot);
    this.loadError = undefined;
    if (this.binding?.ctx.isIdle() === true && this.resolving === 0) this.reconcile(this.binding);
    return this.getState();
  }

  /** Reload host configuration now if idle, otherwise at agent_settled. */
  async refresh(): Promise<ManagedMcpRuntimeState> {
    const binding = this.binding;
    if (binding?.ctx.isIdle() !== true) this.refreshPending = true;
    else await this.resolveAndApply(binding);
    return this.getState();
  }

  /** Configured/registered intent only. Native file overrides and connection health belong to Pi. */
  getState(): ManagedMcpRuntimeState {
    const servers = [...new Set([...this.desired.keys(), ...this.owned.keys()])].map((name) => {
      const desired = this.desired.get(name);
      const registered = this.owned.get(name)?.config;
      return {
        name,
        configured: desired !== undefined,
        enabled: desired?.enabled !== false && desired !== undefined,
        registered: registered !== undefined,
        ...(registered ? { registeredEnabled: registered.enabled !== false } : {}),
        pending: !sameConfig(desired, registered),
      };
    });
    return {
      bound: this.binding !== undefined,
      pending: this.refreshPending || this.resolving > 0 || servers.some((server) => server.pending),
      servers,
      errors: this.errors.map((error) => ({ ...error })),
    };
  }

  /** Used by createManagedMcpExtension; the SDK recreates this factory on /reload. */
  createExtension(): InlineExtension {
    return {
      name: "mcp-manager",
      factory: (pi) => {
        let active: Binding | undefined;
        pi.on("session_start", async (_event, ctx) => {
          if (this.binding) throw new Error("Managed MCP controller is already bound to a session.");
          active = { pi, ctx };
          this.binding = active;
          await this.resolveAndApply(active, true);
        });
        pi.on("before_agent_start", async (_event, ctx) => {
          if (active !== this.binding || !active) return;
          active.ctx = ctx;
          // Pi is already busy here, but no model/tool work has started. This handler
          // must precede the native MCP handler that waits for first-prompt direct tools.
          await this.resolveAndApply(active, true);
        });
        pi.on("agent_settled", async (_event, ctx) => {
          if (active !== this.binding || !active) return;
          active.ctx = ctx;
          if (this.refreshPending) await this.resolveAndApply(active);
          else this.reconcile(active);
        });
        pi.on("session_shutdown", () => {
          if (active !== this.binding || !active) return;
          // Pi tears down the registration registry and connections with the runtime.
          // Do not emit dynamic connection changes while that teardown is in progress.
          this.binding = undefined;
          this.owned.clear();
          this.revision += 1;
          this.refreshPending = false;
          active = undefined;
        });
      },
    };
  }

  private setDesired(snapshot: ManagedMcpSnapshot): void {
    this.revision += 1;
    this.desired = new Map(Object.entries(snapshot.definitions).map(([name, config]) => {
      const choice = snapshot.enabled && Object.hasOwn(snapshot.enabled, name) ? snapshot.enabled[name] : undefined;
      return [name, structuredClone({ ...config, enabled: choice ?? config.enabled ?? true })];
    }));
  }

  private async resolveAndApply(binding: Binding, atBoundary = false): Promise<void> {
    this.refreshPending = false;
    const revision = ++this.revision;
    this.resolving += 1;
    try {
      if (this.options.resolve) {
        const snapshot = await this.options.resolve(binding.ctx);
        if (binding === this.binding && revision === this.revision) {
          this.setDesired(snapshot);
          this.loadError = undefined;
        }
      }
    } catch {
      if (binding === this.binding && revision === this.revision) {
        // A failed trust/configuration resolution cannot preserve previously allowed servers.
        this.setDesired({ definitions: {} });
        this.loadError = { code: "resolve_failed", message: "Could not load managed MCP servers. Managed registrations have been withdrawn; check configuration and retry." };
      }
    } finally {
      this.resolving -= 1;
    }
    if (binding === this.binding && (atBoundary || binding.ctx.isIdle())) this.reconcile(binding);
  }

  private reconcile(binding: Binding): void {
    const errors: ManagedMcpRuntimeError[] = this.loadError ? [this.loadError] : [];
    const registrations = binding.pi.getMcpServers();
    for (const [name, owned] of this.owned) {
      const current = registrations.find((server) => server.name === name);
      if (current?.extensionPath !== owned.extensionPath) {
        this.owned.delete(name);
        continue;
      }
      if (this.desired.has(name)) continue;
      try {
        binding.pi.unregisterMcpServer(name);
        this.owned.delete(name);
      } catch {
        errors.push({ code: "unregister_failed", name, message: `Could not remove managed MCP server "${name}". Retry the update.` });
      }
    }
    for (const [name, config] of this.desired) {
      const owned = this.owned.get(name);
      const conflict = binding.pi.getMcpServers().find((server) => namespace(server.name) === namespace(name)
        && (server.name !== name || server.extensionPath !== owned?.extensionPath));
      if (conflict) {
        errors.push({ code: "name_conflict", name, message: `MCP server "${name}" conflicts with another extension's registration. Choose a different managed server name.` });
        continue;
      }
      if (owned && sameConfig(config, owned.config)) continue;
      try {
        binding.pi.registerMcpServer(name, config);
        const registered = binding.pi.getMcpServers().find((server) => server.name === name);
        if (!registered) throw new Error("MCP registration was not retained.");
        this.owned.set(name, { config, extensionPath: registered.extensionPath });
      } catch {
        errors.push({ code: "register_failed", name, message: `Could not register managed MCP server "${name}". Check its configuration and retry.` });
      }
    }
    const previous = this.errors;
    this.errors = errors;
    for (const error of errors) {
      if (previous.some((entry) => entry.code === error.code && entry.name === error.name)) continue;
      this.options.onError?.({ ...error });
      if (binding.ctx.hasUI) binding.ctx.ui.notify(error.message, "error");
    }
  }
}

export function createManagedMcpController(options: ManagedMcpControllerOptions = {}): ManagedMcpController {
  return new ManagedMcpController(options);
}

/** Load BEFORE createMcpExtension(), then await session.bindExtensions() before prompting. */
export function createManagedMcpExtension(controller: ManagedMcpController): InlineExtension {
  return controller.createExtension();
}
