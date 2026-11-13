import { getAgentDir, ProjectTrustStore, SessionManager, SettingsManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { latestSessionStateEntries } from "../../../src/shared/sessionState.js";
import { createManagedMcpConfigService } from "../config.js";
import { mcpNamespaceKey, readNativeMcpNames } from "../nativeMcpNames.js";
import { createManagedMcpController } from "../runtime.js";
import { MANAGED_MCP_SESSION_ENTRY, MANAGED_MCP_SESSION_NAMESPACE, managedMcpSessionData, readManagedMcpSession } from "../session.js";
import { MCP_MANAGER_REQUEST, MCP_MANAGER_RESPONSE, type McpManagerResponse } from "../shared.js";

/** File-backed registration only. Pi owns transports, credentials, tools, and its native /mcp UI. */
export default function mcpManager(pi: ExtensionAPI): void {
  const agentDir = getAgentDir();
  const config = createManagedMcpConfigService({ agentDir });
  let context: ExtensionContext | undefined;
  let startupFailed = false;

  function projectTrusted(ctx: ExtensionContext): boolean {
    if (!ctx.isProjectTrusted()) return false;
    // Pi can preserve empty-workspace auto-trust across reloads. Require saved
    // consent or GLOBAL default trust every time; project settings cannot grant it.
    return new ProjectTrustStore(agentDir).get(ctx.cwd)
      ?? SettingsManager.create(ctx.cwd, agentDir, { projectTrusted: false }).getDefaultProjectTrust() === "always";
  }

  const controller = createManagedMcpController({
    resolve: (ctx) => {
      if (startupFailed) throw new Error("Could not restore MCP session settings.");
      const trusted = projectTrusted(ctx);
      const snapshot = config.read({ cwd: ctx.cwd, projectTrusted: trusted, sessionEnabledServers: readManagedMcpSession(ctx.sessionManager) });
      const native = readNativeMcpNames(agentDir, ctx.cwd, trusted);
      const definitions = Object.fromEntries(snapshot.definitions
        .filter((definition) => !snapshot.conflicts.includes(definition.name) && !native.has(mcpNamespaceKey(definition.name)))
        .map((definition) => [definition.name, definition.config]));
      return { definitions, enabled: Object.fromEntries(Object.keys(definitions).map((name) => [name, snapshot.enabledServers.includes(name)])) };
    },
  });

  // Run before the controller's startup handler so restored choices affect the
  // very first registration. TUI forks can select history older than a toggle.
  pi.on("session_start", (event, ctx) => {
    context = ctx;
    startupFailed = false;
    if (event.reason !== "fork" || event.previousSessionFile === undefined) return;
    try {
      const previous = SessionManager.open(event.previousSessionFile);
      const latest = latestSessionStateEntries(previous.getEntries()).find((entry) => entry.namespace === MANAGED_MCP_SESSION_NAMESPACE);
      const enabled = latest?.inherit === true ? readManagedMcpSession(previous) : [];
      pi.appendEntry(MANAGED_MCP_SESSION_ENTRY, managedMcpSessionData(enabled));
    } catch {
      // Never fall back to stale grants copied from the selected historical branch.
      startupFailed = true;
    }
  });
  const runtime = controller.createExtension();
  void (typeof runtime === "function" ? runtime : runtime.factory)(pi);

  const unsubscribe = pi.events.on(MCP_MANAGER_REQUEST, (data: unknown) => {
    if (!isRequest(data)) return;
    const { id, action } = data;
    const reply = (response: McpManagerResponse) => { pi.events.emit(MCP_MANAGER_RESPONSE, response); };
    if (context === undefined) {
      reply({ id, error: "MCP manager is not bound to a session." });
      return;
    }
    const ctx = context;
    // EventBus does not await listeners. Catch every failure at this optional edge;
    // neither exceptions nor configuration values may cross the event protocol.
    void (async () => {
      try {
        const state = action === "refresh" ? await controller.refresh() : controller.getState();
        if (context !== ctx) return;
        reply({ id, state, projectTrusted: projectTrusted(ctx) });
      } catch {
        reply({ id, error: "Could not refresh managed MCP servers. Check configuration and retry." });
      }
    })();
  });
  pi.on("session_shutdown", () => {
    context = undefined;
    unsubscribe();
  });
}

function isRequest(value: unknown): value is { id: string; action: "refresh" | "view" } {
  if (!isRecord(value)) return false;
  const request = value;
  return typeof request["id"] === "string" && request["id"].length > 0
    && (request["action"] === "refresh" || request["action"] === "view");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
