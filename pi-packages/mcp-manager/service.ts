import { createHash } from "node:crypto";
import type {
  JsonValue, PiWebHostPiSessionEventsV1, PluginCatalogV1, PluginProjectTrustV1,
  PluginSessionSelection, PluginSessionStateV1, ServerPluginPeerRequestContextV5, SessionStateSnapshot,
} from "@jmfederico/pi-web/server-plugin-api";
import { createManagedMcpConfigService, type ManagedMcpConfigContext, type ManagedMcpConfigSnapshot } from "./config.js";
import { mcpNamespaceKey, readNativeMcpNames } from "./nativeMcpNames.js";
import { MANAGED_MCP_SESSION_NAMESPACE, parseManagedMcpSessionValue } from "./session.js";
import { requestMcpRuntime, type McpRuntimeView } from "./runtimeClient.js";
import type { ManagedMcpScope, ManagedMcpView } from "./shared.js";

interface Update { scope: ManagedMcpScope; serverName: string; enabled: boolean; revision: string }
interface Selection { cwd?: string; session?: PluginSessionSelection; workspace?: { projectId: string; workspaceId: string } }
interface Snapshot {
  selection: Selection;
  context: ManagedMcpConfigContext;
  config: ManagedMcpConfigSnapshot;
  state: SessionStateSnapshot;
  runtime?: McpRuntimeView;
  issues: string[];
}
export interface McpManagerDependencies {
  config: ReturnType<typeof createManagedMcpConfigService>;
  agentDir: string;
  states: PluginSessionStateV1;
  trust: PluginProjectTrustV1;
  events: PiWebHostPiSessionEventsV1;
  catalog: PluginCatalogV1;
}

/** Package-owned management; the host supplies authority, private state and session messaging only. */
export class McpManagerService {
  constructor(private readonly deps: McpManagerDependencies) {}

  async request(request: ServerPluginPeerRequestContextV5): Promise<ManagedMcpView> {
    const { operation, input, signal } = request;
    if (operation !== "view" && operation !== "update") throw new Error("Unknown MCP management operation");
    const fields = parseInput(input, operation);
    const selection = selectContext(request, fields.sessionId);
    const before = await this.snapshot(selection, signal, operation === "view" ? "refresh" : "view");
    if (operation === "view") return this.view(before);
    const update = fields.update;
    if (update === undefined) throw new Error("Missing MCP update");
    if (revision(before) !== update.revision) throw new Error("MCP configuration changed; refresh and retry.");
    const current = this.view(before);
    const server = current.servers.find((row) => row.name === update.serverName);
    if (server === undefined) throw new Error("MCP server definition is unavailable.");
    if (server.nativeConflict === true) throw new Error("This server is defined in Pi’s mcp.json. Manage it there.");
    if (before.config.conflicts.includes(update.serverName)) throw new Error("Resolve conflicting MCP definitions before changing settings.");
    signal.throwIfAborted();
    if (update.scope === "session") {
      if (selection.session === undefined) throw new Error("Select a session to change its MCP settings.");
      if (!current.sessionWritable) throw new Error("Session MCP settings cannot be changed. Check the configuration messages.");
      const enabled = new Set(parseManagedMcpSessionValue(before.state.value));
      if (update.enabled) enabled.add(update.serverName); else enabled.delete(update.serverName);
      await this.deps.states.write(selection.session, MANAGED_MCP_SESSION_NAMESPACE, {
        value: { version: 1, enabledServers: [...enabled] }, inherit: true, revision: before.state.revision,
      }, { signal });
    } else {
      this.deps.config.setEnabled({ ...before.context, ...update, revision: before.config.view.revision, scope: update.scope });
    }
    // The saved choice is durable at this point. Refresh failures must not pretend
    // it was rolled back or invite an unsafe automatic retry of the write.
    const issues = update.scope === "session" ? [] : await this.refreshAffected(selection, update.scope, signal);
    const after = await this.snapshot(selection, signal, "refresh");
    after.issues.push(...issues);
    return this.view(after);
  }

  private async snapshot(selection: Selection, signal: AbortSignal, action: "view" | "refresh"): Promise<Snapshot> {
    const state = selection.session === undefined ? { revision: "" }
      : await this.deps.states.read(selection.session, MANAGED_MCP_SESSION_NAMESPACE, { signal });
    signal.throwIfAborted();
    let projectTrusted = selection.workspace !== undefined && await this.deps.trust.get(selection.workspace);
    let runtime: McpRuntimeView | undefined;
    const issues: string[] = [];
    if (selection.session !== undefined) {
      try {
        runtime = await requestMcpRuntime(this.deps.events, selection.session, action, signal);
        // A selected runtime can hold explicit one-session trust that was not
        // saved in Pi's trust store. Its extension applies Pi's trust boundary.
        projectTrusted = runtime.projectTrusted;
      } catch {
        signal.throwIfAborted();
        issues.push("MCP loader is unavailable in this session. Enable the package’s Pi extension and reload Pi resources.");
      }
    }
    signal.throwIfAborted();
    const context = {
      ...(selection.cwd === undefined ? {} : { cwd: selection.cwd }), projectTrusted,
      ...(selection.session === undefined ? {} : { sessionEnabledServers: parseManagedMcpSessionValue(state.value) }),
    };
    return { selection, context, state, config: this.deps.config.read(context), ...(runtime === undefined ? {} : { runtime }), issues };
  }

  private view(snapshot: Snapshot): ManagedMcpView {
    const { config, context, runtime, selection } = snapshot;
    const native = readNativeMcpNames(this.deps.agentDir, context.cwd, context.projectTrusted);
    return {
      ...config.view, revision: revision(snapshot),
      sessionWritable: config.view.sessionWritable && (selection.session === undefined || runtime !== undefined),
      issues: [...config.view.issues, ...snapshot.issues, ...(runtime?.errors.filter((error) => error.name === undefined).map((error) => error.message) ?? [])],
      servers: config.view.servers.map((server) => {
        const nativeConflict = native.has(mcpNamespaceKey(server.name));
        const pending = runtime?.pending === true || runtime?.servers.find((row) => row.name === server.name)?.pending === true;
        const error = runtime?.errors.find((row) => row.name === server.name)?.message;
        return { ...server,
          ...(nativeConflict ? { nativeConflict: true, effectiveEnabled: false } : {}),
          ...(pending ? { pending: true } : {}),
          ...(error === undefined ? {} : { error }),
        };
      }),
    };
  }

  private async refreshAffected(selection: Selection, scope: "global" | "project", signal: AbortSignal): Promise<string[]> {
    try {
      const workspaces = scope === "project" && selection.workspace !== undefined ? [selection.workspace]
        : (await Promise.all((await this.deps.catalog.projects.list({ signal }))
          .map((project) => this.deps.catalog.workspaces.list(project.id, { signal }))))
          .flat().map((workspace) => ({ projectId: workspace.projectId, workspaceId: workspace.id }));
      const sessions = (await Promise.all(workspaces.map(async (workspace) => (await this.deps.catalog.sessions.list(workspace, { signal }))
        .filter((session) => session.runtime !== "not-hosted" && !session.archived && session.id !== selection.session?.sessionId)
        .map((session) => ({ ...workspace, sessionId: session.id }))))).flat();
      // Do not open other saved conversations. Only existing runtime connections
      // receive a refresh; unopened sessions load their configuration on startup.
      await Promise.all(sessions.map((session) => requestMcpRuntime(this.deps.events, session, "refresh", signal)));
      return [];
    } catch {
      signal.throwIfAborted();
      return ["Choices saved. Some running sessions could not refresh; they will read the changes before their next turn."];
    }
  }
}

function revision(snapshot: Snapshot): string {
  return createHash("sha256").update(JSON.stringify([snapshot.config.view.revision, snapshot.state.revision])).digest("hex");
}
function selectContext(request: ServerPluginPeerRequestContextV5, sessionId?: string): Selection {
  if (request.scope.kind === "project") throw new Error("Select a workspace to manage project MCP settings.");
  if (request.scope.kind === "machine") {
    if (sessionId !== undefined) throw new Error("Session MCP settings require a workspace.");
    return {};
  }
  const workspace = { projectId: request.scope.project.id, workspaceId: request.scope.workspace.id };
  return { cwd: request.scope.workspace.path, workspace, ...(sessionId === undefined ? {} : { session: { ...workspace, sessionId } }) };
}
function parseInput(input: JsonValue, operation: "view" | "update"): { sessionId?: string; update?: Update } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("MCP request must be an object");
  const allowed = operation === "view" ? ["sessionId"] : ["sessionId", "scope", "serverName", "enabled", "revision"];
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw new Error("Unknown MCP request field");
  const sessionId: unknown = Reflect.get(input, "sessionId");
  if (sessionId !== undefined && (typeof sessionId !== "string" || sessionId.trim() === "" || sessionId.length > 512)) throw new Error("Invalid session ID");
  const context = sessionId === undefined ? {} : { sessionId };
  if (operation === "view") return context;
  const scope: unknown = Reflect.get(input, "scope");
  const serverName: unknown = Reflect.get(input, "serverName");
  const enabled: unknown = Reflect.get(input, "enabled");
  const revision: unknown = Reflect.get(input, "revision");
  if ((scope !== "global" && scope !== "project" && scope !== "session") || typeof serverName !== "string"
    || !/^[a-zA-Z0-9_-]+$/.test(serverName) || typeof enabled !== "boolean" || typeof revision !== "string" || revision.length > 128) throw new Error("Invalid MCP update");
  return { ...context, update: { scope, serverName, enabled, revision } };
}
