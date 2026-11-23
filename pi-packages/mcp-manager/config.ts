import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { McpServerConfig } from "@earendil-works/pi-coding-agent";
import { canonicalConfigPath, readConfigDocument, updateConfigDocument } from "./storage.js";
import { parseManagedMcpConfig, requireMcpServerName } from "./mcpConfig.js";
import type { ManagedMcpView } from "./shared.js";

export interface ManagedMcpConfigOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  agentDir?: string;
}

export function managedMcpAgentDir(options: ManagedMcpConfigOptions = {}): string {
  const env = options.env ?? process.env;
  const envDir = env["PI_CODING_AGENT_DIR"];
  const selected = options.agentDir ?? (envDir === undefined || envDir === "" ? join(homedir(), ".pi", "agent") : envDir);
  const expanded = selected === "~" ? homedir() : selected.startsWith("~/") ? join(homedir(), selected.slice(2)) : selected;
  return resolve(options.cwd ?? process.cwd(), expanded);
}

export interface ManagedMcpConfigContext {
  cwd?: string;
  projectTrusted: boolean;
  sessionEnabledServers?: readonly string[];
}
export interface ManagedMcpDefinition {
  name: string;
  config: McpServerConfig;
  scope: "global" | "project";
  source: string;
}
/** Internal only: definitions contain secrets. Send only view to the browser. */
export interface ManagedMcpConfigSnapshot {
  view: ManagedMcpView;
  definitions: ManagedMcpDefinition[];
  enabledByScope: { global: string[]; project: string[]; session: string[] };
  enabledServers: string[];
  conflicts: string[];
}
export interface ManagedMcpConfigUpdate extends ManagedMcpConfigContext {
  scope: "global" | "project";
  serverName: string;
  enabled: boolean;
  revision: string;
}

export function createManagedMcpConfigService(options: ManagedMcpConfigOptions = {}): {
  read: (context: ManagedMcpConfigContext) => ManagedMcpConfigSnapshot;
  setEnabled: (update: ManagedMcpConfigUpdate) => ManagedMcpConfigSnapshot;
} {
  const env = options.env ?? process.env;
  const globalPath = join(managedMcpAgentDir(options), "mcp-manager", "config.json");

  function read(context: ManagedMcpConfigContext): ManagedMcpConfigSnapshot {
    const global = readConfigDocument(globalPath);
    const projectPath = context.cwd === undefined ? undefined : join(context.cwd, ".pi", "mcp-manager.json");
    // Untrusted content is never read, parsed, or included in the revision.
    const project = projectPath !== undefined && context.projectTrusted ? readConfigDocument(projectPath) : undefined;
    const saved = parseManagedMcpConfig(global.record, globalPath);
    let policy = {};
    if (env["PI_MCP_MANAGER"] !== undefined) {
      let value: unknown;
      try { value = JSON.parse(env["PI_MCP_MANAGER"]); }
      catch { throw new Error("PI_MCP_MANAGER must contain valid JSON."); }
      policy = parseManagedMcpConfig(value, "PI_MCP_MANAGER");
    }
    const globalConfig = { ...saved, ...policy };
    const projectConfig = project === undefined ? {} : parseManagedMcpConfig(project.record, projectPath ?? "project", true);
    const enabledEnforced = Object.hasOwn(policy, "enabledServers");
    const definitionsEnforced = Object.hasOwn(policy, "servers");
    const globalSource = definitionsEnforced ? "PI_MCP_MANAGER" : globalPath;
    const definitions: ManagedMcpDefinition[] = [
      ...Object.entries(globalConfig.servers ?? {}).map(([name, config]) => ({ name, config, scope: "global" as const, source: globalSource })),
      ...Object.entries(definitionsEnforced ? {} : projectConfig.servers ?? {}).map(([name, config]) => ({ name, config, scope: "project" as const, source: projectPath ?? "project" })),
    ];
    const namespaces = new Map<string, ManagedMcpDefinition[]>();
    for (const definition of definitions) {
      const key = definition.name.replaceAll("-", "_");
      namespaces.set(key, [...namespaces.get(key) ?? [], definition]);
    }
    const conflicts = [...new Set([...namespaces.values()].filter((entries) => entries.length > 1).flatMap((entries) => entries.map((entry) => entry.name)))];
    const knownNames = new Set(definitions.map((definition) => definition.name));
    const globalNames = new Set(definitions.filter((definition) => definition.scope === "global").map((definition) => definition.name));
    const enforcedEnabled = enabledEnforced ? globalConfig.enabledServers ?? [] : undefined;
    // Policy selects available definitions, not global-file grants. Project-only
    // definitions still require trust and cannot be enabled by saved global grants.
    const enabledByScope = {
      global: enforcedEnabled?.filter((name) => globalNames.has(name)) ?? globalConfig.enabledServers ?? [],
      project: enforcedEnabled?.filter((name) => knownNames.has(name) && !globalNames.has(name)) ?? projectConfig.enabledServers ?? [],
      session: enabledEnforced ? [] : [...new Set(context.sessionEnabledServers ?? [])].map((name) => requireMcpServerName(name, "session")),
    };
    const enabledServers = definitions.filter((definition) => !conflicts.includes(definition.name) && (
      (definition.scope === "global" && enabledByScope.global.includes(definition.name)) || enabledByScope.project.includes(definition.name) || enabledByScope.session.includes(definition.name)
    )).map((definition) => definition.name);
    const issues = [
      ...(enforcedEnabled === undefined ? [] : ["MCP enablement is enforced by PI_MCP_MANAGER.",
        ...enforcedEnabled.filter((name) => !knownNames.has(name)).map((name) => `Enforced MCP server ${name} has no available definition.`)]),
      ...conflicts.map((name) => `Conflicting managed MCP definitions for ${name}; rename or remove the duplicate.`),
      ...enabledByScope.global.filter((name) => !globalNames.has(name)).map((name) => `Globally enabled MCP server ${name} has no global definition.`),
      ...[...new Set([...enabledByScope.project, ...enabledByScope.session])].filter((name) => !knownNames.has(name)).map((name) => `Enabled MCP server ${name} has no available definition.`),
    ];
    const projectProtected = projectPath !== undefined && canonicalConfigPath(projectPath) === canonicalConfigPath(globalPath);
    const revision = createHash("sha256").update(JSON.stringify({
      globalPath, global: global.content,
      projectPath, project: project?.content, trusted: context.projectTrusted,
      env: env["PI_MCP_MANAGER"], session: context.sessionEnabledServers ?? [],
    })).digest("hex");
    return {
      definitions, enabledByScope, enabledServers, conflicts,
      view: {
        globalConfigPath: globalPath,
        ...(projectPath === undefined ? {} : { projectConfigPath: projectPath }),
        projectTrusted: context.projectTrusted,
        globalWritable: !enabledEnforced,
        projectWritable: !enabledEnforced && context.projectTrusted && projectPath !== undefined && !projectProtected,
        sessionWritable: !enabledEnforced,
        servers: [...new Map(definitions.map((definition) => [definition.name, definition])).values()].map((definition) => ({
          name: definition.name,
          ...(definition.config.description === undefined ? {} : { description: definition.config.description }),
          definitionScope: definition.scope,
          enabled: {
            global: definition.scope === "global" && enabledByScope.global.includes(definition.name),
            ...(projectPath === undefined ? {} : { project: enabledByScope.project.includes(definition.name) }),
            ...(context.sessionEnabledServers === undefined ? {} : { session: enabledByScope.session.includes(definition.name) }),
          },
          effectiveEnabled: enabledServers.includes(definition.name),
          ...(conflicts.includes(definition.name) ? { error: "Conflicting managed MCP definitions." } : {}),
        })),
        issues, revision,
      },
    };
  }

  function setEnabled(update: ManagedMcpConfigUpdate): ManagedMcpConfigSnapshot {
    requireMcpServerName(update.serverName, "update");
    const before = read(update);
    if (before.view.revision !== update.revision) throw new Error("MCP configuration changed; reload and retry.");
    if (update.scope === "global" ? !before.view.globalWritable : !before.view.projectWritable) throw new Error("MCP enablement is read-only for this scope.");
    if (before.conflicts.includes(update.serverName)) throw new Error("Resolve conflicting MCP definitions before changing enablement.");
    const definition = before.definitions.find((entry) => entry.name === update.serverName);
    if (definition === undefined) throw new Error("MCP server definition is unavailable.");
    if (update.scope === "global" && definition.scope === "project") throw new Error("Project MCP definitions cannot be enabled globally.");
    const path = update.scope === "global" ? globalPath : before.view.projectConfigPath;
    if (path === undefined) throw new Error("MCP project scope needs a workspace.");
    updateConfigDocument(path, ({ record }) => {
      // Recheck all participating docs under the target's lock, not only its enablement list.
      if (read(update).view.revision !== update.revision) throw new Error("MCP configuration changed; reload and retry.");
      parseManagedMcpConfig(record, path, update.scope === "project");
      const current = update.scope === "global" ? before.enabledByScope.global : before.enabledByScope.project;
      const enabled = new Set(current);
      if (update.enabled) enabled.add(update.serverName); else enabled.delete(update.serverName);
      // Preserve raw definitions (including aliases) and unrelated, possibly future settings.
      return { ...record, enabledServers: [...enabled] };
    });
    return read(update);
  }
  return { read, setEnabled };
}
