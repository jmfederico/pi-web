import { stat } from "node:fs/promises";
import type { TerminalCommandRun } from "../../shared/apiTypes.js";
import {
  requireWorkspaceCreationName,
  requireWorkspaceCreationParentPath,
  workspaceCreationMetadata,
  WORKSPACE_CREATION_OPERATION_TIMEOUT_MS,
} from "../../shared/workspaceCreation.js";
import type { Project } from "../types.js";
import type { RunTerminalCommandOptions } from "../terminals/terminalService.js";
import {
  WorkspaceProviderCreationError,
  type WorkspaceProviderCreationTarget,
} from "./workspaceProviderRegistry.js";

export interface WorkspaceCreationProvider {
  resolveCreation(project: Project, signal: AbortSignal): Promise<WorkspaceProviderCreationTarget>;
}

export interface WorkspaceCreationTerminalHost {
  runCommand(options: RunTerminalCommandOptions): TerminalCommandRun;
}

export interface WorkspaceCreationServiceOptions {
  timeoutMs?: number;
}

export interface WorkspaceCreationInput {
  parentPath: string;
  name: string;
}

export class WorkspaceCreationError extends Error {
  override name = "WorkspaceCreationError";

  constructor(message: string, readonly statusCode = 400, options: ErrorOptions = {}) {
    super(message, options);
  }
}

/**
 * Sessiond-owned creation orchestration. The provider validates and plans its
 * native operation; the host retains generic input validation and the visible
 * command-run contract, mirroring workspace removal.
 */
export class WorkspaceCreationService {
  private readonly timeoutMs: number;

  constructor(
    private readonly providers: WorkspaceCreationProvider,
    private readonly terminals: WorkspaceCreationTerminalHost,
    options: WorkspaceCreationServiceOptions = {},
  ) {
    this.timeoutMs = positiveInteger(options.timeoutMs ?? WORKSPACE_CREATION_OPERATION_TIMEOUT_MS, "timeoutMs");
  }

  async create(project: Project, input: WorkspaceCreationInput, signal?: AbortSignal): Promise<TerminalCommandRun> {
    let parentPath: string;
    let name: string;
    try {
      parentPath = requireWorkspaceCreationParentPath(input.parentPath);
      name = requireWorkspaceCreationName(input.name);
    } catch (error) {
      throw new WorkspaceCreationError(errorMessage(error), 400, { cause: error });
    }
    throwIfAborted(signal);

    const controller = new AbortController();
    const abortFromParent = (): void => { controller.abort(abortError(signal)); };
    signal?.addEventListener("abort", abortFromParent, { once: true });
    const timeout = setTimeout(
      () => { controller.abort(new WorkspaceCreationError(`Workspace creation timed out after ${String(this.timeoutMs)}ms`, 504)); },
      this.timeoutMs,
    );
    timeout.unref();

    try {
      const target = await this.providers.resolveCreation(project, controller.signal);
      throwIfAborted(controller.signal);
      await this.requireDirectory(parentPath);
      throwIfAborted(controller.signal);

      const plan = await target.prepare({ parentPath, name });
      throwIfAborted(controller.signal);

      try {
        return this.terminals.runCommand({
          origin: "core",
          projectId: project.id,
          workspaceId: target.mainWorkspace.id,
          cwd: target.mainWorkspace.path,
          title: plan.title,
          command: plan.command,
          metadata: workspaceCreationMetadata(name),
        });
      } catch (error) {
        throw new WorkspaceCreationError(`Failed to start workspace creation: ${errorMessage(error)}`, 400, { cause: error });
      }
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortFromParent);
    }
  }

  private async requireDirectory(parentPath: string): Promise<void> {
    let isDirectory: boolean;
    try {
      isDirectory = (await stat(parentPath)).isDirectory();
    } catch (error) {
      throw new WorkspaceCreationError(`Workspace parent directory is unavailable: ${errorMessage(error)}`, 400, { cause: error });
    }
    if (!isDirectory) throw new WorkspaceCreationError("Workspace parent path is not a directory");
  }
}

export function workspaceCreationHttpStatus(error: unknown, fallback = 500): number {
  if (error instanceof WorkspaceCreationError || error instanceof WorkspaceProviderCreationError) {
    return error.statusCode;
  }
  return fallback;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw abortError(signal);
}

function abortError(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  return reason instanceof Error ? reason : new Error("Workspace creation request cancelled", { cause: reason });
}

function positiveInteger(value: number, key: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${key} must be a positive integer`);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
