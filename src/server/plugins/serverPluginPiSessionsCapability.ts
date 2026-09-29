import {
  PI_WEB_HOST_PI_SESSIONS_CAPABILITY,
  type PiWebHostPiSessionCreated,
  type PiWebHostWorkspaceSelection,
  type PiWebHostPiSessionRun,
  type PiWebHostPiSessionRunCompletion,
  type PiWebHostPiSessionRunInput,
  type PiWebHostPiSessionsV1,
} from "../../server-plugin-api.js";
import type { ProjectService } from "../projects/projectService.js";
import type { WorkspaceProviderRegistry } from "../workspaces/workspaceProviderRegistry.js";
import type { ServerPluginHostCapabilityContext, ServerPluginHostCapabilityFactory } from "./serverPluginRuntime.js";
import { createServerPluginWorkspacesCapabilityFactory } from "./serverPluginWorkspacesCapability.js";

const DEFAULT_MAX_CONCURRENT_RUNS_PER_PLUGIN = 4;
const COMPLETION_ERROR_MAX_BYTES = 4 * 1024;

interface HostPiSessionService {
  createHostedSession(cwd: string, signal: AbortSignal): Promise<{ readonly id: string }>;
  startOneShotRun(
    cwd: string,
    prompt: string,
    signal: AbortSignal,
  ): Promise<{ readonly id: string; readonly completion: Promise<void> }>;
}

export interface CreateServerPluginPiSessionsCapabilityOptions {
  readonly projects: Pick<ProjectService, "requireProject">;
  readonly workspaces: Pick<WorkspaceProviderRegistry, "resolve">;
  readonly sessions: HostPiSessionService;
  /** Test/host tuning seam; production uses the conservative default. */
  readonly maxConcurrentRunsPerPlugin?: number;
}

interface RunAdmission {
  readonly settled: Promise<void>;
  settle(): void;
}

/** Creates package-attributed PI session admission over host-owned services. */
export function createServerPluginPiSessionsCapabilityFactory(
  options: CreateServerPluginPiSessionsCapabilityOptions,
): ServerPluginHostCapabilityFactory<PiWebHostPiSessionsV1> {
  const maxConcurrentRuns = positiveInteger(
    options.maxConcurrentRunsPerPlugin,
    DEFAULT_MAX_CONCURRENT_RUNS_PER_PLUGIN,
    "maxConcurrentRunsPerPlugin",
  );
  const workspaceFactory = createServerPluginWorkspacesCapabilityFactory(options);

  return Object.freeze({
    capability: PI_WEB_HOST_PI_SESSIONS_CAPABILITY,
    create(context: ServerPluginHostCapabilityContext) {
      const workspaceAuthority = workspaceFactory.create(context).value;
      const admissions = new Set<RunAdmission>();
      const startupLifetime = new AbortController();
      let revoked = false;

      const revoke = (): void => {
        if (revoked) return;
        revoked = true;
        // Only unpublished startup belongs to the plugin. The service stops
        // observing this signal when it publishes the hosted conversation.
        startupLifetime.abort(context.lifetimeSignal.reason);
      };

      const lifetimeAbort = (): void => { revoke(); };
      if (context.lifetimeSignal.aborted) revoke();
      else context.lifetimeSignal.addEventListener("abort", lifetimeAbort, { once: true });

      const value: PiWebHostPiSessionsV1 = Object.freeze({
        version: 1,
        create: async (input: PiWebHostWorkspaceSelection): Promise<PiWebHostPiSessionCreated> => {
          assertActive(context, revoked);
          if (admissions.size >= maxConcurrentRuns) {
            throw capabilityError(context.pluginId, `reached its limit of ${String(maxConcurrentRuns)} concurrent runs`);
          }
          const admission = createAdmission();
          admissions.add(admission);
          try {
            const authority = await workspaceAuthority.resolve(input);
            assertActive(context, revoked);
            let created: { readonly id: string };
            try {
              created = await options.sessions.createHostedSession(authority.workspace.path, startupLifetime.signal);
            } catch (error) {
              if (revoked || context.lifetimeSignal.aborted) throw revokedError(context, error);
              throw capabilityError(context.pluginId, "could not create a PI session", error);
            }
            // Publication already transferred ownership, even if disposal won this await.
            assertActive(context, revoked);
            return Object.freeze({ sessionId: created.id });
          } finally {
            admissions.delete(admission);
            admission.settle();
          }
        },
        run: async (input: PiWebHostPiSessionRunInput): Promise<PiWebHostPiSessionRun> => {
          assertActive(context, revoked);
          if (admissions.size >= maxConcurrentRuns) {
            throw capabilityError(
              context.pluginId,
              `reached its limit of ${String(maxConcurrentRuns)} concurrent runs`,
            );
          }

          const admission = createAdmission();
          admissions.add(admission);
          let handedOffCompletion = false;
          try {
            const authority = await workspaceAuthority.resolve({
              projectId: input.projectId,
              workspaceId: input.workspaceId,
            });
            assertActive(context, revoked);

            let started: { readonly id: string; readonly completion: Promise<void> };
            try {
              started = await options.sessions.startOneShotRun(
                authority.workspace.path,
                input.prompt,
                startupLifetime.signal,
              );
            } catch (error) {
              if (revoked || context.lifetimeSignal.aborted) {
                throw revokedError(context, error);
              }
              throw capabilityError(context.pluginId, "could not start a PI session", error);
            }
            // Always consume the outcome, even if revocation wins this await.
            // A returned session is already published and must not be reclaimed.
            const completion = completeRun(started.completion)
              .finally(() => { admissions.delete(admission); });
            handedOffCompletion = true;
            assertActive(context, revoked);
            return Object.freeze({ sessionId: started.id, completion });
          } finally {
            if (!handedOffCompletion) admissions.delete(admission);
            admission.settle();
          }
        },
      });

      return Object.freeze({
        value,
        async dispose(signal: AbortSignal): Promise<void> {
          revoke();
          context.lifetimeSignal.removeEventListener("abort", lifetimeAbort);
          await waitForSettled([...admissions].map(({ settled }) => settled), signal);
        },
      });
    },
  });
}

async function completeRun(runCompletion: Promise<void>): Promise<PiWebHostPiSessionRunCompletion> {
  try {
    await runCompletion;
    return Object.freeze({ status: "completed" });
  } catch (error) {
    return error instanceof Error && error.name === "AbortError"
      ? Object.freeze({ status: "cancelled" })
      : failedCompletion(error);
  }
}

function createAdmission(): RunAdmission {
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => { settle = resolve; });
  return { settled, settle };
}

function failedCompletion(error: unknown): PiWebHostPiSessionRunCompletion {
  const message = error instanceof Error ? error.message : String(error);
  return Object.freeze({
    status: "failed",
    error: truncateUtf8(message === "" ? "PI session run failed" : message, COMPLETION_ERROR_MAX_BYTES),
  });
}

function assertActive(context: ServerPluginHostCapabilityContext, revoked: boolean): void {
  if (!revoked && !context.lifetimeSignal.aborted) return;
  throw revokedError(context);
}

function revokedError(context: ServerPluginHostCapabilityContext, cause: unknown = context.lifetimeSignal.reason): Error {
  return capabilityError(context.pluginId, "is no longer active", cause);
}

function capabilityError(pluginId: string, message: string, cause?: unknown): Error {
  return new Error(
    `PI WEB host PI session authority for server plugin ${pluginId} ${message}`,
    cause === undefined ? {} : { cause },
  );
}

async function waitForSettled(operations: readonly Promise<void>[], signal: AbortSignal): Promise<void> {
  if (operations.length === 0) return;
  if (signal.aborted) throw abortError(signal);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => { reject(abortError(signal)); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([Promise.allSettled(operations), aborted]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("PI WEB host PI session cleanup was aborted", "AbortError");
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) throw new Error(`${label} must be a positive integer`);
  return resolved;
}

function truncateUtf8(value: string, maxBytes: number): string {
  let bytes = 0;
  let output = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    const width = codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    if (bytes + width > maxBytes) break;
    output += character;
    bytes += width;
  }
  return output === "" ? "PI session run failed" : output;
}
