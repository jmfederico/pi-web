import { describe, expect, it } from "vitest";
import { PI_WEB_CAPABILITIES } from "../../../shared/capabilities";
import { SESSION_NOTIFICATION_LIMIT, SESSION_NOTIFICATION_MESSAGE_BYTES } from "../../../shared/apiTypes";
import { parseAuthProvidersResponse, parseCommandResult, parseFileContentResponse, parseFileSuggestion, parseGitStatusResponse, parseMachineRuntime, parseMessagePage, parseOAuthFlowState, parsePiPackageMutationResponse, parsePiPackagesResponse, parsePiWebConfigResponse, parsePiWebPluginsResponse, parsePiWebRuntimeResponse, parsePiWebStatusResponse, parseSessionBulkArchiveResponse, parseSessionBulkDeleteArchivedResponse, parseSessionCleanupExecuteResponse, parseSessionCleanupPreviewResponse, parseSessionInfo, parseSessionNotificationCatalogSnapshot, parseSessionNotificationInboxEvent, parseSessionNotificationInboxSnapshot, parseSessionNotificationSummaryEvent, parseSessionStatus, parseSessionStreamSnapshot, parseSlashCommand, parseTerminalCommandRun, parseTerminalInfo, parseWorkspace, parseWorkspaceActivityResponse } from "./parsers";

describe("API parsers", () => {
  it("preserves additive interactive API-key flow hints and defaults legacy options", () => {
    const base = { id: "openai", name: "OpenAI", authType: "api_key", status: { configured: false } };

    expect(parseAuthProvidersResponse({ providers: [{ ...base, loginFlow: "interactive" }, base] }).providers).toEqual([
      { ...base, loginFlow: "interactive" },
      base,
    ]);
  });

  it("preserves additive OAuth interaction semantics", () => {
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
      prompt: { requestId: "prompt-1", message: "Secret", kind: "prompt", promptType: "secret", allowEmpty: false, placeholder: "token" },
      select: { requestId: "select-1", message: "Choose", options: [{ value: "work", label: "Work", description: "Company account" }] },
      progress: ["Read the guide"],
      info: [{ message: "Read the guide", links: [{ url: "https://example.test/docs", label: "Guide" }] }],
    })).toMatchObject({
      auth: { deviceCode: { userCode: "ABCD", intervalSeconds: 5, expiresInSeconds: 900 } },
      prompt: { kind: "prompt", promptType: "secret", allowEmpty: false },
      select: { options: [{ value: "work", description: "Company account" }] },
      info: [{ links: [{ url: "https://example.test/docs", label: "Guide" }] }],
    });
  });

  it("defaults semantic prompt types from legacy OAuth wire kinds", () => {
    const flow = {
      flowId: "flow-1",
      providerId: "provider",
      providerName: "Provider",
      status: "running",
      progress: [],
    };

    expect(parseOAuthFlowState({ ...flow, prompt: { requestId: "text", message: "Value", kind: "prompt" } }).prompt).toMatchObject({
      kind: "prompt",
      promptType: "text",
    });
    expect(parseOAuthFlowState({ ...flow, prompt: { requestId: "manual", message: "Code", kind: "manual" } }).prompt).toMatchObject({
      kind: "manual",
      promptType: "manual_code",
    });
  });

  it("parses PI WEB config responses", () => {
    expect(parsePiWebConfigResponse({
      path: "/tmp/config.json",
      exists: true,
      config: { host: "0.0.0.0", port: 8504, allowedHosts: ["example.local"], shortcuts: { "core:view.chat": "mod+1", "core:session.stop": null }, plugins: { info: { enabled: false, settings: { compact: true } } }, pathAccess: { allowedPaths: ["/tmp"] }, uploads: { defaultFolder: "manual/uploads" }, maxUploadBytes: 1234, agent: { command: "agent-lab", dir: "~/agent-profiles/lab" } },
      effectiveConfig: { host: "127.0.0.1", port: 8504, allowedHosts: true, pathAccess: { allowedPaths: ["/tmp"] }, uploads: { defaultFolder: ".pi-web/uploads" }, agent: { command: "agent-lab", dir: "/Users/dev/agent-profiles/lab" } },
      envOverrides: { host: true, port: false, allowedHosts: false, spawnSessions: false, subsessions: false, agentCommand: false, agentDir: true, agentDirSource: "pi-compatibility", agentSessionDir: false },
    })).toEqual({
      path: "/tmp/config.json",
      exists: true,
      config: { host: "0.0.0.0", port: 8504, allowedHosts: ["example.local"], shortcuts: { "core:view.chat": "mod+1", "core:session.stop": null }, plugins: { info: { enabled: false, settings: { compact: true } } }, pathAccess: { allowedPaths: ["/tmp"] }, uploads: { defaultFolder: "manual/uploads" }, maxUploadBytes: 1234, agent: { command: "agent-lab", dir: "~/agent-profiles/lab" } },
      effectiveConfig: { host: "127.0.0.1", port: 8504, allowedHosts: true, pathAccess: { allowedPaths: ["/tmp"] }, uploads: { defaultFolder: ".pi-web/uploads" }, agent: { command: "agent-lab", dir: "/Users/dev/agent-profiles/lab" } },
      envOverrides: { host: true, port: false, allowedHosts: false, spawnSessions: false, subsessions: false, agentCommand: false, agentDir: true, agentDirSource: "pi-compatibility", agentSessionDir: false },
    });
  });

  it("parses PI WEB runtime responses including the daemon-owned active profile", () => {
    expect(parsePiWebRuntimeResponse({
      packageName: "@jmfederico/pi-web",
      generatedAt: "now",
      components: {
        web: { component: "web", label: "Web/UI", runtimeVersion: "1.0.0", available: true, capabilities: [PI_WEB_CAPABILITIES.sessionsDeleteArchived, PI_WEB_CAPABILITIES.piPackagesManage, "future.capability"] },
        sessiond: {
          component: "sessiond",
          label: "Session daemon",
          runtimeVersion: "1.0.0",
          available: true,
          capabilities: [PI_WEB_CAPABILITIES.sessionsDeleteArchived],
          activeAgentProfile: {
            schemaVersion: 1,
            revision: `sha256:${"a".repeat(64)}`,
            command: "agent-lab",
            dir: "/srv/agent-lab",
            sessionDirEnvKeys: ["PI_WEB_AGENT_SESSION_DIR"],
          },
        },
      },
      capabilities: [PI_WEB_CAPABILITIES.sessionsDeleteArchived, PI_WEB_CAPABILITIES.piPackagesManage, "future.capability"],
    })).toMatchObject({
      capabilities: [PI_WEB_CAPABILITIES.sessionsDeleteArchived, PI_WEB_CAPABILITIES.piPackagesManage],
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
      envOverrides: { host: false, port: false, allowedHosts: false, spawnSessions: false, subsessions: false, agentDirSource: "future" },
    })).toThrow("Invalid PI WEB agentDirSource field");
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

  it("accepts legacy array message pages and paged message responses", () => {
    expect(parseMessagePage(["a", "b"])).toEqual({ messages: ["a", "b"], start: 0, total: 2 });
    expect(parseMessagePage({ messages: ["c"], start: 3, total: 9 })).toEqual({ messages: ["c"], start: 3, total: 9 });
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

  it("accepts legacy workspace responses without effective config", () => {
    expect(parseWorkspace({
      id: "w1",
      projectId: "p1",
      path: "/repo",
      label: "main",
      isMain: true,
      isGitRepo: false,
      isGitWorktree: false,
    })).toEqual({
      id: "w1",
      projectId: "p1",
      path: "/repo",
      label: "main",
      isMain: true,
      isGitRepo: false,
      isGitWorktree: false,
    });
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
    expect(parseCommandResult({ type: "unsupported", message: "nope" })).toEqual({ type: "unsupported", message: "nope" });
    expect(parseCommandResult({ type: "select", requestId: "r1", title: "Pick", options: [{ value: "v", label: "Label", description: "desc" }] })).toEqual({ type: "select", requestId: "r1", title: "Pick", options: [{ value: "v", label: "Label", description: "desc" }] });
    expect(parseCommandResult({ type: "done", message: "ok", promptDraft: "resend me" })).toEqual({ type: "done", message: "ok", promptDraft: "resend me" });
    expect(() => parseCommandResult({ type: "later" })).toThrow("Invalid command result type");
  });

  it("strictly parses notification snapshots and realtime events", () => {
    const inbox = notificationInboxWire();

    expect(parseSessionNotificationCatalogSnapshot({
      daemonInstanceId: "daemon-a",
      catalogRevision: 1,
      sessions: [inbox.summary],
    })).toMatchObject({ daemonInstanceId: "daemon-a", sessions: [{ sessionId: "session-1" }] });
    expect(parseSessionNotificationInboxSnapshot(inbox)).toEqual(inbox);
    expect(parseSessionNotificationInboxEvent({
      type: "notifications.inbox",
      daemonInstanceId: "daemon-a",
      catalogRevision: 2,
      summary: { ...inbox.summary, inboxRevision: 2, retainedCount: 2, highestSeverity: "warning" },
      dismissThrough: { order: 2, overflowWatermark: 0 },
      delta: { kind: "added", notification: notificationWire(2, "warning") },
    })).toMatchObject({ type: "notifications.inbox", delta: { kind: "added", notification: { severity: "warning" } } });
    expect(parseSessionNotificationSummaryEvent({
      type: "notifications.summary",
      daemonInstanceId: "daemon-a",
      catalogRevision: 2,
      summary: { ...inbox.summary, inboxRevision: 2 },
    })).toMatchObject({ type: "notifications.summary", catalogRevision: 2 });
  });

  it("rejects malformed, unsafe, over-cap, and oversized notification payloads", () => {
    const inbox = notificationInboxWire();
    expect(() => parseSessionNotificationInboxSnapshot({
      ...inbox,
      notifications: [{ ...notificationWire(1), severity: "fatal" }],
    })).toThrow("Invalid notification severity");
    expect(() => parseSessionNotificationCatalogSnapshot({
      daemonInstanceId: "daemon-a",
      catalogRevision: Number.MAX_SAFE_INTEGER + 1,
      sessions: [],
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
});

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
