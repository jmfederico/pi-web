import {
  migrateLegacySessionArchive,
  type LegacySessionArchiveMigrationResult,
} from "../sessions/sessionArchiveMigration.js";

export interface SessionDaemonStartupLogger {
  debug(details: Record<string, unknown>, message: string): void;
  info(details: Record<string, unknown>, message: string): void;
  warn(details: Record<string, unknown>, message: string): void;
  error(details: Record<string, unknown>, message: string): void;
}

export interface SessionDaemonStartupSteps<Runtime> {
  logger: SessionDaemonStartupLogger;
  createRuntime(): Runtime | Promise<Runtime>;
  registerRoutes(runtime: Runtime): void;
  listen(runtime: Runtime): Promise<void>;
  migrateArchive?: () => Promise<LegacySessionArchiveMigrationResult>;
}

/**
 * Keeps archive migration ahead of every archive-state consumer in sessiond.
 * A failed eligible migration stops startup so runtime writes cannot make a
 * clean retry ambiguous; mutation-free eligibility skips still start normally.
 */
export async function runSessionDaemonStartup<Runtime>(
  steps: SessionDaemonStartupSteps<Runtime>,
): Promise<Runtime> {
  const result = await (steps.migrateArchive ?? migrateLegacySessionArchive)();
  reportMigrationResult(result, steps.logger);

  if (result.status === "failed") {
    throw new Error(
      `Legacy session archive migration failed during ${result.phase}; session daemon startup stopped`,
      { cause: result.error },
    );
  }

  const runtime = await steps.createRuntime();
  steps.registerRoutes(runtime);
  await steps.listen(runtime);
  return runtime;
}

function reportMigrationResult(
  result: LegacySessionArchiveMigrationResult,
  logger: SessionDaemonStartupLogger,
): void {
  if (result.status === "skipped") {
    if (result.reason === "inspection-failed") {
      logger.warn(
        { err: result.error, reason: result.reason },
        "could not inspect legacy session archive migration eligibility; continuing session daemon startup without migration",
      );
    } else {
      logger.debug(
        { reason: result.reason },
        "legacy session archive migration is not eligible; continuing session daemon startup",
      );
    }
    return;
  }

  if (result.status === "failed") {
    logger.error(
      {
        err: result.error,
        phase: result.phase,
        rollbackErrorCount: result.rollbackErrors.length,
        rollbackErrors: result.rollbackErrors,
      },
      result.rollbackErrors.length === 0
        ? "legacy session archive migration failed before commit; stopping session daemon startup"
        : "legacy session archive migration failed before commit and rollback was incomplete; stopping session daemon startup",
    );
    return;
  }

  if (result.cleanup === "incomplete") {
    logger.warn(
      {
        archiveFileCount: result.archiveFileCount,
        cleanupErrorCount: result.cleanupErrors.length,
        cleanupErrors: result.cleanupErrors,
      },
      "legacy session archive migration committed but cleanup was incomplete; continuing with the migrated destination archive",
    );
    return;
  }

  logger.info(
    { archiveFileCount: result.archiveFileCount },
    "migrated legacy session archive to the configured PI_WEB_DATA_DIR",
  );
}
