import { spawnSync } from "node:child_process";
import { homedir, userInfo } from "node:os";

/**
 * PI WEB services run as non-interactive login shells launched by the OS
 * service manager (macOS LaunchAgents, systemd user services). Those shells
 * start from a minimal environment and source only login files (e.g. zsh reads
 * `~/.zprofile`/`~/.zshenv`, but NOT `~/.zshrc`). When a user puts their
 * node/version-manager PATH setup in `~/.zshrc` (the nvm default), the tools
 * are visible in an interactive terminal but missing from the service shell.
 *
 * `pi-web doctor` and `pi-web install` run from an interactive terminal, so
 * their `zsh -lc "command -v ..."` checks inherit the caller's PATH and report
 * success even though the service will later fail with `command not found`
 * (exit 127). This module re-runs the same lookup in a clean login shell that
 * does not inherit the caller's PATH, mirroring what the service manager
 * actually does, so the drift can be detected up front.
 */

export interface ServiceShellPathDriftCheckOptions {
	platform?: NodeJS.Platform;
	home?: string;
	/** Resolve a command in the caller's (interactive) environment. */
	interactiveResolve?: (command: string) => string | undefined;
	/** Resolve a command in a clean login shell without the caller's PATH. */
	cleanResolve?: (command: string) => string | undefined;
}

export type ServiceShellPathDriftCheck =
	| { status: "skipped"; reason: "non-launchd-non-systemd" | "no-commands" }
	| { status: "ok"; commands: string[] }
	| {
			status: "path-drift";
			missing: string[];
			present: string[];
	  };

/**
 * Build a clean environment for a LaunchAgent-style login shell: only the
 * minimal PATH a fresh macOS/Linux login starts with, plus HOME and USER.
 * The login shell then re-sources its login files and rebuilds PATH from
 * `~/.zprofile`/`~/.profile`/etc., without the caller's interactive PATH
 * leaking in.
 */
export function cleanLoginShellEnv(home: string = homedir()): Record<string, string> {
	const user = userInfo().username;
	return {
		HOME: home,
		USER: user,
		LOGNAME: user,
		PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
	};
}

export function resolveInCleanLoginShell(shell: string, command: string, home: string = homedir()): string | undefined {
	const result = spawnSync("/usr/bin/env", [shell, "-lc", `command -v ${command}`], {
		encoding: "utf8",
		env: cleanLoginShellEnv(home),
	});
	if (result.status !== 0) return undefined;
	const path = result.stdout.trim();
	return path === "" ? undefined : path;
}

export function resolveInteractively(command: string): string | undefined {
	const result = spawnSync("/usr/bin/env", ["sh", "-c", `command -v ${command}`], { encoding: "utf8" });
	if (result.status !== 0) return undefined;
	const path = result.stdout.trim();
	return path === "" ? undefined : path;
}

/**
 * Detect commands that resolve in the interactive shell but not in a clean
 * login shell. Those commands will be unreachable from PI WEB services even
 * though `pi-web doctor` would otherwise report them as found.
 */
export function checkServiceShellPathDrift(
	commands: string[],
	shell: string,
	options: ServiceShellPathDriftCheckOptions = {},
): ServiceShellPathDriftCheck {
	if (commands.length === 0) return { status: "skipped", reason: "no-commands" };

	const interactiveResolve = options.interactiveResolve ?? resolveInteractively;
	const cleanResolve = options.cleanResolve ?? ((command: string) => resolveInCleanLoginShell(shell, command, options.home));

	const missing: string[] = [];
	const present: string[] = [];
	for (const command of commands) {
		const interactivePath = interactiveResolve(command);
		if (interactivePath === undefined) continue; // not found even interactively; other doctor checks handle that
		const cleanPath = cleanResolve(command);
		if (cleanPath === undefined) missing.push(command);
		else present.push(command);
	}

	if (missing.length === 0) return { status: "ok", commands };
	return { status: "path-drift", missing, present };
}

export interface FormattedServiceShellPathDriftCheck {
	ok: boolean;
	lines: string[];
}

export function formatServiceShellPathDriftCheck(
	check: ServiceShellPathDriftCheck,
	shellLabel: string,
): FormattedServiceShellPathDriftCheck {
	if (check.status === "skipped") return { ok: true, lines: [] };
	if (check.status === "ok") return { ok: true, lines: [] };

	const label = `${shellLabel} login-shell PATH drift`;
	return {
		ok: false,
		lines: [
			`✗ ${label}`,
			`  These commands are on your interactive PATH but not in a clean ${shellLabel} login shell:`,
			...check.missing.map((command) => `    ${command}`),
			"  PI WEB services run as non-interactive login shells and will not find them, causing exit code 127.",
			"  Put your node/version-manager PATH setup in a login file the service shell reads:",
			"    zsh  -> ~/.zprofile   (not only ~/.zshrc)",
			"    bash -> ~/.bash_profile or ~/.profile   (not only ~/.bashrc)",
			"    fish -> `fish_add_path -U ...`",
			"  Then re-run `pi-web install` so the service plists pick up the corrected PATH.",
		],
	};
}
