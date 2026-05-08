#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { defaultPiWebConfigPath, examplePiWebConfig } from "./config.js";

const serviceDir = join(homedir(), ".config", "systemd", "user");
const sessiondServiceName = "pi-web-sessiond.service";
const webServiceName = "pi-web.service";

interface InstallOptions {
  host: string;
  port: string;
  config?: string;
}

function run(command: string, args: string[], options: { check?: boolean } = {}): number {
  const result = spawnSync(command, args, { stdio: "inherit" });
  const status = result.status ?? 1;
  if (options.check === true && status !== 0) process.exit(status);
  return status;
}

function capture(command: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

function hasCommand(command: string): boolean {
  return capture("/usr/bin/env", ["bash", "-lc", `command -v ${command}`]).status === 0;
}

function parseInstallOptions(args: string[]): InstallOptions {
  const options: InstallOptions = { host: "127.0.0.1", port: "8504" };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "--host") {
      const value = args[i + 1];
      if (value === undefined) throw new Error("--host requires a value");
      options.host = value;
      i += 1;
    } else if (arg.startsWith("--host=")) {
      options.host = arg.slice("--host=".length);
    } else if (arg === "--port") {
      const value = args[i + 1];
      if (value === undefined) throw new Error("--port requires a value");
      options.port = value;
      i += 1;
    } else if (arg.startsWith("--port=")) {
      options.port = arg.slice("--port=".length);
    } else if (arg === "--config") {
      const value = args[i + 1];
      if (value === undefined) throw new Error("--config requires a value");
      options.config = value;
      i += 1;
    } else if (arg.startsWith("--config=")) {
      options.config = arg.slice("--config=".length);
    } else if (arg === "--user-systemd") {
      // Accepted for readability; user systemd is the only installer target for now.
    } else {
      throw new Error(`Unknown install option: ${arg}`);
    }
  }
  return options;
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function systemdEscape(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function sessiondUnit(): string {
  return `[Unit]
Description=Pi Web session daemon

[Service]
Type=simple
ExecStart=/usr/bin/env bash -lc ${shellSingleQuote("exec pi-web-sessiond")}
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`;
}

function webUnit(options: InstallOptions): string {
  const configEnvironment = options.config === undefined ? "" : `Environment="PI_WEB_CONFIG=${systemdEscape(resolve(options.config))}"\n`;
  return `[Unit]
Description=Pi Web server
After=${sessiondServiceName}
Wants=${sessiondServiceName}

[Service]
Type=simple
${configEnvironment}ExecStart=/usr/bin/env bash -lc ${shellSingleQuote("exec pi-web-server")}
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`;
}

async function writeInitialConfig(options: InstallOptions): Promise<string> {
  const configPath = options.config === undefined ? defaultPiWebConfigPath() : resolve(options.config);
  await mkdir(dirname(configPath), { recursive: true });
  if (!existsSync(configPath)) {
    await writeFile(configPath, examplePiWebConfig({ host: options.host, port: Number(options.port) }));
  }
  return configPath;
}

async function install(args: string[]): Promise<void> {
  const options = parseInstallOptions(args);
  if (!hasCommand("systemctl")) throw new Error("systemctl was not found in a bash login shell");
  if (!hasCommand("pi-web-server")) throw new Error("pi-web-server was not found in a bash login shell. Is pi-web installed globally?");
  if (!hasCommand("pi-web-sessiond")) throw new Error("pi-web-sessiond was not found in a bash login shell. Is pi-web installed globally?");

  const configPath = await writeInitialConfig(options);

  await mkdir(serviceDir, { recursive: true });
  await writeFile(join(serviceDir, sessiondServiceName), sessiondUnit());
  await writeFile(join(serviceDir, webServiceName), webUnit(options));

  run("systemctl", ["--user", "daemon-reload"], { check: true });
  run("systemctl", ["--user", "enable", "--now", sessiondServiceName], { check: true });
  run("systemctl", ["--user", "enable", "--now", webServiceName], { check: true });

  console.log(`\nPi Web is installed and starting.`);
  console.log(`Config: ${configPath}`);
  console.log(`Open: http://${options.host === "0.0.0.0" ? "127.0.0.1" : options.host}:${options.port}`);
  console.log("\nUseful commands:");
  console.log("  pi-web status");
  console.log("  pi-web logs");
  console.log("  pi-web restart");
}

async function uninstall(): Promise<void> {
  run("systemctl", ["--user", "disable", "--now", webServiceName]);
  run("systemctl", ["--user", "disable", "--now", sessiondServiceName]);
  await rm(join(serviceDir, webServiceName), { force: true });
  await rm(join(serviceDir, sessiondServiceName), { force: true });
  run("systemctl", ["--user", "daemon-reload"]);
  console.log("Pi Web systemd user services removed.");
}

function serviceAction(action: "start" | "stop" | "restart" | "status"): void {
  run("systemctl", ["--user", action, sessiondServiceName, webServiceName], { check: action !== "status" });
}

function logs(): void {
  run("journalctl", ["--user", "-u", sessiondServiceName, "-u", webServiceName, "-f"]);
}

function doctor(): void {
  const checks: [string, string[]][] = [
    ["systemctl --user", ["systemctl", "--user", "--version"]],
    ["bash login shell can find node", ["/usr/bin/env", "bash", "-lc", "command -v node"]],
    ["bash login shell can find npm", ["/usr/bin/env", "bash", "-lc", "command -v npm"]],
    ["bash login shell can find pi", ["/usr/bin/env", "bash", "-lc", "command -v pi"]],
    ["bash login shell can find pi-web-server", ["/usr/bin/env", "bash", "-lc", "command -v pi-web-server"]],
    ["bash login shell can find pi-web-sessiond", ["/usr/bin/env", "bash", "-lc", "command -v pi-web-sessiond"]],
  ];

  let failed = false;
  for (const [label, command] of checks) {
    const [bin, ...args] = command;
    if (bin === undefined) continue;
    const result = capture(bin, args);
    const ok = result.status === 0;
    failed ||= !ok;
    console.log(`${ok ? "✓" : "✗"} ${label}`);
    const output = (result.stdout || result.stderr).trim();
    if (output !== "") console.log(`  ${output.split("\n")[0] ?? ""}`);
  }

  if (failed) {
    console.log("\nIf a command works in your terminal but fails here, make sure your bash login files set PATH the same way.");
    process.exitCode = 1;
  }
}

function help(): void {
  console.log(`Pi Web

Usage:
  pi-web install [--host 127.0.0.1] [--port 8504] [--config ~/.config/pi-web/config.json]
  pi-web uninstall
  pi-web start|stop|restart|status|logs
  pi-web doctor

Recommended install:
  npm install -g pi-web
  pi-web install
`);
}

async function main(): Promise<void> {
  const [command = "help", ...args] = process.argv.slice(2);
  if (command === "install") await install(args);
  else if (command === "uninstall") await uninstall();
  else if (command === "start" || command === "stop" || command === "restart" || command === "status") serviceAction(command);
  else if (command === "logs") logs();
  else if (command === "doctor") doctor();
  else if (command === "help" || command === "--help" || command === "-h") help();
  else throw new Error(`Unknown command: ${command}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
