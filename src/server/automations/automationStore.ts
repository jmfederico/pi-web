import { randomUUID } from "node:crypto";
import { linkSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import type {
  AutomationAttempt,
  AutomationAttemptStatus,
  AutomationDefinition,
  AutomationModelPolicy,
  AutomationRun,
  AutomationRunStatus,
  AutomationThinkingPolicy,
  AutomationTrigger,
  AutomationUsageSnapshot,
  SessionModel,
} from "../../shared/apiTypes.js";
import { piWebDataDir } from "../../config.js";

const ACTIVE_RUN_STATUSES: readonly AutomationRunStatus[] = ["queued", "starting", "running", "cancelling"];
const TERMINAL_RUN_STATUSES: readonly AutomationRunStatus[] = ["completed", "failed", "cancelled", "timed_out", "skipped", "unknown"];

interface AutomationRow {
  id: string;
  project_id: string;
  workspace_id: string;
  workspace_path: string;
  name: string;
  description: string | null;
  prompt: string;
  enabled: number;
  revision: number;
  tested_revision: number | null;
  trigger_json: string;
  model_json: string;
  thinking_json: string;
  timeout_ms: number;
  abort_grace_ms: number;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
}

interface RunRow {
  id: string;
  automation_id: string;
  automation_revision: number;
  automation_name: string;
  project_id: string;
  workspace_id: string;
  workspace_path: string;
  source: string;
  scheduled_for: string;
  status: string;
  prompt: string;
  trigger_json: string;
  configured_model_json: string;
  configured_thinking_json: string;
  actual_model_json: string | null;
  actual_thinking_level: string | null;
  timeout_ms: number;
  queued_at: string;
  started_at: string | null;
  completed_at: string | null;
  deadline_at: string | null;
  cancel_requested_at: string | null;
  cancellation_kind: string | null;
  session_id: string | null;
  reason: string | null;
  error: string | null;
  usage_json: string | null;
}

interface AttemptRow {
  id: string;
  run_id: string;
  attempt_number: number;
  status: string;
  session_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
  force_stopped: number;
  usage_json: string | null;
}

export interface AutomationRunListOptions {
  automationId?: string;
  limit?: number;
}

export function defaultAutomationDatabasePath(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  return join(piWebDataDir(env, cwd), "automations.sqlite");
}

export class AutomationStore {
  private readonly db: Database.Database;
  private readonly databasePath: string;
  private runtimeOwnership: { lockPath: string; token: string } | undefined;

  constructor(path = defaultAutomationDatabasePath()) {
    this.databasePath = path;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    if (path !== ":memory:") this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  acquireRuntimeOwnership(): void {
    if (this.databasePath === ":memory:" || this.runtimeOwnership !== undefined) return;
    const lockPath = `${this.databasePath}.owner`;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const token = randomUUID();
      const temporaryPath = `${lockPath}.${String(process.pid)}.${token}.tmp`;
      const owner = JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() });
      writeFileSync(temporaryPath, owner, { encoding: "utf8", flag: "wx", mode: 0o600, flush: true });
      try {
        linkSync(temporaryPath, lockPath);
        this.runtimeOwnership = { lockPath, token };
        return;
      } catch (error) {
        if (nodeErrorCode(error) !== "EEXIST") throw error;
        if (!removeStaleRuntimeOwner(lockPath)) {
          throw new Error(`Automation runtime is already owned by another session daemon: ${lockPath}`, { cause: error });
        }
      } finally {
        try { unlinkSync(temporaryPath); } catch { /* best-effort cleanup of the unpublished owner candidate */ }
      }
    }
    throw new Error(`Could not acquire automation runtime ownership: ${lockPath}`);
  }

  close(): void {
    if (this.db.open) this.db.close();
    this.releaseRuntimeOwnership();
  }

  private releaseRuntimeOwnership(): void {
    const ownership = this.runtimeOwnership;
    this.runtimeOwnership = undefined;
    if (ownership === undefined) return;
    try {
      const owner = parseRuntimeOwner(readFileSync(ownership.lockPath, "utf8"));
      if (owner?.token === ownership.token) unlinkSync(ownership.lockPath);
    } catch (error) {
      if (nodeErrorCode(error) !== "ENOENT") return;
    }
  }

  listDefinitions(projectId: string, workspaceId: string): AutomationDefinition[] {
    const rows = this.db.prepare<[string, string], AutomationRow>(`
      SELECT * FROM automations
      WHERE project_id = ? AND workspace_id = ? AND deleted_at IS NULL
      ORDER BY name COLLATE NOCASE, created_at
    `).all(projectId, workspaceId);
    return rows.map(automationFromRow);
  }

  getDefinition(id: string): AutomationDefinition | undefined {
    const row = this.db.prepare<[string], AutomationRow>("SELECT * FROM automations WHERE id = ? AND deleted_at IS NULL").get(id);
    return row === undefined ? undefined : automationFromRow(row);
  }

  getDefinitionScoped(id: string, projectId: string, workspaceId: string): AutomationDefinition | undefined {
    const row = this.db.prepare<[string, string, string], AutomationRow>(`
      SELECT * FROM automations
      WHERE id = ? AND project_id = ? AND workspace_id = ? AND deleted_at IS NULL
    `).get(id, projectId, workspaceId);
    return row === undefined ? undefined : automationFromRow(row);
  }

  insertDefinition(definition: AutomationDefinition): AutomationDefinition {
    try {
      this.db.prepare(`
        INSERT INTO automations (
          id, project_id, workspace_id, workspace_path, name, description, prompt, enabled,
          revision, tested_revision, trigger_json, model_json, thinking_json, timeout_ms,
          abort_grace_ms, next_run_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        definition.id,
        definition.projectId,
        definition.workspaceId,
        definition.workspacePath,
        definition.name,
        definition.description ?? null,
        definition.prompt,
        definition.enabled ? 1 : 0,
        definition.revision,
        definition.testedRevision ?? null,
        stringify(definition.trigger),
        stringify(definition.model),
        stringify(definition.thinking),
        definition.timeoutMs,
        definition.abortGraceMs,
        definition.nextRunAt ?? null,
        definition.createdAt,
        definition.updatedAt,
      );
    } catch (error) {
      throw translateConstraint(error, `An automation named "${definition.name}" already exists`);
    }
    return definition;
  }

  replaceDefinition(definition: AutomationDefinition, expectedRevision: number): AutomationDefinition {
    try {
      const result = this.db.prepare(`
        UPDATE automations SET
          workspace_path = ?, name = ?, description = ?, prompt = ?, enabled = ?, revision = ?,
          tested_revision = ?, trigger_json = ?, model_json = ?, thinking_json = ?, timeout_ms = ?,
          abort_grace_ms = ?, next_run_at = ?, updated_at = ?
        WHERE id = ? AND project_id = ? AND workspace_id = ? AND revision = ? AND deleted_at IS NULL
      `).run(
        definition.workspacePath,
        definition.name,
        definition.description ?? null,
        definition.prompt,
        definition.enabled ? 1 : 0,
        definition.revision,
        definition.testedRevision ?? null,
        stringify(definition.trigger),
        stringify(definition.model),
        stringify(definition.thinking),
        definition.timeoutMs,
        definition.abortGraceMs,
        definition.nextRunAt ?? null,
        definition.updatedAt,
        definition.id,
        definition.projectId,
        definition.workspaceId,
        expectedRevision,
      );
      if (result.changes !== 1) throw new Error("Automation was changed by another client");
    } catch (error) {
      throw translateConstraint(error, `An automation named "${definition.name}" already exists`);
    }
    return definition;
  }

  archiveDefinition(id: string, projectId: string, workspaceId: string, at: string): boolean {
    return this.db.transaction(() => {
      if (this.hasActiveRun(id)) throw new Error("Cannot delete an automation while it has an active run");
      const result = this.db.prepare(`
        UPDATE automations SET enabled = 0, deleted_at = ?, updated_at = ?
        WHERE id = ? AND project_id = ? AND workspace_id = ? AND deleted_at IS NULL
      `).run(at, at, id, projectId, workspaceId);
      return result.changes === 1;
    })();
  }

  listDueDefinitions(now: string): AutomationDefinition[] {
    const rows = this.db.prepare<[string], AutomationRow>(`
      SELECT * FROM automations
      WHERE deleted_at IS NULL AND enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
      ORDER BY next_run_at, created_at
    `).all(now);
    return rows.map(automationFromRow);
  }

  claimScheduledOccurrence(definition: AutomationDefinition, nextRunAt: string | undefined, now: string, runId: string): AutomationRun {
    return this.db.transaction(() => {
      const current = this.getDefinition(definition.id);
      if (current === undefined || !current.enabled || current.revision !== definition.revision || current.nextRunAt !== definition.nextRunAt) {
        throw new Error("Automation schedule changed before the occurrence could be claimed");
      }
      const overlapping = this.hasActiveRun(definition.id);
      const run = runFromDefinition(definition, {
        id: runId,
        source: "scheduled",
        scheduledFor: definition.nextRunAt ?? now,
        queuedAt: now,
        status: overlapping ? "skipped" : "queued",
        ...(overlapping ? { completedAt: now, reason: "overlap" } : {}),
      });
      this.insertRun(run);
      this.db.prepare(`
        UPDATE automations SET next_run_at = ?, enabled = ?, updated_at = ?
        WHERE id = ? AND revision = ? AND next_run_at = ?
      `).run(nextRunAt ?? null, nextRunAt === undefined ? 0 : 1, now, definition.id, definition.revision, definition.nextRunAt);
      return run;
    })();
  }

  createManualRun(definition: AutomationDefinition, runId: string, now: string): AutomationRun {
    return this.db.transaction(() => {
      if (this.hasActiveRun(definition.id)) throw new Error("Automation already has an active run");
      const run = runFromDefinition(definition, { id: runId, source: "manual", scheduledFor: now, queuedAt: now, status: "queued" });
      this.insertRun(run);
      return run;
    })();
  }

  listQueuedRuns(limit = 20): AutomationRun[] {
    const rows = this.db.prepare<[number], RunRow>(`
      SELECT * FROM automation_runs WHERE status = 'queued' ORDER BY queued_at LIMIT ?
    `).all(limit);
    return rows.map((row) => this.runFromRow(row));
  }

  listRuns(projectId: string, workspaceId: string, options: AutomationRunListOptions = {}): AutomationRun[] {
    const limit = Math.min(Math.max(options.limit ?? 200, 1), 500);
    const rows = options.automationId === undefined
      ? this.db.prepare<[string, string, number], RunRow>(`
          SELECT * FROM automation_runs
          WHERE project_id = ? AND workspace_id = ?
          ORDER BY queued_at DESC LIMIT ?
        `).all(projectId, workspaceId, limit)
      : this.db.prepare<[string, string, string, number], RunRow>(`
          SELECT * FROM automation_runs
          WHERE project_id = ? AND workspace_id = ? AND automation_id = ?
          ORDER BY queued_at DESC LIMIT ?
        `).all(projectId, workspaceId, options.automationId, limit);
    return rows.map((row) => this.runFromRow(row));
  }

  getRun(id: string): AutomationRun | undefined {
    const row = this.db.prepare<[string], RunRow>("SELECT * FROM automation_runs WHERE id = ?").get(id);
    return row === undefined ? undefined : this.runFromRow(row);
  }

  getRunScoped(id: string, projectId: string, workspaceId: string): AutomationRun | undefined {
    const row = this.db.prepare<[string, string, string], RunRow>(`
      SELECT * FROM automation_runs WHERE id = ? AND project_id = ? AND workspace_id = ?
    `).get(id, projectId, workspaceId);
    return row === undefined ? undefined : this.runFromRow(row);
  }

  markRunStarting(runId: string, attemptId: string, at: string): AutomationRun | undefined {
    return this.db.transaction(() => {
      const result = this.db.prepare("UPDATE automation_runs SET status = 'starting' WHERE id = ? AND status = 'queued'").run(runId);
      if (result.changes !== 1) return undefined;
      this.db.prepare(`
        INSERT INTO automation_attempts (id, run_id, attempt_number, status, started_at)
        VALUES (?, ?, 1, 'starting', ?)
      `).run(attemptId, runId, at);
      return this.requireRun(runId);
    })();
  }

  markRunRunning(runId: string, input: {
    sessionId: string;
    actualModel?: SessionModel;
    actualThinkingLevel?: string;
    startedAt: string;
    deadlineAt: string;
  }): AutomationRun {
    return this.db.transaction(() => {
      const result = this.db.prepare(`
        UPDATE automation_runs SET status = CASE WHEN status = 'starting' THEN 'running' ELSE status END,
          session_id = ?, actual_model_json = ?, actual_thinking_level = ?, started_at = ?, deadline_at = ?
        WHERE id = ? AND status IN ('starting', 'cancelling')
      `).run(
        input.sessionId,
        input.actualModel === undefined ? null : stringify(input.actualModel),
        input.actualThinkingLevel ?? null,
        input.startedAt,
        input.deadlineAt,
        runId,
      );
      if (result.changes === 1) {
        this.db.prepare(`
          UPDATE automation_attempts SET status = CASE WHEN status = 'starting' THEN 'running' ELSE status END,
            session_id = ?, started_at = ?
          WHERE run_id = ? AND attempt_number = 1 AND status IN ('starting', 'aborting')
        `).run(input.sessionId, input.startedAt, runId);
      }
      return this.requireRun(runId);
    })();
  }

  requestCancellation(runId: string, kind: "user" | "timeout", at: string): AutomationRun {
    return this.db.transaction(() => {
      const current = this.requireRun(runId);
      if (isTerminalRunStatus(current.status)) return current;
      if (current.status === "queued") {
        this.db.prepare(`
          UPDATE automation_runs SET status = ?, completed_at = ?, cancel_requested_at = ?, cancellation_kind = ?, reason = ?
          WHERE id = ? AND status = 'queued'
        `).run(kind === "timeout" ? "timed_out" : "cancelled", at, at, kind, kind, runId);
        return this.requireRun(runId);
      }
      this.db.prepare(`
        UPDATE automation_runs SET status = 'cancelling', cancel_requested_at = COALESCE(cancel_requested_at, ?),
          cancellation_kind = COALESCE(cancellation_kind, ?), reason = COALESCE(reason, ?)
        WHERE id = ? AND status IN ('starting', 'running', 'cancelling')
      `).run(at, kind, kind, runId);
      this.db.prepare(`
        UPDATE automation_attempts SET status = 'aborting'
        WHERE run_id = ? AND status IN ('starting', 'running', 'aborting')
      `).run(runId);
      return this.requireRun(runId);
    })();
  }

  finishRun(runId: string, input: {
    status: Extract<AutomationRunStatus, "completed" | "failed" | "cancelled" | "timed_out" | "unknown">;
    completedAt: string;
    error?: string;
    reason?: string;
    usage?: AutomationUsageSnapshot;
    forceStopped?: boolean;
  }): AutomationRun {
    return this.db.transaction(() => {
      const current = this.requireRun(runId);
      if (isTerminalRunStatus(current.status)) return current;
      const result = this.db.prepare(`
        UPDATE automation_runs SET status = ?, completed_at = ?, error = ?, reason = ?, usage_json = ?
        WHERE id = ? AND status IN ('starting', 'running', 'cancelling')
      `).run(
        input.status,
        input.completedAt,
        input.error ?? null,
        input.reason ?? null,
        input.usage === undefined ? null : stringify(input.usage),
        runId,
      );
      if (result.changes !== 1) return this.requireRun(runId);
      this.db.prepare(`
        UPDATE automation_attempts SET status = ?, completed_at = ?, error = ?, force_stopped = ?, usage_json = ?
        WHERE run_id = ? AND attempt_number = 1
      `).run(
        attemptStatusFromRun(input.status),
        input.completedAt,
        input.error ?? null,
        input.forceStopped === true ? 1 : 0,
        input.usage === undefined ? null : stringify(input.usage),
        runId,
      );
      if (input.status === "completed" && current.source === "manual") {
        this.db.prepare(`
          UPDATE automations SET tested_revision = ?, updated_at = ?
          WHERE id = ? AND revision = ? AND deleted_at IS NULL
        `).run(current.automationRevision, input.completedAt, current.automationId, current.automationRevision);
      }
      return this.requireRun(runId);
    })();
  }

  recoverInterruptedRuns(at: string): AutomationRun[] {
    return this.db.transaction(() => {
      const rows = this.db.prepare<[], RunRow>(`
        SELECT * FROM automation_runs WHERE status IN ('starting', 'running', 'cancelling')
      `).all();
      for (const row of rows) {
        this.db.prepare(`
          UPDATE automation_runs SET status = 'unknown', completed_at = ?, reason = 'daemon_restart',
            error = 'The session daemon restarted before run completion could be confirmed'
          WHERE id = ? AND status IN ('starting', 'running', 'cancelling')
        `).run(at, row.id);
        this.db.prepare(`
          UPDATE automation_attempts SET status = 'unknown', completed_at = ?,
            error = 'The session daemon restarted before attempt completion could be confirmed'
          WHERE run_id = ? AND status IN ('starting', 'running', 'aborting')
        `).run(at, row.id);
      }
      return rows.map((row) => this.requireRun(row.id));
    })();
  }

  hasActiveRun(automationId: string): boolean {
    const placeholders = ACTIVE_RUN_STATUSES.map(() => "?").join(", ");
    const row = this.db.prepare<unknown[], { found: number }>(`
      SELECT 1 AS found FROM automation_runs
      WHERE automation_id = ? AND status IN (${placeholders}) LIMIT 1
    `).get(automationId, ...ACTIVE_RUN_STATUSES);
    return row !== undefined;
  }

  private insertRun(run: AutomationRun): void {
    this.db.prepare(`
      INSERT INTO automation_runs (
        id, automation_id, automation_revision, automation_name, project_id, workspace_id,
        workspace_path, source, scheduled_for, status, prompt, trigger_json,
        configured_model_json, configured_thinking_json, timeout_ms, queued_at,
        completed_at, reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.id,
      run.automationId,
      run.automationRevision,
      run.automationName,
      run.projectId,
      run.workspaceId,
      run.workspacePath,
      run.source,
      run.scheduledFor,
      run.status,
      run.prompt,
      stringify(run.trigger),
      stringify(run.configuredModel),
      stringify(run.configuredThinking),
      run.timeoutMs,
      run.queuedAt,
      run.completedAt ?? null,
      run.reason ?? null,
    );
  }

  private requireRun(id: string): AutomationRun {
    const run = this.getRun(id);
    if (run === undefined) throw new Error("Automation run not found");
    return run;
  }

  private runFromRow(row: RunRow): AutomationRun {
    const attemptRow = this.db.prepare<[string], AttemptRow>(`
      SELECT * FROM automation_attempts WHERE run_id = ? ORDER BY attempt_number DESC LIMIT 1
    `).get(row.id);
    return runFromRow(row, attemptRow);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS automation_schema (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      ) STRICT;
    `);
    const current = this.db.prepare<[], { version: number | null }>("SELECT MAX(version) AS version FROM automation_schema").get();
    if (current === undefined) throw new Error("Could not read automations database schema version");
    if ((current.version ?? 0) > 1) throw new Error(`Unsupported automations database schema: ${String(current.version)}`);
    if ((current.version ?? 0) === 1) return;
    this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE automations (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          workspace_path TEXT NOT NULL,
          name TEXT NOT NULL,
          description TEXT,
          prompt TEXT NOT NULL,
          enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
          revision INTEGER NOT NULL CHECK (revision > 0),
          tested_revision INTEGER,
          trigger_json TEXT NOT NULL,
          model_json TEXT NOT NULL,
          thinking_json TEXT NOT NULL,
          timeout_ms INTEGER NOT NULL CHECK (timeout_ms > 0),
          abort_grace_ms INTEGER NOT NULL CHECK (abort_grace_ms > 0),
          next_run_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          deleted_at TEXT
        ) STRICT;
        CREATE UNIQUE INDEX automations_scope_name_active
          ON automations(project_id, workspace_id, name COLLATE NOCASE)
          WHERE deleted_at IS NULL;
        CREATE INDEX automations_due ON automations(enabled, next_run_at) WHERE deleted_at IS NULL;

        CREATE TABLE automation_runs (
          id TEXT PRIMARY KEY,
          automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE RESTRICT,
          automation_revision INTEGER NOT NULL,
          automation_name TEXT NOT NULL,
          project_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          workspace_path TEXT NOT NULL,
          source TEXT NOT NULL CHECK (source IN ('manual', 'scheduled')),
          scheduled_for TEXT NOT NULL,
          status TEXT NOT NULL,
          prompt TEXT NOT NULL,
          trigger_json TEXT NOT NULL,
          configured_model_json TEXT NOT NULL,
          configured_thinking_json TEXT NOT NULL,
          actual_model_json TEXT,
          actual_thinking_level TEXT,
          timeout_ms INTEGER NOT NULL,
          queued_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT,
          deadline_at TEXT,
          cancel_requested_at TEXT,
          cancellation_kind TEXT,
          session_id TEXT,
          reason TEXT,
          error TEXT,
          usage_json TEXT
        ) STRICT;
        CREATE UNIQUE INDEX automation_scheduled_occurrence
          ON automation_runs(automation_id, automation_revision, scheduled_for)
          WHERE source = 'scheduled';
        CREATE INDEX automation_runs_scope_history
          ON automation_runs(project_id, workspace_id, queued_at DESC);
        CREATE INDEX automation_runs_active
          ON automation_runs(automation_id, status);

        CREATE TABLE automation_attempts (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES automation_runs(id) ON DELETE RESTRICT,
          attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
          status TEXT NOT NULL,
          session_id TEXT,
          started_at TEXT,
          completed_at TEXT,
          error TEXT,
          force_stopped INTEGER NOT NULL DEFAULT 0 CHECK (force_stopped IN (0, 1)),
          usage_json TEXT,
          UNIQUE(run_id, attempt_number)
        ) STRICT;
        INSERT INTO automation_schema(version, applied_at) VALUES (1, datetime('now'));
      `);
    })();
  }
}

function automationFromRow(row: AutomationRow): AutomationDefinition {
  return {
    id: row.id,
    projectId: row.project_id,
    workspaceId: row.workspace_id,
    workspacePath: row.workspace_path,
    name: row.name,
    ...(row.description === null ? {} : { description: row.description }),
    prompt: row.prompt,
    enabled: row.enabled === 1,
    revision: row.revision,
    ...(row.tested_revision === null ? {} : { testedRevision: row.tested_revision }),
    trigger: parseStoredTrigger(row.trigger_json),
    model: parseStoredModel(row.model_json),
    thinking: parseStoredThinking(row.thinking_json),
    timeoutMs: row.timeout_ms,
    abortGraceMs: row.abort_grace_ms,
    ...(row.next_run_at === null ? {} : { nextRunAt: row.next_run_at }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function runFromRow(row: RunRow, attemptRow: AttemptRow | undefined): AutomationRun {
  return {
    id: row.id,
    automationId: row.automation_id,
    automationRevision: row.automation_revision,
    automationName: row.automation_name,
    projectId: row.project_id,
    workspaceId: row.workspace_id,
    workspacePath: row.workspace_path,
    source: row.source === "scheduled" ? "scheduled" : "manual",
    scheduledFor: row.scheduled_for,
    status: requireRunStatus(row.status),
    prompt: row.prompt,
    trigger: parseStoredTrigger(row.trigger_json),
    configuredModel: parseStoredModel(row.configured_model_json),
    configuredThinking: parseStoredThinking(row.configured_thinking_json),
    ...(row.actual_model_json === null ? {} : { actualModel: parseStoredSessionModel(row.actual_model_json) }),
    ...(row.actual_thinking_level === null ? {} : { actualThinkingLevel: row.actual_thinking_level }),
    timeoutMs: row.timeout_ms,
    queuedAt: row.queued_at,
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    ...(row.deadline_at === null ? {} : { deadlineAt: row.deadline_at }),
    ...(row.cancel_requested_at === null ? {} : { cancelRequestedAt: row.cancel_requested_at }),
    ...(row.cancellation_kind === "user" || row.cancellation_kind === "timeout" ? { cancellationKind: row.cancellation_kind } : {}),
    ...(row.session_id === null ? {} : { sessionId: row.session_id }),
    ...(row.reason === null ? {} : { reason: row.reason }),
    ...(row.error === null ? {} : { error: row.error }),
    ...(row.usage_json === null ? {} : { usage: parseStoredUsage(row.usage_json) }),
    ...(attemptRow === undefined ? {} : { attempt: attemptFromRow(attemptRow) }),
  };
}

function attemptFromRow(row: AttemptRow): AutomationAttempt {
  return {
    id: row.id,
    runId: row.run_id,
    attemptNumber: row.attempt_number,
    status: requireAttemptStatus(row.status),
    ...(row.session_id === null ? {} : { sessionId: row.session_id }),
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    ...(row.error === null ? {} : { error: row.error }),
    forceStopped: row.force_stopped === 1,
    ...(row.usage_json === null ? {} : { usage: parseStoredUsage(row.usage_json) }),
  };
}

function runFromDefinition(definition: AutomationDefinition, input: Pick<AutomationRun, "id" | "source" | "scheduledFor" | "queuedAt" | "status"> & Partial<Pick<AutomationRun, "completedAt" | "reason">>): AutomationRun {
  return {
    id: input.id,
    automationId: definition.id,
    automationRevision: definition.revision,
    automationName: definition.name,
    projectId: definition.projectId,
    workspaceId: definition.workspaceId,
    workspacePath: definition.workspacePath,
    source: input.source,
    scheduledFor: input.scheduledFor,
    status: input.status,
    prompt: definition.prompt,
    trigger: definition.trigger,
    configuredModel: definition.model,
    configuredThinking: definition.thinking,
    timeoutMs: definition.timeoutMs,
    queuedAt: input.queuedAt,
    ...(input.completedAt === undefined ? {} : { completedAt: input.completedAt }),
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  };
}

function attemptStatusFromRun(status: AutomationRunStatus): AutomationAttemptStatus {
  if (status === "completed") return "completed";
  if (status === "cancelled") return "cancelled";
  if (status === "timed_out") return "timed_out";
  if (status === "unknown") return "unknown";
  return "failed";
}

function requireRunStatus(value: string): AutomationRunStatus {
  const statuses: readonly AutomationRunStatus[] = [...ACTIVE_RUN_STATUSES, ...TERMINAL_RUN_STATUSES];
  const status = statuses.find((candidate) => candidate === value);
  if (status === undefined) throw new Error(`Invalid automation run status in database: ${value}`);
  return status;
}

function requireAttemptStatus(value: string): AutomationAttemptStatus {
  const statuses: readonly AutomationAttemptStatus[] = ["starting", "running", "aborting", "completed", "failed", "cancelled", "timed_out", "unknown"];
  const status = statuses.find((candidate) => candidate === value);
  if (status === undefined) throw new Error(`Invalid automation attempt status in database: ${value}`);
  return status;
}

export function isTerminalRunStatus(status: AutomationRunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

function removeStaleRuntimeOwner(lockPath: string): boolean {
  try {
    const stats = lstatSync(lockPath);
    if (!stats.isFile() || stats.isSymbolicLink()) return false;
    const owner = parseRuntimeOwner(readFileSync(lockPath, "utf8"));
    if (owner === undefined || processIsAlive(owner.pid)) return false;
    try {
      unlinkSync(lockPath);
    } catch (error) {
      if (nodeErrorCode(error) !== "ENOENT") throw error;
    }
    return true;
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return true;
    throw error;
  }
}

function parseRuntimeOwner(value: string): { pid: number; token: string } | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || !("pid" in parsed) || !("token" in parsed)) return undefined;
    const pid = parsed.pid;
    const token = parsed.token;
    return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 && typeof token === "string" && token !== ""
      ? { pid, token }
      : undefined;
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return nodeErrorCode(error) === "EPERM";
  }
}

function nodeErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function stringify(value: unknown): string {
  return JSON.stringify(value);
}

function parseStoredTrigger(value: string): AutomationTrigger {
  const record = parseStoredRecord(value);
  const type = storedString(record, "type");
  if (type === "manual") return { type };
  if (type === "once") return { type, at: storedString(record, "at") };
  if (type === "interval") return { type, intervalMs: storedNumber(record, "intervalMs") };
  if (type === "cron") return { type, expression: storedString(record, "expression"), timeZone: storedString(record, "timeZone") };
  throw new Error(`Invalid automation trigger in database: ${type}`);
}

function parseStoredModel(value: string): AutomationModelPolicy {
  const record = parseStoredRecord(value);
  const mode = storedString(record, "mode");
  if (mode === "default") return { mode };
  if (mode !== "fixed") throw new Error(`Invalid automation model policy in database: ${mode}`);
  const name = storedOptionalString(record, "name");
  return {
    mode,
    provider: storedString(record, "provider"),
    id: storedString(record, "id"),
    ...(name === undefined ? {} : { name }),
  };
}

function parseStoredThinking(value: string): AutomationThinkingPolicy {
  const record = parseStoredRecord(value);
  const mode = storedString(record, "mode");
  if (mode === "default") return { mode };
  if (mode === "fixed") return { mode, level: storedString(record, "level") };
  throw new Error(`Invalid automation thinking policy in database: ${mode}`);
}

function parseStoredSessionModel(value: string): SessionModel {
  const record = parseStoredRecord(value);
  const provider = storedOptionalString(record, "provider");
  const id = storedOptionalString(record, "id");
  const name = storedOptionalString(record, "name");
  const contextWindow = storedOptionalNumber(record, "contextWindow");
  return {
    ...(provider === undefined ? {} : { provider }),
    ...(id === undefined ? {} : { id }),
    ...(name === undefined ? {} : { name }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(record["reasoning"] === undefined ? {} : { reasoning: record["reasoning"] }),
  };
}

function parseStoredUsage(value: string): AutomationUsageSnapshot {
  const record = parseStoredRecord(value);
  const scope = storedString(record, "scope");
  const quality = storedString(record, "quality");
  if (scope !== "root_session") throw new Error(`Invalid automation usage scope in database: ${scope}`);
  if (quality !== "estimated" && quality !== "partial" && quality !== "provider_reported" && quality !== "unknown") {
    throw new Error(`Invalid automation usage quality in database: ${quality}`);
  }
  const tokens = storedRecord(record, "tokens");
  const estimatedCostMicros = storedOptionalNumber(record, "estimatedCostMicros");
  return {
    scope,
    quality,
    tokens: {
      input: storedNumber(tokens, "input"),
      output: storedNumber(tokens, "output"),
      cacheRead: storedNumber(tokens, "cacheRead"),
      cacheWrite: storedNumber(tokens, "cacheWrite"),
      total: storedNumber(tokens, "total"),
    },
    ...(estimatedCostMicros === undefined ? {} : { estimatedCostMicros }),
    capturedAt: storedString(record, "capturedAt"),
  };
}

function parseStoredRecord(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed)) throw new Error("Expected an object in automations database JSON");
  return parsed;
}

function storedRecord(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  if (!isRecord(value)) throw new Error(`Expected object field in automations database: ${key}`);
  return value;
}

function storedString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`Expected string field in automations database: ${key}`);
  return value;
}

function storedOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  return record[key] === undefined ? undefined : storedString(record, key);
}

function storedNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Expected number field in automations database: ${key}`);
  return value;
}

function storedOptionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  return record[key] === undefined ? undefined : storedNumber(record, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function translateConstraint(error: unknown, message: string): Error {
  if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) return new Error(message);
  return error instanceof Error ? error : new Error(String(error));
}
