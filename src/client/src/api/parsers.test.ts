import { describe, expect, it } from "vitest";
import { ASK_USER_TEXT_MAX_LENGTH, EXTENSION_DIALOG_TEXT_MAX_LENGTH, SESSION_NOTIFICATION_LIMIT, SESSION_NOTIFICATION_MESSAGE_BYTES, SESSION_UNREAD_CATALOG_ID_MAX_LENGTH } from "../../../shared/apiTypes";
import { parseAskUserCloseResponse, parseAuthProvidersResponse, parseCommandResult, parseExtensionDialogCloseResponse, parseFileContentResponse, parseFileSuggestion, parseGitStatusResponse, parseMachineRuntime, parseMessagePage, parseOAuthFlowState, parsePiPackageMutationResponse, parsePiPackagesResponse, parsePiWebConfigResponse, parsePiWebPluginsResponse, parsePiWebRuntimeResponse, parsePiWebStatusResponse, parseSessionBulkArchiveResponse, parseSessionBulkDeleteArchivedResponse, parseSessionCleanupExecuteResponse, parseSessionCleanupPreviewResponse, parseSessionInfo, parseSessionNotificationInboxEvent, parseSessionNotificationInboxSnapshot, parseSessionStartupProgressEvent, parseSessionStatus, parseSessionStreamSnapshot, parseSessionTreeForkResult, parseSessionTreeNavigateResult, parseSessionTreeSnapshot, parseSessionUnreadCatalogSnapshot, parseSessionUnreadEvent, parseSlashCommand, parseTerminalCommandRun, parseTerminalInfo, parseWorkspace, parseWorkspaceActivityResponse } from "./parsers";

describe("API parsers", () => {
  it("preserves interactive API-key flow hints and defaults providers without one", () => {
    const base = { id: "openai", name: "OpenAI", authType: "api_key", status: { configured: false } };

    expect(parseAuthProvidersResponse({ providers: [{ ...base, loginFlow: "interactive" }, base] }).providers).toEqual([
      { ...base, loginFlow: "interactive" },
      base,
    ]);
  });

  it("preserves OAuth interaction semantics", () => {
    expect(parseOAuthFlowState({
      flowId: "flow-1",
      providerId: "provider",
      providerName: "Provider",
      status: "running",
      auth: {
        url: "https://example.test/device",
        instructions: "Enter code",
        deviceCode: { userCode: "ABCD", intervalSeconds: 5, expiresInSeconds: 900 },
      },
      prompt: { requestId: "prompt-1", message: "Secret", promptType: "secret", allowEmpty: false, placeholder: "token" },
      select: { requestId: "select-1", message: "Choose", options: [{ value: "work", label: "Work", description: "Company account" }] },
      progress: ["Read the guide"],
      info: [{ message: "Read the guide", links: [{ url: "https://example.test/docs", label: "Guide" }] }],
    })).toMatchObject({
      auth: { deviceCode: { userCode: "ABCD", intervalSeconds: 5, expiresInSeconds: 900 } },
      prompt: { promptType: "secret", allowEmpty: false },
      select: { options: [{ value: "work", description: "Company account" }] },
      info: [{ links: [{ url: "https://example.test/docs", label: "Guide" }] }],
    });
  });

  it("requires semantic prompt types on OAuth wire prompts", () => {
    const flow = {
      flowId: "flow-1",
      providerId: "provider",
      providerName: "Provider",
      status: "running",
      progress: [],
    };

    expect(() => parseOAuthFlowState({ ...flow, prompt: { requestId: "text", message: "Value" } })).toThrow("Invalid OAuth prompt type");
    expect(() => parseOAuthFlowState({ ...flow, prompt: { requestId: "text", message: "Value", promptType: "kind" } })).toThrow("Invalid OAuth prompt type");
  });

  it("parses PI WEB config responses", () => {
    expect(parsePiWebConfigResponse({
      path: "/tmp/config.json",
      exists: true,
      config: { host: "0.0.0.0", port: 8504, allowedHosts: ["example.local"], shortcuts: { "core:view.chat": "mod+1", "core:session.stop": null }, plugins: { info: { enabled: false, settings: { compact: true } } }, pathAccess: { allowedPaths: ["/tmp"] }, uploads: { defaultFolder: "manual/uploads" }, maxUploadBytes: 1234, automations: false, agent: { command: "agent-lab", dir: "~/agent-profiles/lab" } },
      effectiveConfig: { host: "127.0.0.1", port: 8504, allowedHosts: true, pathAccess: { allowedPaths: ["/tmp"] }, uploads: { defaultFolder: ".pi-web/uploads" }, automations: false, agent: { command: "agent-lab", dir: "/Users/dev/agent-profiles/lab" } },
      envOverrides: { host: true, port: false, allowedHosts: false, spawnSessions: false, subsessions: false, askUser: false, agentCommand: false, agentDir: true, agentDirSource: "pi-compatibility", agentSessionDir: false },
    })).toEqual({
      path: "/tmp/config.json",
      exists: true,
      config: { host: "0.0.0.0", port: 8504, allowedHosts: ["example.local"], shortcuts: { "core:view.chat": "mod+1", "core:session.stop": null }, plugins: { info: { enabled: false, settings: { compact: true } } }, pathAccess: { allowedPaths: ["/tmp"] }, uploads: { defaultFolder: "manual/uploads" }, maxUploadBytes: 1234, automations: false, agent: { command: "agent-lab", dir: "~/agent-profiles/lab" } },
      effectiveConfig: { host: "127.0.0.1", port: 8504, allowedHosts: true, pathAccess: { allowedPaths: ["/tmp"] }, uploads: { defaultFolder: ".pi-web/uploads" }, automations: false, agent: { command: "agent-lab", dir: "/Users/dev/agent-profiles/lab" } },
      envOverrides: { host: true, port: false, allowedHosts: false, spawnSessions: false, subsessions: false, askUser: false, agentCommand: false, agentDir: true, agentDirSource: "pi-compatibility", agentSessionDir: false },
    });
  });

  it("parses PI WEB runtime responses including the daemon-owned active profile", () => {
    expect(parsePiWebRuntimeResponse({
      packageName: "@jmfederico/pi-web",
      generatedAt: "now",
      components: {
        web: { component: "web", label: "Web/UI", runtimeVersion: "1.0.0", available: true, capabilities: ["piPackages.manage", "future.capability"] },
        sessiond: {
          component: "sessiond",
          label: "Session daemon",
          runtimeVersion: "1.0.0",
          available: true,
          capabilities: [],
          activeAgentProfile: {
            schemaVersion: 1,
            revision: `sha256:${"a".repeat(64)}`,
            command: "agent-lab",
            dir: "/srv/agent-lab",
            sessionDirEnvKeys: ["PI_WEB_AGENT_SESSION_DIR"],
          },
        },
      },
      capabilities: ["piPackages.manage", "future.capability"],
    })).toMatchObject({
      capabilities: [],
      components: { sessiond: { activeAgentProfile: { command: "agent-lab", dir: "/srv/agent-lab" } } },
    });
  });

  it("retains portable active profiles in machine runtime snapshots and rejects invalid ownership", () => {
    const profile = {
      schemaVersion: 1,
      revision: `sha256:${"b".repeat(64)}`,
      command: "C:\\tools\\pi.exe",
      dir: "C:\\agent-profiles\\work",
      sessionDirEnvKeys: ["PI_WEB_AGENT_SESSION_DIR"],
    };
    const components = {
      web: { component: "web", label: "Web/UI", available: true, capabilities: [] },
      sessiond: { component: "sessiond", label: "Session daemon", available: true, capabilities: [], activeAgentProfile: profile },
    };

    const parsed = parseMachineRuntime({ machineId: "remote-a", ok: true, checkedAt: "now", components, capabilities: [] });

    expect(parsed.components?.sessiond.activeAgentProfile).toMatchObject({ command: profile.command, dir: profile.dir });
    expect(Object.isFrozen(parsed.components?.sessiond.activeAgentProfile)).toBe(true);
    expect(() => parseMachineRuntime({
      machineId: "remote-a",
      ok: true,
      checkedAt: "now",
      components: { ...components, web: { ...components.web, activeAgentProfile: profile } },
      capabilities: [],
    })).toThrow("Invalid active agent profile descriptor");
    expect(() => parseMachineRuntime({
      machineId: "remote-a",
      ok: true,
      checkedAt: "now",
      components: { ...components, sessiond: { ...components.sessiond, activeAgentProfile: { ...profile, token: "secret" } } },
      capabilities: [],
    })).toThrow("Invalid active agent profile descriptor");
  });

  it("rejects malformed agent directory override metadata", () => {
    expect(() => parsePiWebConfigResponse({
      path: "/tmp/config.json",
      exists: true,
      config: {},
      effectiveConfig: {},
      envOverrides: { host: false, port: false, allowedHosts: false, spawnSessions: false, subsessions: false, askUser: false, agentCommand: false, agentDir: false, agentSessionDir: false, agentDirSource: "future" },
    })).toThrow("Invalid PI WEB agentDirSource field");
  });

  it("rejects config responses missing a required agent override flag", () => {
    const envOverrides = { host: false, port: false, allowedHosts: false, spawnSessions: false, subsessions: false, askUser: false, agentCommand: false, agentDir: false, agentSessionDir: false };
    for (const flag of ["askUser", "agentCommand", "agentDir", "agentSessionDir"] as const) {
      const incomplete = Object.fromEntries(Object.entries(envOverrides).filter(([key]) => key !== flag));
      expect(() => parsePiWebConfigResponse({
        path: "/tmp/config.json",
        exists: true,
        config: {},
        effectiveConfig: {},
        envOverrides: incomplete,
      })).toThrow(`Expected boolean field: ${flag}`);
    }
  });

  it("parses Pi package list and mutation responses", () => {
    const packages = [
      { source: "npm:@acme/tools", scope: "user", filtered: false, installedPath: "/home/test/.pi/packages/tools" },
      { source: "../project-tools", scope: "project", filtered: true },
    ];

    expect(parsePiPackagesResponse({ packages })).toEqual({ packages });
    expect(parsePiPackageMutationResponse({ action: "remove", source: "../project-tools", scope: "project", removed: true, packages })).toEqual({
      action: "remove",
      source: "../project-tools",
      scope: "project",
      removed: true,
      packages,
    });
  });

  it("rejects malformed Pi package responses", () => {
    expect(() => parsePiPackagesResponse({ packages: [{ source: "npm:@acme/tools", scope: "global", filtered: false }] })).toThrow("Invalid Pi package scope");
    expect(() => parsePiPackageMutationResponse({ action: "sync", packages: [] })).toThrow("Invalid Pi package mutation action");
    expect(() => parsePiPackagesResponse({ packages: [{ source: "npm:@acme/tools", scope: "user", filtered: "no" }] })).toThrow("Expected boolean field: filtered");
  });

  it("parses Docker PI WEB installation metadata", () => {
    const response = {
      packageName: "@jmfederico/pi-web",
      generatedAt: "now",
      components: {
        web: { component: "web", label: "Web/UI", runtimeVersion: "1.0.0", available: true, stale: false, installation: { kind: "docker", path: "/srv/pi-web-docker", dockerMode: "runtime" } },
        sessiond: { component: "sessiond", label: "Session daemon", runtimeVersion: "1.0.0", available: true, stale: false, installation: { kind: "docker", dockerMode: "dev" } },
      },
      release: { packageName: "@jmfederico/pi-web", updateAvailable: false },
      commands: { restart: "pi-web-docker restart", status: "pi-web-docker status" },
      messages: [],
    };

    const parsed = parsePiWebStatusResponse(response);

    expect(parsed.components.web.installation).toEqual({ kind: "docker", path: "/srv/pi-web-docker", dockerMode: "runtime" });
    expect(parsed.components.sessiond.installation).toEqual({ kind: "docker", dockerMode: "dev" });
    expect(parsed.commands).toEqual({ restart: "pi-web-docker restart", status: "pi-web-docker status" });
    expect(() => parsePiWebStatusResponse({
      ...response,
      components: {
        ...response.components,
        web: { ...response.components.web, installation: { kind: "docker", dockerMode: "hidden" } },
      },
    })).toThrow("Invalid PI WEB Docker mode");
  });

  it("parses PI WEB plugin status responses", () => {
    expect(parsePiWebPluginsResponse({
      plugins: [{ id: "info", module: "/pi-web-plugins/info/pi-web-plugin.js?v=1", source: "bundled", scope: "bundled", machineSpecific: true, enabled: false }],
    })).toEqual({
      plugins: [{ id: "info", module: "/pi-web-plugins/info/pi-web-plugin.js?v=1", source: "bundled", scope: "bundled", machineSpecific: true, enabled: false }],
    });
  });

  it("parses paged message responses and rejects legacy array message pages", () => {
    expect(parseMessagePage({ messages: ["c"], start: 3, total: 9 })).toEqual({ messages: ["c"], start: 3, total: 9 });
    expect(() => parseMessagePage(["a", "b"])).toThrow("Expected array response");
  });

  it("parses a session stream snapshot, defaulting a missing partial to null", () => {
    expect(parseSessionStreamSnapshot({ seq: 7, partial: { role: "assistant", content: [{ type: "text", text: "hi" }] } })).toEqual({
      seq: 7,
      partial: { role: "assistant", content: [{ type: "text", text: "hi" }] },
    });
    expect(parseSessionStreamSnapshot({ seq: 0, partial: null })).toEqual({ seq: 0, partial: null });
    expect(parseSessionStreamSnapshot({ seq: 3 })).toEqual({ seq: 3, partial: null });
  });

  it("rejects a session stream snapshot without a numeric seq", () => {
    expect(() => parseSessionStreamSnapshot({ partial: null })).toThrow("Expected number field: seq");
  });

  it("strictly parses unread snapshots and identity-matched deltas", () => {
    const newest = { sessionId: "session-2", cwd: "/repo", completionOrder: 2, completedAt: "2026-07-20T00:00:02.000Z" };
    const oldest = { sessionId: "session-1", cwd: "/repo", completionOrder: 1, completedAt: "2026-07-20T00:00:01.000Z" };
    expect(parseSessionUnreadCatalogSnapshot({ catalogId: "catalog-a", catalogRevision: 2, sessions: [newest, oldest] })).toEqual({
      catalogId: "catalog-a",
      catalogRevision: 2,
      sessions: [newest, oldest],
    });
    expect(parseSessionUnreadEvent({
      type: "sessions.unread",
      catalogId: "catalog-a",
      catalogRevision: 3,
      sessionId: newest.sessionId,
      cwd: newest.cwd,
      unread: newest,
    })).toMatchObject({ type: "sessions.unread", unread: newest });
    expect(parseSessionUnreadEvent({
      type: "sessions.unread",
      catalogId: "catalog-a",
      catalogRevision: 4,
      sessionId: newest.sessionId,
      cwd: newest.cwd,
      unread: null,
    })).toMatchObject({ type: "sessions.unread", unread: null });
  });

  it("rejects malformed, duplicate, unsorted, and mismatched unread payloads", () => {
    const summary = { sessionId: "session-1", cwd: "/repo", completionOrder: 1, completedAt: "2026-07-20T00:00:01.000Z" };
    expect(() => parseSessionUnreadCatalogSnapshot({ catalogId: "catalog-a", catalogRevision: 2, sessions: [summary, summary] })).toThrow("Duplicate session unread identity");
    expect(() => parseSessionUnreadCatalogSnapshot({
      catalogId: "catalog-a",
      catalogRevision: 2,
      sessions: [summary, { ...summary, sessionId: "session-2", completionOrder: 2 }],
    })).toThrow("not newest-first");
    expect(() => parseSessionUnreadCatalogSnapshot({ catalogId: "catalog-a", catalogRevision: 1, sessions: [{ ...summary, completedAt: "never" }] })).toThrow("Invalid canonical session unread completion time");
    expect(() => parseSessionUnreadCatalogSnapshot({ catalogId: "catalog-a", catalogRevision: 1, sessions: [{ ...summary, completedAt: "2026-07-20" }] })).toThrow("Invalid canonical session unread completion time");
    expect(() => parseSessionUnreadCatalogSnapshot({
      catalogId: "x".repeat(SESSION_UNREAD_CATALOG_ID_MAX_LENGTH + 1),
      catalogRevision: 0,
      sessions: [],
    })).toThrow("String field exceeds limit: catalogId");
    expect(() => parseSessionUnreadCatalogSnapshot({
      catalogId: "catalog-a",
      catalogRevision: 0,
      sessions: [summary],
    })).toThrow("completion order exceeds catalog revision");
    expect(() => parseSessionUnreadEvent({
      type: "sessions.unread",
      catalogId: "catalog-a",
      catalogRevision: 1,
      sessionId: "session-1",
      cwd: "/repo",
      unread: { ...summary, completionOrder: 2 },
    })).toThrow("completion order exceeds catalog revision");
    expect(() => parseSessionUnreadEvent({
      type: "sessions.unread",
      catalogId: "catalog-a",
      catalogRevision: 1,
      sessionId: "other-session",
      cwd: "/repo",
      unread: summary,
    })).toThrow("identity mismatch");
    expect(() => parseSessionUnreadEvent({
      type: "sessions.unread",
      catalogId: "catalog-a",
      catalogRevision: 0,
      sessionId: "session-1",
      cwd: "/repo",
      unread: null,
    })).toThrow("positive safe integer");
  });

  it("parses session startup progress with and without a correlation token", () => {
    const activity = { sessionId: "session-1", phase: "active", label: "Creating session", detail: "Starting the Pi session", at: "2026-07-20T00:00:01.000Z" };

    expect(parseSessionStartupProgressEvent({ type: "session.startup", startupToken: "pending-session-1-abc", activity })).toEqual({
      type: "session.startup",
      startupToken: "pending-session-1-abc",
      activity,
    });
    // An open carries no token: the activity's own session id is the only route.
    const idle = { sessionId: "session-1", phase: "idle", label: "idle", at: "2026-07-20T00:00:02.000Z" };
    expect(parseSessionStartupProgressEvent({ type: "session.startup", activity: idle })).toEqual({
      type: "session.startup",
      activity: idle,
    });
  });

  it("carries the startup marker so an opening session is not mistaken for a working one", () => {
    const activity = { sessionId: "session-1", phase: "active", label: "Opening session", detail: "Starting the Pi session", at: "2026-07-20T00:00:01.000Z", startup: true };

    expect(parseSessionStartupProgressEvent({ type: "session.startup", activity })).toEqual({ type: "session.startup", activity });
    // A malformed marker is dropped like any other malformed field rather than
    // being coerced into "this is startup" or "this is work".
    expect(() => parseSessionStartupProgressEvent({ type: "session.startup", activity: { ...activity, startup: "yes" } })).toThrow("Expected optional boolean field: startup");
  });

  it("rejects session startup progress that cannot be routed or rendered honestly", () => {
    const activity = { sessionId: "session-1", phase: "active", label: "Creating session", at: "2026-07-20T00:00:01.000Z" };

    expect(() => parseSessionStartupProgressEvent({ type: "activity.update", activity })).toThrow("Invalid session startup event type");
    expect(() => parseSessionStartupProgressEvent({ type: "session.startup" })).toThrow("Expected object response");
    expect(() => parseSessionStartupProgressEvent({ type: "session.startup", startupToken: 7, activity })).toThrow("Expected optional string field: startupToken");
    // An empty token would match nothing but must still be rejected rather than
    // silently carried, so a malformed frame never reaches the routing at all.
    expect(() => parseSessionStartupProgressEvent({ type: "session.startup", startupToken: "", activity })).toThrow("Expected non-empty string field: startupToken");
    expect(() => parseSessionStartupProgressEvent({ type: "session.startup", activity: { ...activity, phase: "waiting" } })).toThrow("Expected session activity phase field: phase");
    expect(() => parseSessionStartupProgressEvent({ type: "session.startup", activity: { ...activity, label: 7 } })).toThrow("Expected string field: label");
    expect(() => parseSessionStartupProgressEvent({ type: "session.startup", activity: { ...activity, label: "" } })).toThrow("Expected non-empty string field: label");
    expect(() => parseSessionStartupProgressEvent({ type: "session.startup", activity: { ...activity, detail: 7 } })).toThrow("Expected optional string field: detail");
    expect(() => parseSessionStartupProgressEvent({ type: "session.startup", activity: { ...activity, sessionId: "" } })).toThrow("Expected non-empty string field: sessionId");
  });

  it("parses session cleanup preview and execute responses", () => {
    const preview = {
      generatedAt: "2026-06-25T12:00:00.000Z",
      thresholds: { archiveIdleDays: 14, deleteArchivedDays: 30 },
      projects: [
        { cwd: "/repo-a", archiveCount: 2, deleteCount: 1 },
        { cwd: "/repo-b", archiveCount: 0, deleteCount: 3 },
      ],
      totals: { archiveCount: 2, deleteCount: 4 },
      skippedBusySessionIds: ["busy-1"],
    };

    expect(parseSessionCleanupPreviewResponse(preview)).toEqual(preview);
    expect(parseSessionCleanupExecuteResponse({ ...preview, archivedSessionIds: ["s1", "s2"], deletedSessionIds: ["a1"] })).toEqual({
      ...preview,
      archivedSessionIds: ["s1", "s2"],
      deletedSessionIds: ["a1"],
    });
  });

  it("rejects malformed session cleanup responses", () => {
    expect(() => parseSessionCleanupPreviewResponse({ generatedAt: "now", thresholds: {}, projects: [{ cwd: "/repo", archiveCount: "2", deleteCount: 0 }], totals: { archiveCount: 2, deleteCount: 0 } })).toThrow("Expected number field: archiveCount");
    expect(() => parseSessionCleanupExecuteResponse({ generatedAt: "now", thresholds: {}, projects: [], totals: { archiveCount: 0, deleteCount: 0 }, archivedSessionIds: ["s1"], deletedSessionIds: [1] })).toThrow("Expected string array field: deletedSessionIds");
  });

  it("parses bulk session mutation responses", () => {
    const failure = { sessionId: "busy", error: "Session is busy" };
    expect(parseSessionBulkArchiveResponse({ archived: true, archivedSessionIds: ["s1"], failures: [failure], generatedAt: "now" })).toEqual({
      archived: true,
      archivedSessionIds: ["s1"],
      failures: [failure],
      generatedAt: "now",
    });
    expect(parseSessionBulkDeleteArchivedResponse({ deleted: true, deletedSessionIds: ["s2"], failures: [], generatedAt: "later" })).toEqual({
      deleted: true,
      deletedSessionIds: ["s2"],
      failures: [],
      generatedAt: "later",
    });
  });

  it("rejects malformed bulk session mutation responses", () => {
    expect(() => parseSessionBulkArchiveResponse({ archived: true, archivedSessionIds: ["s1"], failures: [{ sessionId: "s2" }], generatedAt: "now" })).toThrow("Expected string field: error");
    expect(() => parseSessionBulkDeleteArchivedResponse({ deleted: true, deletedSessionIds: [1], failures: [], generatedAt: "now" })).toThrow("Expected string array field: deletedSessionIds");
  });

  it("parses session info including optional persistence signals", () => {
    expect(parseSessionInfo({
      id: "s1",
      path: "/sessions/s1.jsonl",
      cwd: "/repo",
      persisted: false,
      name: "Draft session",
      created: "2026-01-01T00:00:00.000Z",
      modified: "2026-01-01T00:01:00.000Z",
      messageCount: 0,
      firstMessage: "",
    })).toEqual({
      id: "s1",
      path: "/sessions/s1.jsonl",
      cwd: "/repo",
      persisted: false,
      name: "Draft session",
      created: "2026-01-01T00:00:00.000Z",
      modified: "2026-01-01T00:01:00.000Z",
      messageCount: 0,
      firstMessage: "",
    });
    expect(() => parseSessionInfo({ id: "s1", path: "", cwd: "/repo", persisted: "yes", created: "now", modified: "now", messageCount: 0, firstMessage: "" })).toThrow("Expected optional boolean field: persisted");
  });

  it("validates session status including optional model and nullable context usage", () => {
    expect(parseSessionStatus({
      sessionId: "s1",
      persisted: true,
      isStreaming: false,
      isCompacting: true,
      isBashRunning: false,
      pendingMessageCount: 2,
      queuedMessages: [{ kind: "steer", text: "adjust this" }, { kind: "followUp", text: "then do that" }],
      messageCount: 7,
      tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
      cost: 0.12,
      model: { provider: "p", id: "m", contextWindow: 100, reasoning: { effort: "low" } },
      contextUsage: { tokens: null, contextWindow: 100, percent: 0.5 },
      thinkingLevel: "medium",
    })).toEqual({
      sessionId: "s1",
      persisted: true,
      isStreaming: false,
      isCompacting: true,
      isBashRunning: false,
      pendingMessageCount: 2,
      queuedMessages: [{ kind: "steer", text: "adjust this" }, { kind: "followUp", text: "then do that" }],
      messageCount: 7,
      tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
      cost: 0.12,
      model: { provider: "p", id: "m", contextWindow: 100, reasoning: { effort: "low" } },
      contextUsage: { tokens: null, contextWindow: 100, percent: 0.5 },
      thinkingLevel: "medium",
    });
  });

  it("parses live session warnings including optional source and path", () => {
    const parsed = parseSessionStatus({
      sessionId: "s1",
      isStreaming: false,
      isCompacting: false,
      isBashRunning: false,
      pendingMessageCount: 0,
      queuedMessages: [],
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
      warnings: [
        { severity: "error", message: "bad skill", source: "skill", path: "/skills/a.md" },
        { severity: "warning", message: "subscription active", source: "anthropic", dismiss: { id: "anthropicExtraUsage" } },
        { severity: "info", message: "heads up", source: "runtime" },
      ],
    });

    expect(parsed.warnings).toEqual([
      { severity: "error", message: "bad skill", source: "skill", path: "/skills/a.md" },
      { severity: "warning", message: "subscription active", source: "anthropic", dismiss: { id: "anthropicExtraUsage" } },
      { severity: "info", message: "heads up", source: "runtime" },
    ]);
  });

  it("omits warnings entirely when the field is absent", () => {
    const parsed = parseSessionStatus({
      sessionId: "s1",
      isStreaming: false,
      isCompacting: false,
      isBashRunning: false,
      pendingMessageCount: 0,
      queuedMessages: [],
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
    });

    expect(parsed.warnings).toBeUndefined();
  });

  it("rejects a warning with an invalid severity", () => {
    expect(() => parseSessionStatus({
      sessionId: "s1",
      isStreaming: false,
      isCompacting: false,
      isBashRunning: false,
      pendingMessageCount: 0,
      queuedMessages: [],
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
      warnings: [{ severity: "fatal", message: "nope" }],
    })).toThrow("Invalid session warning severity");
  });

  it("parses workspace effective upload config when present", () => {
    expect(parseWorkspace({
      id: "w1",
      projectId: "p1",
      path: "/repo",
      label: "main",
      branch: "main",
      isMain: true,
      isGitRepo: true,
      isGitWorktree: false,
      effectiveConfig: { uploads: { defaultFolder: "manual/uploads" } },
    })).toEqual({
      id: "w1",
      projectId: "p1",
      path: "/repo",
      label: "main",
      branch: "main",
      isMain: true,
      isGitRepo: true,
      isGitWorktree: false,
      effectiveConfig: { uploads: { defaultFolder: "manual/uploads" } },
    });
  });

  it("rejects workspace responses without effective config", () => {
    expect(() => parseWorkspace({
      id: "w1",
      projectId: "p1",
      path: "/repo",
      label: "main",
      isMain: true,
      isGitRepo: false,
      isGitWorktree: false,
    })).toThrow("Expected workspace effectiveConfig field");
  });

  it("parses workspace activity snapshots", () => {
    expect(parseWorkspaceActivityResponse({
      generatedAt: "now",
      workspaces: [{ cwd: "/repo", hasSessionActivity: true, hasTerminalActivity: false, updatedAt: "later" }],
    })).toEqual({
      generatedAt: "now",
      workspaces: [{ cwd: "/repo", hasSessionActivity: true, hasTerminalActivity: false, updatedAt: "later" }],
    });
  });

  it("rejects invalid enum-like fields", () => {
    expect(() => parseSlashCommand({ name: "bad", source: "remote" })).toThrow("Invalid command source");
    expect(() => parseFileSuggestion({ path: "a", kind: "deleted" })).toThrow("Invalid file kind");
    expect(() => parseGitStatusResponse({ isGitRepo: true, hash: "h", files: [{ path: "a", index: "weird", workingTree: "modified" }] })).toThrow("Invalid git file state");
  });

  it("parses submodule paths and pointer commit fields", () => {
    const parsed = parseGitStatusResponse({
      isGitRepo: true,
      hash: "h",
      branch: "main",
      files: [
        { path: "HARL", index: "unmodified", workingTree: "modified", submoduleFromCommit: "1111111", submoduleToCommit: "2222222" },
        { path: "HARL/inner.txt", index: "modified", workingTree: "modified" },
      ],
      submodules: ["HARL"],
    });
    expect(parsed.submodules).toEqual(["HARL"]);
    expect(parsed.files[0]?.submoduleFromCommit).toBe("1111111");
    expect(parsed.files[0]?.submoduleToCommit).toBe("2222222");
    expect(parsed.files[1]?.submoduleFromCommit).toBeUndefined();
  });

  it("defaults submodules to an empty list when absent", () => {
    const parsed = parseGitStatusResponse({ isGitRepo: true, hash: "h", files: [] });
    expect(parsed.submodules).toEqual([]);
  });

  it("validates file content responses", () => {
    const textFile = {
      path: "README.md",
      language: "markdown",
      encoding: "utf8",
      size: 4,
      modifiedAt: "now",
      content: "text",
      truncated: false,
      binary: false,
    };

    expect(parseFileContentResponse(textFile)).toMatchObject({ path: "README.md", language: "markdown", content: "text" });
    expect(parseFileContentResponse({ ...textFile, path: "logo.png", mediaType: "image", mimeType: "image/png", content: "", binary: true })).toMatchObject({ path: "logo.png", mediaType: "image", mimeType: "image/png" });

    expect(() => parseFileContentResponse({ encoding: "base64" })).toThrow("Invalid file encoding");
    expect(() => parseFileContentResponse({ ...textFile, mediaType: "video" })).toThrow("Invalid file media type");
  });

  it("parses terminal info with optional command-run ownership", () => {
    expect(parseTerminalInfo({
      id: "t1",
      cwd: "/repo",
      name: "Build",
      createdAt: "now",
      exited: false,
      commandRunId: "run1",
    })).toMatchObject({ id: "t1", commandRunId: "run1" });
  });

  it("parses terminal command runs", () => {
    expect(parseTerminalCommandRun({
      id: "run1",
      origin: "core",
      projectId: "p1",
      workspaceId: "w1",
      terminalId: "t1",
      title: "Build",
      command: "npm run build",
      status: "succeeded",
      exitCode: 0,
      createdAt: "now",
      startedAt: "then",
      completedAt: "later",
      metadata: { "pi.operation": "test" },
    })).toEqual({
      id: "run1",
      origin: "core",
      projectId: "p1",
      workspaceId: "w1",
      terminalId: "t1",
      title: "Build",
      command: "npm run build",
      status: "succeeded",
      exitCode: 0,
      createdAt: "now",
      startedAt: "then",
      completedAt: "later",
      metadata: { "pi.operation": "test" },
    });
    expect(() => parseTerminalCommandRun({
      id: "run1",
      origin: "core",
      projectId: "p1",
      workspaceId: "w1",
      terminalId: "t1",
      title: "Build",
      command: "npm run build",
      status: "done",
      createdAt: "now",
      metadata: {},
    })).toThrow("Invalid terminal command run status");
  });

  it("parses command result variants", () => {
    const tree = sessionTreeWire();
    expect(parseCommandResult({ type: "unsupported", message: "nope" })).toEqual({ type: "unsupported", message: "nope" });
    expect(parseCommandResult({ type: "select", requestId: "r1", title: "Pick", options: [{ value: "v", label: "Label", description: "desc" }] })).toEqual({ type: "select", requestId: "r1", title: "Pick", options: [{ value: "v", label: "Label", description: "desc" }] });
    expect(parseCommandResult({ type: "tree", tree })).toEqual({ type: "tree", tree });
    expect(parseCommandResult({ type: "done", message: "ok", promptDraft: "resend me" })).toEqual({ type: "done", message: "ok", promptDraft: "resend me" });
    expect(() => parseCommandResult({ type: "later" })).toThrow("Invalid command result type");
  });

  it("strictly parses session tree snapshots and navigation results", () => {
    const tree = sessionTreeWire();
    expect(parseSessionTreeSnapshot(tree)).toEqual(tree);
    expect(parseSessionTreeNavigateResult({ cancelled: false, editorText: "edit this" })).toEqual({ cancelled: false, editorText: "edit this" });
    expect(parseSessionTreeNavigateResult({ cancelled: false })).toEqual({ cancelled: false });
    expect(parseSessionTreeNavigateResult({ cancelled: true, aborted: true })).toEqual({ cancelled: true, aborted: true });
    expect(parseSessionTreeNavigateResult({ cancelled: true })).toEqual({ cancelled: true });
    expect(parseSessionTreeNavigateResult({ cancelled: false, editorText: "edit this", operationId: "future-metadata" })).toEqual({ cancelled: false, editorText: "edit this" });
    expect(parseSessionTreeNavigateResult({ cancelled: true, aborted: true, operationId: "future-metadata" })).toEqual({ cancelled: true, aborted: true });

    expect(() => parseSessionTreeSnapshot({ ...tree, activeLeafId: undefined })).toThrow("activeLeafId");
    expect(() => parseSessionTreeSnapshot({ ...tree, activeLeafId: "missing" })).toThrow("activeLeafId");
    expect(() => parseSessionTreeSnapshot({ ...tree, activeLeafId: "   " })).toThrow("activeLeafId");
    expect(() => parseSessionTreeSnapshot({ ...tree, activePathIds: ["root", 2] })).toThrow("activePathIds");
    expect(() => parseSessionTreeSnapshot({ ...tree, activePathIds: ["   "] })).toThrow("activePathIds");
    expect(() => parseSessionTreeSnapshot({ ...tree, nodes: [{ ...tree.nodes[0], id: "   " }] })).toThrow("id");
    expect(() => parseSessionTreeSnapshot({ ...tree, nodes: [{ ...tree.nodes[0], parentId: undefined }] })).toThrow("parentId");
    expect(() => parseSessionTreeSnapshot({ ...tree, nodes: [{ ...tree.nodes[0], parentId: "   " }] })).toThrow("parentId");
    expect(() => parseSessionTreeSnapshot({ ...tree, nodes: [tree.nodes[0], tree.nodes[0]] })).toThrow("Duplicate session tree node id");
    expect(() => parseSessionTreeSnapshot({ ...tree, nodes: [{ ...tree.nodes[0], kind: "future-kind" }] })).toThrow("Invalid session tree node kind");
    expect(() => parseSessionTreeNavigateResult({ cancelled: true, editorText: "wrong branch" })).toThrow("editorText");
    expect(() => parseSessionTreeNavigateResult({ cancelled: false, aborted: true })).toThrow("aborted");
    expect(() => parseSessionTreeNavigateResult({ cancelled: false, editorText: 42 })).toThrow("editorText");
    expect(() => parseSessionTreeNavigateResult({ cancelled: true, aborted: "yes" })).toThrow("aborted");
    expect(() => parseSessionTreeNavigateResult({ cancelled: false, summaryEntry: { raw: true } })).toThrow("summaryEntry");
    expect(() => parseSessionTreeNavigateResult({ cancelled: true, summaryEntry: { raw: true } })).toThrow("summaryEntry");
    expect(() => parseSessionTreeNavigateResult({ editorText: "missing discriminator" })).toThrow("cancelled");
  });

  it("strictly parses session tree fork results", () => {
    const session = {
      id: "forked-session",
      path: "/sessions/forked-session.jsonl",
      cwd: "/repo",
      parentSessionId: "old-session",
      created: "2026-01-01T00:00:00.000Z",
      modified: "2026-01-01T00:01:00.000Z",
      messageCount: 2,
      firstMessage: "original prompt",
    };
    expect(parseSessionTreeForkResult({ cancelled: false, session })).toEqual({ cancelled: false, session });
    expect(parseSessionTreeForkResult({ cancelled: false, session, promptDraft: "resend me" })).toEqual({ cancelled: false, session, promptDraft: "resend me" });
    expect(parseSessionTreeForkResult({ cancelled: true })).toEqual({ cancelled: true });
    expect(parseSessionTreeForkResult({ cancelled: false, session, promptDraft: "resend me", operationId: "future-metadata" })).toEqual({ cancelled: false, session, promptDraft: "resend me" });
    expect(parseSessionTreeForkResult({ cancelled: true, operationId: "future-metadata" })).toEqual({ cancelled: true });

    expect(() => parseSessionTreeForkResult({ cancelled: false })).toThrow("Expected object response");
    expect(() => parseSessionTreeForkResult({ cancelled: false, session: { ...session, id: 42 } })).toThrow("Expected string field: id");
    expect(() => parseSessionTreeForkResult({ cancelled: false, session, promptDraft: 42 })).toThrow("promptDraft");
    expect(() => parseSessionTreeForkResult({ cancelled: true, session })).toThrow("session");
    expect(() => parseSessionTreeForkResult({ cancelled: true, promptDraft: "wrong branch" })).toThrow("promptDraft");
    expect(() => parseSessionTreeForkResult({ session })).toThrow("cancelled");
  });

  it("strictly parses selected notification snapshots and realtime events", () => {
    const inbox = notificationInboxWire();

    expect(parseSessionNotificationInboxSnapshot(inbox)).toEqual(inbox);
    expect(parseSessionNotificationInboxEvent({
      type: "notifications.inbox",
      daemonInstanceId: "daemon-a",
      catalogRevision: 2,
      summary: { ...inbox.summary, inboxRevision: 2, retainedCount: 2, highestSeverity: "warning" },
      dismissThrough: { order: 2, overflowWatermark: 0 },
      delta: { kind: "added", notification: notificationWire(2, "warning") },
    })).toMatchObject({ type: "notifications.inbox", delta: { kind: "added", notification: { severity: "warning" } } });
  });

  it("rejects malformed, unsafe, over-cap, and oversized notification payloads", () => {
    const inbox = notificationInboxWire();
    expect(() => parseSessionNotificationInboxSnapshot({
      ...inbox,
      notifications: [{ ...notificationWire(1), severity: "fatal" }],
    })).toThrow("Invalid notification severity");
    expect(() => parseSessionNotificationInboxSnapshot({
      ...inbox,
      catalogRevision: Number.MAX_SAFE_INTEGER + 1,
    })).toThrow("safe integer");
    expect(() => parseSessionNotificationInboxSnapshot({
      ...inbox,
      summary: { ...inbox.summary, retainedCount: SESSION_NOTIFICATION_LIMIT },
      notifications: Array.from({ length: SESSION_NOTIFICATION_LIMIT + 1 }, (_, index) => notificationWire(SESSION_NOTIFICATION_LIMIT + 1 - index)),
    })).toThrow("exceeds limit");
    expect(() => parseSessionNotificationInboxSnapshot({
      ...inbox,
      notifications: [{ ...notificationWire(1), message: "x".repeat(SESSION_NOTIFICATION_MESSAGE_BYTES + 1) }],
    })).toThrow("message exceeds byte limit");
    expect(() => parseSessionNotificationInboxEvent({
      type: "notifications.inbox",
      daemonInstanceId: "daemon-a",
      catalogRevision: 2,
      summary: { ...inbox.summary, inboxRevision: 2 },
      dismissThrough: { order: 1, overflowWatermark: 0 },
      delta: { kind: "cleared", reason: "future-reason" },
    })).toThrow("Invalid notification clear reason");
  });

  it("parses an open ask", () => {
    const parsed = parseSessionStatus({ ...statusWire(), pendingAsk: pendingAskWire() });

    expect(parsed.pendingAsk).toEqual({
      askId: "ask-1",
      askedAt: "2026-07-20T00:00:00.000Z",
      questions: [
        { id: "q1", question: "Which database?", detail: "Pick the primary store", options: [{ value: "pg", label: "Postgres", detail: "Relational" }, { value: "sqlite", label: "SQLite" }] },
        { id: "q2", question: "Which extras?", options: [{ value: "metrics", label: "Metrics" }], multiple: true },
      ],
    });
  });

  it("omits the pending ask entirely when the field is absent", () => {
    expect(parseSessionStatus(statusWire()).pendingAsk).toBeUndefined();
  });

  it("validates an ask before rendering it", () => {
    const ask = pendingAskWire();
    const first = ask.questions[0];
    expect(() => parseSessionStatus({ ...statusWire(), pendingAsk: { ...ask, questions: [] } })).toThrow("Pending ask has no questions");
    expect(() => parseSessionStatus({ ...statusWire(), pendingAsk: { ...ask, questions: [first, first] } })).toThrow("Duplicate ask question id");
    expect(() => parseSessionStatus({ ...statusWire(), pendingAsk: { ...ask, askId: "" } })).toThrow("Expected non-empty string field: askId");
    expect(parseSessionStatus({ ...statusWire(), pendingAsk: { ...ask, questions: [{ id: "q1", question: "Anything?", options: [] }] } }).pendingAsk?.questions[0])
      .toEqual({ id: "q1", question: "Anything?", options: [] });
    expect(() => parseSessionStatus({ ...statusWire(), pendingAsk: { ...ask, questions: [{ id: "q1", question: "Which?", options: [{ value: "a", label: "A" }, { value: "a", label: "Also A" }] }] } })).toThrow("Duplicate ask option value");
    expect(() => parseSessionStatus({ ...statusWire(), pendingAsk: { ...ask, questions: [{ id: "q1", question: "x".repeat(ASK_USER_TEXT_MAX_LENGTH + 1), options: [{ value: "a", label: "A" }] }] } })).toThrow("String field exceeds limit: question");
  });

  it("parses a closed ask response carrying the outcome and recomputed status", () => {
    const response = parseAskUserCloseResponse({
      result: "closed",
      outcome: askOutcomeWire(),
      sessionStatus: statusWire(),
    });

    expect(response.result).toBe("closed");
    expect(response.outcome).toMatchObject({
      askId: "ask-1",
      reason: "submitted",
      answeredCount: 1,
      unansweredIds: ["q2"],
      summary: "Answered 1 of 2; unanswered: q2",
    });
    expect(response.outcome?.questions[0]).toMatchObject({ answered: true, values: ["pg"] });
    expect(response.sessionStatus.sessionId).toBe("s1");
  });

  it("parses a stale close as an ordinary race with no outcome", () => {
    const response = parseAskUserCloseResponse({ result: "stale", sessionStatus: statusWire() });

    expect(response).toEqual({ result: "stale", sessionStatus: parseSessionStatus(statusWire()) });
  });

  it("rejects close responses whose outcome contradicts itself", () => {
    const outcome = askOutcomeWire();
    expect(() => parseAskUserCloseResponse({ result: "closed", sessionStatus: statusWire() })).toThrow("Ask close response outcome mismatch");
    expect(() => parseAskUserCloseResponse({ result: "stale", outcome, sessionStatus: statusWire() })).toThrow("Ask close response outcome mismatch");
    expect(() => parseAskUserCloseResponse({ result: "closed", outcome: { ...outcome, answeredCount: 2 }, sessionStatus: statusWire() })).toThrow("Ask outcome answered count mismatch");
    expect(() => parseAskUserCloseResponse({ result: "closed", outcome: { ...outcome, unansweredIds: [] }, sessionStatus: statusWire() })).toThrow("Ask outcome unanswered ids mismatch");
    expect(() => parseAskUserCloseResponse({ result: "closed", outcome: { ...outcome, reason: "ignored" }, sessionStatus: statusWire() })).toThrow("Invalid ask close reason");
    expect(() => parseAskUserCloseResponse({
      result: "closed",
      outcome: { ...outcome, questions: [{ ...askAnsweredRecordWire(), answered: false }, askUnansweredRecordWire()] },
      sessionStatus: statusWire(),
    })).toThrow("Ask answer contradicts its answered flag");
    expect(() => parseAskUserCloseResponse({
      result: "closed",
      outcome: { ...outcome, questions: [{ ...askAnsweredRecordWire(), values: ["mysql"] }, askUnansweredRecordWire()] },
      sessionStatus: statusWire(),
    })).toThrow("Ask answer selected an option the question never offered");
  });

  it("parses open extension dialogs on the session status, oldest first", () => {
    const parsed = parseSessionStatus({ ...statusWire(), pendingDialogs: [confirmDialogWire(), selectDialogWire(), inputDialogWire()] });

    expect(parsed.pendingDialogs).toEqual([
      { dialogId: "dialog-1", kind: "confirm", title: "Delete the build cache?", message: "This cannot be undone", askedAt: "2026-07-20T00:00:00.000Z", runScoped: true },
      { dialogId: "dialog-2", kind: "select", title: "Pick a database", options: ["Postgres", "SQLite"], askedAt: "2026-07-20T00:01:00.000Z", timeoutAt: "2026-07-20T00:06:00.000Z", runScoped: false },
      { dialogId: "dialog-3", kind: "input", title: "Name the branch", placeholder: "feature/...", askedAt: "2026-07-20T00:02:00.000Z", runScoped: false },
    ]);
  });

  it("omits pending dialogs entirely when the field is absent", () => {
    expect(parseSessionStatus(statusWire()).pendingDialogs).toBeUndefined();
  });

  it("validates an extension dialog before rendering it", () => {
    const dialog = confirmDialogWire();
    expect(() => parseSessionStatus({ ...statusWire(), pendingDialogs: [{ ...dialog, kind: "modal" }] })).toThrow("Invalid extension dialog kind");
    expect(() => parseSessionStatus({ ...statusWire(), pendingDialogs: [{ ...dialog, title: "" }] })).toThrow("Expected non-empty string field: title");
    expect(() => parseSessionStatus({ ...statusWire(), pendingDialogs: [{ ...dialog, title: "x".repeat(EXTENSION_DIALOG_TEXT_MAX_LENGTH + 1) }] })).toThrow("String field exceeds limit: title");
    expect(() => parseSessionStatus({ ...statusWire(), pendingDialogs: [{ ...dialog, runScoped: "yes" }] })).toThrow("Expected boolean field: runScoped");
    expect(() => parseSessionStatus({ ...statusWire(), pendingDialogs: [{ ...dialog, timeoutAt: "" }] })).toThrow("Expected non-empty string field: timeoutAt");
    expect(() => parseSessionStatus({ ...statusWire(), pendingDialogs: [{ ...selectDialogWire(), options: [] }] })).toThrow("Select dialog has no options");
    expect(() => parseSessionStatus({ ...statusWire(), pendingDialogs: [{ ...selectDialogWire(), options: ["a", "a"] }] })).toThrow("Duplicate dialog option");
    expect(() => parseSessionStatus({ ...statusWire(), pendingDialogs: [dialog, { ...inputDialogWire(), dialogId: "dialog-1" }] })).toThrow("Duplicate dialog id");
  });

  it("parses a closed dialog response carrying the outcome and recomputed status", () => {
    const response = parseExtensionDialogCloseResponse({
      result: "closed",
      outcome: dialogOutcomeWire(),
      sessionStatus: statusWire(),
    });

    expect(response.result).toBe("closed");
    expect(response.outcome).toEqual({
      dialogId: "dialog-1",
      reason: "answered",
      answer: true,
      askedAt: "2026-07-20T00:00:00.000Z",
      closedAt: "2026-07-20T00:01:00.000Z",
    });
    expect(response.sessionStatus.sessionId).toBe("s1");
  });

  it("parses a stale dialog close as an ordinary race with no outcome", () => {
    const response = parseExtensionDialogCloseResponse({ result: "stale", sessionStatus: statusWire() });

    expect(response).toEqual({ result: "stale", sessionStatus: parseSessionStatus(statusWire()) });
  });

  it("rejects dialog close responses whose outcome contradicts itself", () => {
    const outcome = dialogOutcomeWire();
    expect(() => parseExtensionDialogCloseResponse({ result: "closed", sessionStatus: statusWire() })).toThrow("Dialog close response outcome mismatch");
    expect(() => parseExtensionDialogCloseResponse({ result: "stale", outcome, sessionStatus: statusWire() })).toThrow("Dialog close response outcome mismatch");
    expect(() => parseExtensionDialogCloseResponse({ result: "closed", outcome: { ...outcome, reason: "timeout" }, sessionStatus: statusWire() })).toThrow("Dialog outcome answer mismatch");
    expect(() => parseExtensionDialogCloseResponse({ result: "closed", outcome: { ...outcome, answer: 1 }, sessionStatus: statusWire() })).toThrow("Invalid extension dialog answer");
    expect(() => parseExtensionDialogCloseResponse({ result: "closed", outcome: { ...outcome, reason: "ignored" }, sessionStatus: statusWire() })).toThrow("Invalid extension dialog close reason");
  });
});

function statusWire() {
  return {
    sessionId: "s1",
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    pendingMessageCount: 0,
    queuedMessages: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
  };
}

function pendingAskWire() {
  return {
    askId: "ask-1",
    askedAt: "2026-07-20T00:00:00.000Z",
    questions: [
      { id: "q1", question: "Which database?", detail: "Pick the primary store", options: [{ value: "pg", label: "Postgres", detail: "Relational" }, { value: "sqlite", label: "SQLite" }] },
      { id: "q2", question: "Which extras?", options: [{ value: "metrics", label: "Metrics" }], multiple: true },
    ],
  };
}

function askAnsweredRecordWire() {
  const ask = pendingAskWire();
  return { question: ask.questions[0], answered: true, values: ["pg"] };
}

function askUnansweredRecordWire() {
  const ask = pendingAskWire();
  return { question: ask.questions[1], answered: false, values: [] };
}

function askOutcomeWire() {
  return {
    askId: "ask-1",
    reason: "submitted",
    askedAt: "2026-07-20T00:00:00.000Z",
    closedAt: "2026-07-20T00:01:00.000Z",
    questions: [askAnsweredRecordWire(), askUnansweredRecordWire()],
    answeredCount: 1,
    unansweredIds: ["q2"],
    summary: "Answered 1 of 2; unanswered: q2",
  };
}

function confirmDialogWire() {
  return {
    dialogId: "dialog-1",
    kind: "confirm",
    title: "Delete the build cache?",
    message: "This cannot be undone",
    askedAt: "2026-07-20T00:00:00.000Z",
    runScoped: true,
  };
}

function selectDialogWire() {
  return {
    dialogId: "dialog-2",
    kind: "select",
    title: "Pick a database",
    options: ["Postgres", "SQLite"],
    askedAt: "2026-07-20T00:01:00.000Z",
    timeoutAt: "2026-07-20T00:06:00.000Z",
    runScoped: false,
  };
}

function inputDialogWire() {
  return {
    dialogId: "dialog-3",
    kind: "input",
    title: "Name the branch",
    placeholder: "feature/...",
    askedAt: "2026-07-20T00:02:00.000Z",
    runScoped: false,
  };
}

function dialogOutcomeWire() {
  return {
    dialogId: "dialog-1",
    reason: "answered",
    answer: true,
    askedAt: "2026-07-20T00:00:00.000Z",
    closedAt: "2026-07-20T00:01:00.000Z",
  };
}

function sessionTreeWire() {
  const kinds = [
    "user",
    "assistant",
    "tool-result",
    "bash",
    "custom-message",
    "compaction",
    "branch-summary",
    "model-change",
    "thinking-level-change",
    "session-info",
    "label",
    "custom",
    "other",
  ] as const;
  const nodes = kinds.map((kind, index) => ({
    id: `entry-${String(index)}`,
    parentId: index === 0 ? null : `entry-${String(index - 1)}`,
    kind,
    summary: `${kind} summary`,
    ...(index === 0 ? { timestamp: "2026-07-20T00:00:00.000Z", label: "root label" } : {}),
  }));
  return {
    nodes,
    activeLeafId: nodes.at(-1)?.id ?? null,
    activePathIds: nodes.map((node) => node.id),
  };
}

function notificationWire(order: number, severity: "info" | "warning" | "error" = "info") {
  return {
    id: `daemon-a:${String(order)}`,
    message: `notice ${String(order)}`,
    truncated: false,
    severity,
    receivedAt: "2026-07-18T00:00:00.000Z",
    order,
  };
}

function notificationInboxWire() {
  return {
    daemonInstanceId: "daemon-a",
    catalogRevision: 1,
    summary: {
      sessionId: "session-1",
      cwd: "/repo",
      inboxRevision: 1,
      retainedCount: 1,
      discardedCount: 0,
      highestSeverity: "info" as const,
    },
    notifications: [notificationWire(1)],
    dismissThrough: { order: 1, overflowWatermark: 0 },
  };
}
