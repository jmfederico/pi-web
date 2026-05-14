import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(packageRoot, "dist", "cli.js");
const serviceNames = ["pi-web-sessiond.service", "pi-web.service"];

const subcommands = [
  "install",
  "status",
  "logs",
  "restart",
  "start",
  "stop",
  "doctor",
  "uninstall",
  "open",
  "help",
] as const;

type Subcommand = (typeof subcommands)[number];

function parseArgs(args: string): string[] {
  return args.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((part) => {
    if ((part.startsWith('"') && part.endsWith('"')) || (part.startsWith("'") && part.endsWith("'"))) {
      return part.slice(1, -1);
    }
    return part;
  }) ?? [];
}

function truncateOutput(output: string): string {
  const trimmed = output.trim();
  if (trimmed.length <= 3_500) return trimmed;
  return `${trimmed.slice(0, 3_500)}\n… output truncated`;
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { output += chunk; });
    child.stderr.on("data", (chunk: string) => { output += chunk; });
    child.on("error", (error) => {
      resolve({ code: 1, output: error.message });
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 1, output });
    });
  });
}

async function runPiWeb(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number; output: string }> {
  if (existsSync(cliPath)) {
    return run(process.execPath, [cliPath, ...args], env);
  }
  return run("pi-web", args, env);
}

function showResult(ctx: { ui: { notify(message: string, type?: "info" | "warning" | "error" | "success"): void } }, title: string, result: { code: number; output: string }): void {
  const body = truncateOutput(result.output) || (result.code === 0 ? "Done." : `Command failed with exit code ${String(result.code)}.`);
  ctx.ui.notify(`${title}\n\n${body}`, result.code === 0 ? "info" : "error");
}

function isSubcommand(value: string): value is Subcommand {
  return subcommands.some((command) => command === value);
}

async function boundedLogs(): Promise<{ code: number; output: string }> {
  return run("journalctl", ["--user", "-u", serviceNames[0] ?? "", "-u", serviceNames[1] ?? "", "-n", "100", "--no-pager"]);
}

export default function piWebExtension(pi: ExtensionAPI): void {
  pi.registerCommand("pi-web", {
    description: "Manage Pi Web services: install, status, logs, restart, start, stop, doctor, open",
    getArgumentCompletions(prefix: string): { value: string; label: string }[] | null {
      const [first = ""] = parseArgs(prefix);
      const items = subcommands
        .filter((command) => command.startsWith(first))
        .map((command) => ({ value: command, label: command }));
      return items.length > 0 ? items : null;
    },
    async handler(args, ctx) {
      const parsedArgs = parseArgs(args);
      const subcommand = parsedArgs[0] ?? "help";
      const rest = parsedArgs.slice(1);

      if (subcommand === "help") {
        ctx.ui.notify(`Pi Web commands:\n\n${subcommands.map((command) => `/pi-web ${command}`).join("\n")}\n\nLogs are bounded to the last 100 journal lines in the Pi command. Use \`pi-web logs\` in a shell to follow logs.`, "info");
        return;
      }

      if (subcommand === "open") {
        ctx.ui.notify("Pi Web default URL: http://127.0.0.1:8504", "info");
        return;
      }

      if (!isSubcommand(subcommand)) {
        ctx.ui.notify(`Unknown pi-web command: ${subcommand}. Try /pi-web help.`, "error");
        return;
      }

      if (subcommand === "stop" || subcommand === "uninstall") {
        const ok = await ctx.ui.confirm(`pi-web ${subcommand}`, `Run pi-web ${subcommand}?`);
        if (!ok) return;
      }

      if (subcommand === "logs") {
        showResult(ctx, "pi-web logs", await boundedLogs());
        return;
      }

      showResult(ctx, `pi-web ${subcommand}`, await runPiWeb([subcommand, ...rest]));
    },
  });
}
