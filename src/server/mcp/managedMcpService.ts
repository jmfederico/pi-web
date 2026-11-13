import { hasTrustRequiringProjectResources, ProjectTrustStore, SettingsManager, type InlineExtension, type McpServerConfig } from "../../piSdk.js";
import type { ManagedMcpContext, ManagedMcpUpdate, ManagedMcpView } from "../../shared/managedMcp.js";
import { createManagedMcpConfigService, type ManagedMcpConfigContext, type ManagedMcpConfigSnapshot } from "./managedMcpConfig.js";
import { createManagedMcpController, createManagedMcpExtension, type ManagedMcpController } from "./managedMcpRuntime.js";
import { hasManagedMcpProjectConfig, mcpNamespaceKey, readNativeMcpNames } from "./nativeMcpNames.js";
import { readManagedMcpSession, writeManagedMcpSession, type ManagedMcpSessionStore } from "./managedMcpSession.js";

export type ManagedMcpConfigService = ReturnType<typeof createManagedMcpConfigService>;

export interface ManagedMcpSession extends ManagedMcpSessionStore {
  getCwd(): string;
}

/** The adapter owns scope choices; Pi owns MCP validation, credentials, transports and tool execution. */
export class ManagedMcpService {
  private readonly controllers = new WeakMap<ManagedMcpSession, ManagedMcpController>();
  private readonly trustRequiredAtCreation = new WeakMap<ManagedMcpSession, boolean>();

  constructor(private readonly config: ManagedMcpConfigService, private readonly agentDir: string) {}

  extension(manager: ManagedMcpSession, onError: (message: string) => void): InlineExtension {
    this.trustRequiredAtCreation.set(manager, hasTrustRequiringProjectResources(manager.getCwd()) || hasManagedMcpProjectConfig(manager.getCwd()));
    const controller = createManagedMcpController({
      resolve: (ctx) => {
        const snapshot = this.snapshot({ cwd: ctx.cwd }, this.projectTrusted(manager, ctx.isProjectTrusted()), manager);
        const native = readNativeMcpNames(this.agentDir, ctx.cwd, ctx.isProjectTrusted());
        const definitions: Record<string, McpServerConfig> = Object.fromEntries(snapshot.definitions
          .filter((definition) => !snapshot.conflicts.includes(definition.name) && !native.has(mcpNamespaceKey(definition.name)))
          .map((definition) => [definition.name, definition.config]));
        return { definitions, enabled: Object.fromEntries(Object.keys(definitions).map((name) => [name, snapshot.enabledServers.includes(name)])) };
      },
      onError: (error) => { onError(error.message); },
    });
    this.controllers.set(manager, controller);
    return createManagedMcpExtension(controller);
  }

  projectTrusted(manager: ManagedMcpSession, piTrusted: boolean): boolean {
    if (!piTrusted) return false;
    if (this.trustRequiredAtCreation.get(manager) === true) return true;
    // Pi auto-trusts empty workspaces. That is not approval for commands added
    // later in .pi-web/config.json; require saved/default trust for those scopes.
    const saved = new ProjectTrustStore(this.agentDir).get(manager.getCwd());
    return saved ?? SettingsManager.create(manager.getCwd(), this.agentDir, { projectTrusted: false }).getDefaultProjectTrust() === "always";
  }

  async refresh(manager: ManagedMcpSession): Promise<void> {
    await this.controllers.get(manager)?.refresh();
  }

  view(context: ManagedMcpContext, projectTrusted: boolean, manager?: ManagedMcpSession): ManagedMcpView {
    const snapshot = this.snapshot(context, projectTrusted, manager);
    const native = readNativeMcpNames(this.agentDir, context.cwd, projectTrusted);
    const runtime = manager === undefined ? undefined : this.controllers.get(manager)?.getState();
    return {
      ...snapshot.view,
      issues: [...snapshot.view.issues, ...(runtime?.errors.filter((error) => error.name === undefined).map((error) => error.message) ?? [])],
      servers: snapshot.view.servers.map((server) => {
        const nativeConflict = native.has(mcpNamespaceKey(server.name));
        const state = runtime?.servers.find((entry) => entry.name === server.name);
        const error = runtime?.errors.find((entry) => entry.name === server.name)?.message;
        return {
          ...server,
          ...(nativeConflict ? { nativeConflict: true, effectiveEnabled: false } : {}),
          ...(runtime?.pending === true || state?.pending === true ? { pending: true } : {}),
          ...(error === undefined ? {} : { error }),
        };
      }),
    };
  }

  /** File writes are synchronous, serialized by the storage adapter, and revision checked. */
  update(input: ManagedMcpUpdate, projectTrusted: boolean, manager?: ManagedMcpSession): void {
    const context = this.configContext(input, projectTrusted, manager);
    const snapshot = this.config.read(context);
    if (snapshot.view.revision !== input.revision) throw new Error("MCP configuration changed; refresh and retry.");
    if (readNativeMcpNames(this.agentDir, input.cwd, projectTrusted).has(mcpNamespaceKey(input.serverName))) {
      throw new Error("This server is defined in Pi's mcp.json. Manage its enablement there.");
    }
    if (input.scope !== "session") {
      this.config.setEnabled({ ...context, ...input, scope: input.scope });
      return;
    }
    if (manager === undefined || input.sessionId === undefined) throw new Error("Select a session to change session MCP settings.");
    if (!snapshot.view.sessionWritable) throw new Error("Session MCP enablement is enforced by deployment configuration.");
    if (snapshot.conflicts.includes(input.serverName)) throw new Error("Resolve conflicting MCP definitions before changing enablement.");
    if (!snapshot.definitions.some((definition) => definition.name === input.serverName)) throw new Error("MCP server definition is unavailable.");
    const enabled = new Set(readManagedMcpSession(manager));
    if (input.enabled) enabled.add(input.serverName); else enabled.delete(input.serverName);
    writeManagedMcpSession(manager, [...enabled]);
  }

  private snapshot(context: ManagedMcpContext, projectTrusted: boolean, manager?: ManagedMcpSession): ManagedMcpConfigSnapshot {
    return this.config.read(this.configContext(context, projectTrusted, manager));
  }

  private configContext(context: ManagedMcpContext, projectTrusted: boolean, manager?: ManagedMcpSession): ManagedMcpConfigContext {
    return {
      ...(context.cwd === undefined ? {} : { cwd: context.cwd }), projectTrusted,
      ...(manager === undefined ? {} : { sessionEnabledServers: readManagedMcpSession(manager) }),
    };
  }
}
