import { EventEmitter } from "node:events";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { Client, EnvHttpProxyAgent, Pool, setGlobalDispatcher, type Dispatcher } from "undici";

/**
 * HTTP idle timeout for the session daemon's embedded Pi runtime.
 *
 * undici's global dispatcher caps `bodyTimeout` and `headersTimeout` at
 * 300_000 ms by default, so any model response that stays idle for 5 minutes
 * (slow local backends such as vLLM producing a single chunk) dies with
 * `TypeError: terminated` — surfaced as "(SYSTEM) Model response failed:
 * terminated" (issue #113).
 *
 * The pi CLI avoids this by calling
 * `configureHttpDispatcher(settingsManager.getHttpIdleTimeoutMs())` at
 * bootstrap; the Pi SDK setting `httpIdleTimeoutMs` (agent profile
 * `settings.json`, default 300_000, `0` disables the idle timers) was simply
 * never applied by PI WEB's embedded session runtime. This module is that
 * missing step for the session daemon.
 *
 * The SDK's own `configureHttpDispatcher` lives in
 * `@earendil-works/pi-coding-agent/dist/core/http-dispatcher.js`, but the
 * package `exports` map blocks deep imports (`ERR_PACKAGE_PATH_NOT_EXPORTED`)
 * and nothing equivalent is re-exported, so the semantics are mirrored here.
 * The one deliberate deviation is skipping the SDK's `undici.install()` step,
 * which replaces `globalThis.fetch` with npm undici's fetch to work around
 * Node 26.0's bundled fetch failing to decompress responses read through an
 * npm dispatcher. A long-lived shared daemon should change the dispatcher,
 * not the fetch implementation every in-process consumer sees; built-in
 * fetch on Node 22/24 honors the global dispatcher without it. If a future
 * Node reintroduces the mismatch (symptom: `response.json()` failing on
 * compressed bodies), revisit. If the SDK ever exports
 * `configureHttpDispatcher`, prefer delegating to it.
 *
 * The value is applied once, at daemon start; changing `httpIdleTimeoutMs`
 * requires restarting the session daemon.
 */

const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000;

export interface AgentHttpDispatcherInput {
  /** Absolute path of the active Pi agent profile directory (holds settings.json). */
  agentDir: string;
  /** Working directory the SDK uses for project-level settings resolution. */
  cwd: string;
}

export interface AppliedAgentHttpIdleTimeout {
  timeoutMs: number;
  warning?: string;
}

/**
 * Read the active agent profile's `httpIdleTimeoutMs` through the SDK
 * `SettingsManager`, reusing its parsing, validation, and defaults
 * (`"disabled"` → 0, absent → 300_000, invalid → throws).
 */
export function resolveAgentHttpIdleTimeoutMs({ agentDir, cwd }: AgentHttpDispatcherInput): number {
  return SettingsManager.create(cwd, agentDir).getHttpIdleTimeoutMs();
}

// Undici can emit an internal Client "error" while terminating a mid-stream
// fetch body. The body stream still rejects through the response reader; this
// listener only prevents EventEmitter's unhandled "error" special case from
// crashing the daemon. `Dispatcher`'s typed event overloads hide the generic
// `EventEmitter.on`, so the listener is attached through the prototype.
const ignoreUndiciDispatcherError = (): void => { /* keep the daemon alive; see comment above */ };

function withUndiciErrorListener<T extends Dispatcher>(dispatcher: T): T {
  EventEmitter.prototype.on.call(dispatcher, "error", ignoreUndiciDispatcherError);
  return dispatcher;
}

function createUndiciClient(origin: URL, options: Client.Options): Client {
  return withUndiciErrorListener(new Client(origin, options));
}

function createUndiciOriginDispatcher(origin: URL, options: Pool.Options): Dispatcher {
  if (options.connections === 1) {
    return createUndiciClient(origin, options);
  }
  return withUndiciErrorListener(new Pool(origin, {
    ...options,
    factory: createUndiciClient,
  }));
}

/**
 * Install a global undici dispatcher that applies `timeoutMs` to both
 * `bodyTimeout` and `headersTimeout`, mirroring the SDK's
 * `configureHttpDispatcher`. `0` disables the idle timers (undici semantics).
 */
export function configureAgentHttpDispatcher(timeoutMs: number): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error(`Invalid HTTP idle timeout: ${String(timeoutMs)}`);
  }
  const normalizedTimeoutMs = Math.floor(timeoutMs);
  const dispatcher = withUndiciErrorListener(new EnvHttpProxyAgent({
    allowH2: false,
    bodyTimeout: normalizedTimeoutMs,
    headersTimeout: normalizedTimeoutMs,
    clientFactory: createUndiciClient,
    factory: createUndiciOriginDispatcher,
  }));
  setGlobalDispatcher(dispatcher);
}

/**
 * Resolve the agent profile's `httpIdleTimeoutMs` and install it on the
 * global dispatcher. Never throws: an unreadable or invalid setting falls
 * back to the 300_000 ms default and reports a warning for logging, so a bad
 * settings file cannot keep the daemon from starting.
 */
export function applyAgentHttpIdleTimeout({ agentDir, cwd }: AgentHttpDispatcherInput): AppliedAgentHttpIdleTimeout {
  let timeoutMs = DEFAULT_HTTP_IDLE_TIMEOUT_MS;
  let warning: string | undefined;
  try {
    timeoutMs = resolveAgentHttpIdleTimeoutMs({ agentDir, cwd });
  } catch (error) {
    warning = `Falling back to the ${String(DEFAULT_HTTP_IDLE_TIMEOUT_MS)} ms HTTP idle default because the agent profile httpIdleTimeoutMs could not be applied: ${describeError(error)}`;
  }
  configureAgentHttpDispatcher(timeoutMs);
  return warning === undefined ? { timeoutMs } : { timeoutMs, warning };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
