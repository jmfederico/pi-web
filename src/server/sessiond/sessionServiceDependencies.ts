import type { PiSessionServiceDependencies } from "../sessions/piSessionService.js";

/**
 * The collaborators sessiond constructs, in the shape the assembly needs them.
 *
 * Every field is required unless the capability itself is optional, so a
 * collaborator the daemon stops constructing cannot silently vanish from the
 * session service.
 */
export interface SessionServiceDependencyInput {
  agentDir: string;
  /** Daemon-lifetime session archive, constructed against the captured daemon environment. */
  archiveStore: NonNullable<PiSessionServiceDependencies["archiveStore"]>;
  sessionManager: PiSessionServiceDependencies["sessionManager"];
  modelRuntime: PiSessionServiceDependencies["modelRuntime"];
  workspaceActivity: NonNullable<PiSessionServiceDependencies["workspaceActivity"]>;
  logger: NonNullable<PiSessionServiceDependencies["logger"]>;
  notificationStore: NonNullable<PiSessionServiceDependencies["notificationStore"]>;
  unreadStore: NonNullable<PiSessionServiceDependencies["unreadStore"]>;
  /** Notifies the machine status projection that unread state changed. */
  onUnreadChanged: NonNullable<PiSessionServiceDependencies["onUnreadChanged"]>;
  /** Read-only view of the background refresher; see the assembly below. */
  catalogRefreshStatus: NonNullable<PiSessionServiceDependencies["catalogRefreshStatus"]>;
  /** Live global config reader for request-time workspace-effective defaults (e.g. the attachments save folder). */
  config: NonNullable<PiSessionServiceDependencies["config"]>;
  /** Omitted when the operator has not enabled session spawning. */
  spawnTargets?: NonNullable<PiSessionServiceDependencies["spawnTargets"]>;
  /** The operator's subsessions preference, which also requires spawning. */
  subsessionsEnabled: boolean;
  /** Whether agents may post structured question sets to the browser. */
  askUserEnabled: boolean;
  /** Deployment facts appended to session system prompts; empty when there are none. */
  appendSystemPromptSections: readonly string[];
  /** Auto-cancel delay for extension dialogs whose extension set no timeout; `0` waits forever. */
  extensionDialogsTimeoutMs: number;
}

/**
 * Map sessiond's constructed collaborators onto the session service's
 * dependencies.
 *
 * Extracted from `sessiond.ts`, which starts a daemon as an import side effect
 * and so cannot be loaded by a test. This function performs no side effects and
 * constructs nothing, so lifting it changes no startup ordering; it exists only
 * so a test can build a service the way the daemon does and assert what a user
 * is actually told.
 */
export function sessionServiceDependencies(input: SessionServiceDependencyInput): PiSessionServiceDependencies {
  return {
    modelRuntime: input.modelRuntime,
    agentDir: input.agentDir,
    archiveStore: input.archiveStore,
    workspaceActivity: input.workspaceActivity,
    logger: input.logger,
    ...(input.spawnTargets === undefined ? {} : { spawnTargets: input.spawnTargets }),
    // Tracked subsessions share the spawn capability's project-scope resolver,
    // so they stay off unless spawning is configured too.
    subsessionsEnabled: input.spawnTargets !== undefined && input.subsessionsEnabled,
    askUserEnabled: input.askUserEnabled,
    appendSystemPromptSections: input.appendSystemPromptSections,
    extensionDialogsTimeoutMs: input.extensionDialogsTimeoutMs,
    notificationStore: input.notificationStore,
    unreadStore: input.unreadStore,
    onUnreadChanged: input.onUnreadChanged,
    // Read-only, so session startup can tell a waiting user that provider
    // model lists are refreshing at the same time.
    catalogRefreshStatus: input.catalogRefreshStatus,
    config: input.config,
    sessionManager: input.sessionManager,
  };
}
