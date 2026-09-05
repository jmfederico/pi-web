import type {
  TerminalCommandRun,
  TerminalCommandRunHandle,
  ContributionQueryValue,
  QualifiedContributionId,
  TerminalCommandRunStatus,
  Workspace,
  WorkspaceBackend,
  WorkspacePanelTerminal,
  WorkspaceTerminalCommandInput,
} from "@jmfederico/pi-web/plugin-api";
import { TerminalBackendClient, parseTerminalCommandRun, type TerminalCommandRunFilter } from "./terminalProtocol";

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
  readonly backend: WorkspaceBackend;
  readonly host: RequiredTerminalFacadeHostV1;
}

export interface RequiredTerminalCommandRunQueryV1 {
  readonly backend: WorkspaceBackend;
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

  constructor(options: TerminalFacadeOptions = {}) {
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.setTimer = options.setTimeout ?? ((handler, timeout) => globalThis.setTimeout(handler, timeout));
    this.clearTimer = options.clearTimeout ?? ((id) => { globalThis.clearTimeout(id); });
  }

  createWorkspaceTerminal(binding: RequiredTerminalWorkspaceBindingV1): WorkspacePanelTerminal {
    const client = new TerminalBackendClient(binding.backend);
    return Object.freeze({
      open: (options?: { terminalId?: string | undefined }) => { this.openTerminal(binding, options); },
      runCommand: async (input: WorkspaceTerminalCommandInput): Promise<TerminalCommandRunHandle> => {
        const run = await client.runCommand(binding.origin, input);
        if (input.open === true) this.openTerminal(binding, { terminalId: run.terminalId });
        return Object.freeze({
          run,
          completed: waitForCommandRunCompletion(run, client, this.pollIntervalMs, this.setTimer, this.clearTimer),
        });
      },
    });
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

  listCommandRuns(query: RequiredTerminalCommandRunQueryV1): Promise<TerminalCommandRun[]> {
    const filter: TerminalCommandRunFilter = {
      ...(query.filter?.terminalId === undefined ? {} : { terminalId: query.filter.terminalId }),
      ...(query.filter?.statuses === undefined ? {} : { statuses: [...query.filter.statuses] }),
      ...(query.filter?.metadata === undefined ? {} : { metadata: { ...query.filter.metadata } }),
    };
    return new TerminalBackendClient(query.backend).listCommandRuns(filter, query.signal);
  }

  parseCommandRun(value: unknown): TerminalCommandRun {
    return parseTerminalCommandRun(value);
  }
}

function waitForCommandRunCompletion(
  initialRun: TerminalCommandRun,
  client: Pick<TerminalBackendClient, "getCommandRun">,
  pollIntervalMs: number,
  setTimer: SetTimer,
  clearTimer: ClearTimer,
): Promise<TerminalCommandRun> {
  if (isTerminalCommandRunFinal(initialRun)) return Promise.resolve(initialRun);
  return new Promise((resolve, reject) => {
    let timer: TimerId | undefined;
    let settled = false;

    const finish = (result: TerminalCommandRun): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimer(timer);
      resolve(result);
    };

    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimer(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    const poll = (): void => {
      void client.getCommandRun(initialRun.id).then((run) => {
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
