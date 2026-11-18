import type { RestartRequest, RestartResult, RestartServices } from "../../../plugin-api";
import type { PiWebStatusResponse } from "../api";
import { restartMessages as m } from "../restartMessages";

export type RestartCommands = PiWebStatusResponse["commands"];
export interface RestartMachine { id: string; name: string }

export interface RestartConfirmation {
  machine: RestartMachine;
  services: RestartServices;
  loadCommands: () => Promise<RestartCommands>;
  run: (services: RestartServices, commands: RestartCommands) => Promise<void>;
}

const commandKeys = { web: "restartWeb", sessiond: "restartSessiond", both: "restart" } as const;

/** Missing targeted commands never widen a restart to additional services. */
export function restartCommand(commands: RestartCommands, services: RestartServices): string | undefined {
  const command = commands[commandKeys[services]];
  return command === undefined || command.trim() === "" ? undefined : command;
}

interface RestartDependencies {
  loadCommands: (machineId: string) => Promise<RestartCommands>;
  confirm: (request: RestartConfirmation) => Promise<RestartResult>;
  launch: (machineId: string, command: string, title: string) => Promise<void>;
}

/** Shared policy; status, presentation and terminal side effects stay at injected boundaries. */
export class RestartController {
  private readonly pending = new Set<string>();

  constructor(private readonly dependencies: RestartDependencies) {}

  async request(machine: RestartMachine, options: RestartRequest = {}, isCurrent: () => boolean = () => true): Promise<RestartResult> {
    if (this.pending.has(machine.id)) throw new Error(m.t("pending"));
    // Freeze identity before any asynchronous status/confirmation work.
    const target = { ...machine };
    this.pending.add(target.id);
    try {
      const loadCommands = () => this.dependencies.loadCommands(target.id);
      const run = async (services: RestartServices, commands: RestartCommands) => {
        if (!isCurrent()) throw new Error(m.t("machineUnavailable"));
        const command = restartCommand(commands, services);
        if (command === undefined) throw new Error(m.t("unavailable"));
        await this.dependencies.launch(target.id, command, m.t(services));
      };
      if (options.confirm === false) {
        await run(options.services, await loadCommands());
        return "launched";
      } else {
        return await this.dependencies.confirm({ machine: target, services: options.services ?? "web", loadCommands, run });
      }
    } finally {
      this.pending.delete(target.id);
    }
  }
}
