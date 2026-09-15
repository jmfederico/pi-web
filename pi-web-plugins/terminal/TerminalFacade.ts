import type {
  TerminalCommandRun,
  TerminalCommandRunHandle,
  ContributionQueryValue,
  QualifiedContributionId,
  TerminalCommandRunStatus,
  Workspace,
  PluginCapability,
  PluginPeer,
  WorkspacePanelTerminal,
  WorkspaceTerminalCommandInput,
} from "@jmfederico/pi-web/plugin-api";
import { TerminalPeerClient, parseTerminalCommandRun, type TerminalCommandRunFilter } from "./terminalProtocol";

type TimerId = ReturnType<typeof globalThis.setTimeout>;
type SetTimer = (handler: () => void, timeout: number) => TimerId;
type ClearTimer = (id: TimerId) => void;

export interface WorkspaceContributionNavigationV1 {
  readonly contributionId: QualifiedContributionId;
  readonly navigationAliases?: readonly QualifiedContributionId[];
  readonly query: Readonly<Record<string, ContributionQueryValue | undefined | null>>;
}

export interface RequiredTerminalFacadeHostV1 {
  navigateWorkspaceContribution(workspace: Workspace, navigation: WorkspaceContributionNavigationV1): void | Promise<void>;
}

export interface RequiredTerminalWorkspaceBindingV1 {
  readonly origin: string;
  readonly registrationPluginId: string;
  readonly workspace: Workspace;
  readonly peer: PluginPeer;
  readonly host: RequiredTerminalFacadeHostV1;
}

export interface RequiredTerminalCommandRunQueryV1 {
  readonly peer: PluginPeer;
  readonly filter?: Readonly<{
    terminalId?: string;
    statuses?: readonly TerminalCommandRunStatus[];
    metadata?: Readonly<Record<string, string>>;
  }>;
  readonly signal?: AbortSignal;
}

/** Hard-coded browser composition port returned only by the bundled Terminal entry. */
export interface RequiredTerminalBrowserFacadeV1 {
  readonly version: 1;
  createWorkspaceTerminal(binding: RequiredTerminalWorkspaceBindingV1): WorkspacePanelTerminal;
  listCommandRuns(query: RequiredTerminalCommandRunQueryV1): Promise<TerminalCommandRun[]>;
  parseCommandRun(value: unknown): TerminalCommandRun;
}

/** Package-owned token for Terminal's browser-side host composition surface. */
export const TERMINAL_BROWSER_FACADE_CAPABILITY = Object.freeze({
  pluginId: "pi-web.terminal",
  id: "browser-facade",
  version: 1,
  parse: snapshotTerminalBrowserFacade,
}) satisfies PluginCapability<RequiredTerminalBrowserFacadeV1, 1>;

export interface TerminalFacadeOptions {
  pollIntervalMs?: number;
  setTimeout?: SetTimer;
  clearTimeout?: ClearTimer;
}

const TERMINAL_PANEL_LOCAL_ID = "workspace.terminal";
const TERMINAL_PANEL_NAVIGATION_ALIASES: readonly QualifiedContributionId[] = ["core:workspace.terminal"];

export class TerminalFacade implements RequiredTerminalBrowserFacadeV1 {
  readonly version = 1 as const;
  private readonly pollIntervalMs: number;
  private openRequestSequence = 0;
  private readonly setTimer: SetTimer;
  private readonly clearTimer: ClearTimer;
  private readonly lifetime = new AbortController();

  constructor(options: TerminalFacadeOptions = {}) {
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.setTimer = options.setTimeout ?? ((handler, timeout) => globalThis.setTimeout(handler, timeout));
    this.clearTimer = options.clearTimeout ?? ((id) => { globalThis.clearTimeout(id); });
  }

  createWorkspaceTerminal(binding: RequiredTerminalWorkspaceBindingV1): WorkspacePanelTerminal {
    const client = new TerminalPeerClient(binding.peer);
    return Object.freeze({
      open: (options?: { terminalId?: string | undefined }) => {
        throwIfAborted(this.lifetime.signal);
        this.openTerminal(binding, options);
      },
      runCommand: async (input: WorkspaceTerminalCommandInput): Promise<TerminalCommandRunHandle> => {
        throwIfAborted(this.lifetime.signal);
        const run = await client.runCommand(binding.origin, input, this.lifetime.signal);
        throwIfAborted(this.lifetime.signal);
        if (input.open === true) this.openTerminal(binding, { terminalId: run.terminalId });
        return Object.freeze({
          run,
          completed: waitForCommandRunCompletion(run, client, this.pollIntervalMs, this.setTimer, this.clearTimer, this.lifetime.signal),
        });
      },
    });
  }

  dispose(): void {
    if (!this.lifetime.signal.aborted) {
      this.lifetime.abort(new DOMException("Terminal browser facade disposed", "AbortError"));
    }
  }

  private openTerminal(binding: RequiredTerminalWorkspaceBindingV1, options?: { terminalId?: string | undefined }): void {
    const contributionId: QualifiedContributionId = `${binding.registrationPluginId}:${TERMINAL_PANEL_LOCAL_ID}`;
    const terminalId = options?.terminalId;
    const query: Record<string, ContributionQueryValue | undefined> = terminalId === undefined
      ? { start: String(++this.openRequestSequence) }
      : { terminal: terminalId, start: undefined };
    void binding.host.navigateWorkspaceContribution(binding.workspace, {
      contributionId,
      navigationAliases: TERMINAL_PANEL_NAVIGATION_ALIASES,
      query,
    });
  }

  async listCommandRuns(query: RequiredTerminalCommandRunQueryV1): Promise<TerminalCommandRun[]> {
    throwIfAborted(this.lifetime.signal);
    const filter: TerminalCommandRunFilter = {
      ...(query.filter?.terminalId === undefined ? {} : { terminalId: query.filter.terminalId }),
      ...(query.filter?.statuses === undefined ? {} : { statuses: [...query.filter.statuses] }),
      ...(query.filter?.metadata === undefined ? {} : { metadata: { ...query.filter.metadata } }),
    };
    const linked = linkAbortSignals(this.lifetime.signal, query.signal);
    try {
      const runs = await new TerminalPeerClient(query.peer).listCommandRuns(filter, linked.signal);
      throwIfAborted(linked.signal);
      return runs;
    } finally {
      linked.dispose();
    }
  }

  parseCommandRun(value: unknown): TerminalCommandRun {
    return parseTerminalCommandRun(value);
  }
}

function waitForCommandRunCompletion(
  initialRun: TerminalCommandRun,
  client: Pick<TerminalPeerClient, "getCommandRun">,
  pollIntervalMs: number,
  setTimer: SetTimer,
  clearTimer: ClearTimer,
  signal: AbortSignal,
): Promise<TerminalCommandRun> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  if (isTerminalCommandRunFinal(initialRun)) return Promise.resolve(initialRun);
  return new Promise((resolve, reject) => {
    let timer: TimerId | undefined;
    let settled = false;

    const cleanup = (): void => {
      if (timer !== undefined) clearTimer(timer);
      signal.removeEventListener("abort", abort);
    };
    const finish = (result: TerminalCommandRun): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const abort = (): void => { fail(abortReason(signal)); };
    signal.addEventListener("abort", abort, { once: true });

    const poll = (): void => {
      if (settled || signal.aborted) return;
      void client.getCommandRun(initialRun.id, signal).then((run) => {
        if (settled || signal.aborted) return;
        if (run === undefined) {
          fail(new Error(`Terminal command run ${initialRun.id} is no longer available`));
          return;
        }
        if (isTerminalCommandRunFinal(run)) {
          finish(run);
          return;
        }
        timer = setTimer(poll, pollIntervalMs);
      }).catch(fail);
    };

    timer = setTimer(poll, pollIntervalMs);
  });
}

function isTerminalCommandRunFinal(run: TerminalCommandRun): boolean {
  return run.status === "succeeded" || run.status === "failed";
}

function snapshotTerminalBrowserFacade(value: unknown): RequiredTerminalBrowserFacadeV1 {
  if (!isRecord(value) || value["version"] !== 1) throw new Error("Terminal browser facade capability must be facade v1");
  const createWorkspaceTerminal = value["createWorkspaceTerminal"];
  const listCommandRuns = value["listCommandRuns"];
  const parseCommandRunValue = value["parseCommandRun"];
  if (typeof createWorkspaceTerminal !== "function" || typeof listCommandRuns !== "function" || typeof parseCommandRunValue !== "function") {
    throw new Error("Terminal browser facade capability must be facade v1");
  }
  return Object.freeze({
    version: 1,
    createWorkspaceTerminal(binding: RequiredTerminalWorkspaceBindingV1): WorkspacePanelTerminal {
      const terminal: unknown = Reflect.apply(createWorkspaceTerminal, value, [binding]);
      if (!isWorkspacePanelTerminal(terminal)) throw new Error("Terminal browser facade returned an invalid workspace terminal");
      return Object.freeze({
        open(options?: { terminalId?: string | undefined }): void { terminal.open(options); },
        runCommand: (input: WorkspaceTerminalCommandInput) => terminal.runCommand(input),
      });
    },
    async listCommandRuns(query: RequiredTerminalCommandRunQueryV1): Promise<TerminalCommandRun[]> {
      const result: unknown = await Reflect.apply(listCommandRuns, value, [query]);
      if (!Array.isArray(result)) throw new Error("Terminal browser facade returned an invalid command-run list");
      return result.map(parseTerminalCommandRun);
    },
    parseCommandRun(input: unknown): TerminalCommandRun {
      const result: unknown = Reflect.apply(parseCommandRunValue, value, [input]);
      return parseTerminalCommandRun(result);
    },
  });
}

function linkAbortSignals(lifetime: AbortSignal, caller: AbortSignal | undefined): { signal: AbortSignal; dispose(): void } {
  if (caller === undefined || caller === lifetime) return { signal: lifetime, dispose: () => undefined };
  const controller = new AbortController();
  const abortFromLifetime = (): void => { controller.abort(abortReason(lifetime)); };
  const abortFromCaller = (): void => { controller.abort(abortReason(caller)); };
  if (lifetime.aborted) abortFromLifetime();
  else if (caller.aborted) abortFromCaller();
  else {
    lifetime.addEventListener("abort", abortFromLifetime, { once: true });
    caller.addEventListener("abort", abortFromCaller, { once: true });
  }
  return {
    signal: controller.signal,
    dispose(): void {
      lifetime.removeEventListener("abort", abortFromLifetime);
      caller.removeEventListener("abort", abortFromCaller);
    },
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new DOMException("Terminal browser facade disposed", "AbortError");
}

function isWorkspacePanelTerminal(value: unknown): value is WorkspacePanelTerminal {
  return isRecord(value) && typeof value["open"] === "function" && typeof value["runCommand"] === "function";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
