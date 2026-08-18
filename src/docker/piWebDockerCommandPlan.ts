export type PiWebDockerMode = "runtime" | "dev";
export type PiWebDockerCommand =
  | "install"
  | "start"
  | "stop"
  | "restart"
  | "restart-web"
  | "restart-sessiond"
  | "update"
  | "status"
  | "logs"
  | "shell"
  | "doctor"
  | "cli"
  | "help";

export type PiWebDockerLogsTarget = "web" | "sessiond" | "data-init";
export type PiWebDockerShellTarget = "web" | "sessiond";

export interface PiWebDockerCommandPlan {
  mode: PiWebDockerMode;
  command: PiWebDockerCommand;
  allowRoot: boolean;
  args: string[];
  target?: PiWebDockerLogsTarget | PiWebDockerShellTarget;
}

export type PiWebDockerParseResult =
  | { ok: true; plan: PiWebDockerCommandPlan }
  | { ok: false; errors: string[] };

export const PI_WEB_DOCKER_USER_COMMANDS = [
  "install",
  "start",
  "stop",
  "restart",
  "restart-web",
  "restart-sessiond",
  "update",
  "status",
  "logs",
  "shell",
  "doctor",
  "cli",
] as const satisfies readonly Exclude<PiWebDockerCommand, "help">[];

export type PiWebDockerRuntimeHostPlan =
  | { kind: "installer"; action: "install" | "update"; args: string[]; useRuntimeRootAsInstallDir: boolean }
  | { kind: "compose"; args: string[] }
  | { kind: "diagnostics" }
  | { kind: "usage" };

export type PiWebDockerDevUpdateStep =
  // A failed or impossible fast-forward warns and still rebuilds the checkout in place.
  | { kind: "gitFastForward"; onFailure: "warn" }
  | { kind: "compose"; args: string[] };

export type PiWebDockerDevHostPlan =
  | { kind: "compose"; args: string[]; usesGeneratedEnv: true }
  | { kind: "updateSequence"; steps: PiWebDockerDevUpdateStep[]; usesGeneratedEnv: true }
  | { kind: "diagnostics"; usesGeneratedEnv: true }
  | { kind: "usage" };

const noArgumentCommands = new Set<PiWebDockerCommand>([
  "start",
  "stop",
  "restart",
  "restart-web",
  "restart-sessiond",
  "update",
  "status",
  "doctor",
  "help",
]);

const commands: ReadonlySet<string> = new Set([...PI_WEB_DOCKER_USER_COMMANDS, "help"]);

const logsTargets: ReadonlySet<string> = new Set(["web", "sessiond", "data-init"]);
const shellTargets: ReadonlySet<string> = new Set(["web", "sessiond"]);

export function piWebDockerCommandPrefix(mode: PiWebDockerMode | undefined): string {
  return mode === "dev" ? "pi-web-docker --dev" : "pi-web-docker";
}

export function piWebDockerCommand(mode: PiWebDockerMode | undefined, command: Exclude<PiWebDockerCommand, "help">): string {
  return `${piWebDockerCommandPrefix(mode)} ${command}`;
}

export function planPiWebDockerRuntimeHostCommand(plan: PiWebDockerCommandPlan): PiWebDockerRuntimeHostPlan | undefined {
  if (plan.mode !== "runtime") return undefined;

  switch (plan.command) {
    case "install":
      return { kind: "installer", action: "install", args: [...plan.args], useRuntimeRootAsInstallDir: false };
    case "update":
      return { kind: "installer", action: "update", args: [], useRuntimeRootAsInstallDir: true };
    case "start":
      return composeHostPlan("up", "-d");
    case "stop":
      return composeHostPlan("down");
    case "restart":
      return composeHostPlan("restart", "web", "sessiond");
    case "restart-web":
      return composeHostPlan("restart", "web");
    case "restart-sessiond":
      return composeHostPlan("restart", "sessiond");
    case "status":
      return composeHostPlan("ps");
    case "logs":
      return plan.target === undefined ? composeHostPlan("logs", "-f") : composeHostPlan("logs", "-f", plan.target);
    case "shell":
      return composeHostPlan("exec", plan.target ?? "web", "bash");
    case "cli":
      return { kind: "compose", args: ["exec", "web", "pi-web", ...plan.args] };
    case "doctor":
      return { kind: "diagnostics" };
    case "help":
      return { kind: "usage" };
  }
}

export function planPiWebDockerDevHostCommand(plan: PiWebDockerCommandPlan): PiWebDockerDevHostPlan | undefined {
  if (plan.mode !== "dev") return undefined;

  switch (plan.command) {
    case "install":
      return undefined;
    case "start":
      return devComposeHostPlan("up", "-d", "--build");
    case "stop":
      return devComposeHostPlan("down");
    case "restart":
      return devComposeHostPlan("restart", "web", "sessiond");
    case "restart-web":
      return devComposeHostPlan("restart", "web");
    case "restart-sessiond":
      return devComposeHostPlan("restart", "sessiond");
    case "update":
      return {
        kind: "updateSequence",
        usesGeneratedEnv: true,
        steps: [
          { kind: "gitFastForward", onFailure: "warn" },
          { kind: "compose", args: ["build", "--pull"] },
          { kind: "compose", args: ["up", "-d", "--force-recreate", "--remove-orphans"] },
        ],
      };
    case "status":
      return devComposeHostPlan("ps");
    case "logs":
      return plan.target === undefined ? devComposeHostPlan("logs", "-f") : devComposeHostPlan("logs", "-f", plan.target);
    case "shell":
      return devComposeHostPlan("exec", plan.target ?? "web", "bash");
    case "cli":
      return { kind: "compose", args: ["exec", "web", "pi-web", ...plan.args], usesGeneratedEnv: true };
    case "doctor":
      return { kind: "diagnostics", usesGeneratedEnv: true };
    case "help":
      return { kind: "usage" };
  }
}

export function validatePiWebDockerDevRootSafety(plan: PiWebDockerCommandPlan, uid: number): string | undefined {
  if (plan.mode !== "dev" || plan.allowRoot || plan.command === "help" || uid !== 0) return undefined;
  return "refusing to run Docker development mode as root; retry with --allow-root if this is intentional";
}

export function parsePiWebDockerArgs(argv: readonly string[]): PiWebDockerParseResult {
  let mode: PiWebDockerMode = "runtime";
  let allowRoot = false;
  let index = 0;

  for (; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) break;
    if (arg === "--") {
      index += 1;
      break;
    }
    if (arg === "--dev") {
      mode = "dev";
      continue;
    }
    if (arg === "--allow-root") {
      allowRoot = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return { ok: true, plan: { mode, command: "help", allowRoot, args: [] } };
    }
    if (arg.startsWith("-")) {
      return { ok: false, errors: [`Unknown global option: ${arg}`] };
    }
    break;
  }

  const commandValue = argv[index];
  if (commandValue === undefined) return { ok: false, errors: ["Missing command"] };
  if (!isPiWebDockerCommand(commandValue)) return { ok: false, errors: [`Unknown command: ${commandValue}`] };

  const args = argv.slice(index + 1);
  const plan: PiWebDockerCommandPlan = { mode, command: commandValue, allowRoot, args };
  return validatePlan(withDefaultTarget(plan));
}

function composeHostPlan(...args: string[]): PiWebDockerRuntimeHostPlan {
  return { kind: "compose", args };
}

function devComposeHostPlan(...args: string[]): PiWebDockerDevHostPlan {
  return { kind: "compose", args, usesGeneratedEnv: true };
}

function withDefaultTarget(plan: PiWebDockerCommandPlan): PiWebDockerCommandPlan {
  if (plan.command === "shell" && plan.target === undefined && plan.args.length === 0) return { ...plan, target: "web" };
  return plan;
}

function validatePlan(plan: PiWebDockerCommandPlan): PiWebDockerParseResult {
  const errors: string[] = [];

  if (plan.command === "install" && plan.mode === "dev") {
    errors.push("install is only available in runtime mode");
  }

  if (noArgumentCommands.has(plan.command) && plan.args.length > 0) {
    errors.push(`${plan.command} does not accept positional arguments`);
  }

  if (plan.command === "logs") {
    validateOptionalTarget(plan.args, isLogsTarget, "logs", errors);
    if (plan.args[0] === "data-init" && plan.mode !== "dev") errors.push("logs data-init is only available in development mode");
  }

  if (plan.command === "shell") {
    validateOptionalTarget(plan.args, isShellTarget, "shell", errors);
  }

  if (plan.command === "cli" && plan.args.length === 0) {
    errors.push("cli requires pi-web arguments");
  }

  if (errors.length > 0) return { ok: false, errors };

  const target = targetFrom(plan.command, plan.args);
  return { ok: true, plan: target === undefined ? plan : { ...plan, target } };
}

function validateOptionalTarget(args: readonly string[], isAllowed: (value: string) => boolean, command: string, errors: string[]): void {
  if (args.length > 1) {
    errors.push(`${command} accepts at most one target`);
    return;
  }
  const [target] = args;
  if (target !== undefined && !isAllowed(target)) errors.push(`Invalid ${command} target: ${target}`);
}

function targetFrom(command: PiWebDockerCommand, args: readonly string[]): PiWebDockerCommandPlan["target"] | undefined {
  const [target] = args;
  if (target === undefined) return command === "shell" ? "web" : undefined;
  if (command === "logs" && isLogsTarget(target)) return target;
  if (command === "shell" && isShellTarget(target)) return target;
  return undefined;
}

function isPiWebDockerCommand(value: string): value is PiWebDockerCommand {
  return commands.has(value);
}

function isLogsTarget(value: string): value is PiWebDockerLogsTarget {
  return logsTargets.has(value);
}

function isShellTarget(value: string): value is PiWebDockerShellTarget {
  return shellTargets.has(value);
}
