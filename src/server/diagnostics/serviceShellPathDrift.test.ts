import { describe, expect, it } from "vitest";
import {
	checkServiceShellPathDrift,
	cleanLoginShellEnv,
	formatServiceShellPathDriftCheck,
	type ServiceShellPathDriftCheck,
} from "./serviceShellPathDrift.js";

describe("cleanLoginShellEnv", () => {
	it("uses a minimal system PATH without the caller's PATH", () => {
		const env = cleanLoginShellEnv("/Users/test");
		expect(env["HOME"]).toBe("/Users/test");
		expect(env["PATH"]).toBe("/usr/bin:/bin:/usr/sbin:/sbin");
		expect(env["PATH"]).not.toContain("nvm");
	});
});

describe("checkServiceShellPathDrift", () => {
	it("skips when no commands are given", () => {
		const result = checkServiceShellPathDrift([], "/bin/zsh", {
			interactiveResolve: () => "/usr/bin/node",
			cleanResolve: () => "/usr/bin/node",
		});
		expect(result).toEqual({ status: "skipped", reason: "no-commands" });
	});

	it("is ok when every interactive command also resolves in the clean login shell", () => {
		const result = checkServiceShellPathDrift(["node", "pi-web-server"], "/bin/zsh", {
			interactiveResolve: (command) => `/usr/bin/${command}`,
			cleanResolve: (command) => `/usr/bin/${command}`,
		});
		expect(result).toEqual({ status: "ok", commands: ["node", "pi-web-server"] });
	});

	it("reports path-drift when a command is visible interactively but missing in the clean login shell", () => {
		const interactive = new Map([
			["node", "/Users/me/.nvm/versions/node/v24.10.0/bin/node"],
			["pi-web-server", "/Users/me/.nvm/versions/node/v24.10.0/bin/pi-web-server"],
		]);
		// node resolves in both; pi-web-server resolves interactively but not in the clean login shell
		const clean = new Map([
			["node", "/usr/bin/node"],
			["pi-web-server", undefined],
		]);
		const result = checkServiceShellPathDrift(["node", "pi-web-server"], "/bin/zsh", {
			interactiveResolve: (command) => interactive.get(command),
			cleanResolve: (command) => clean.get(command),
		});
		expect(result.status).toBe("path-drift");
		if (result.status !== "path-drift") throw new Error("unreachable");
		expect(result.missing).toEqual(["pi-web-server"]);
		expect(result.present).toEqual(["node"]);
	});

	it("ignores commands that are not found even interactively (other checks surface those)", () => {
		const result = checkServiceShellPathDrift(["ghost"], "/bin/zsh", {
			interactiveResolve: () => undefined,
			cleanResolve: () => undefined,
		});
		expect(result).toEqual({ status: "ok", commands: ["ghost"] });
	});
});

describe("formatServiceShellPathDriftCheck", () => {
	it("renders nothing when ok", () => {
		expect(formatServiceShellPathDriftCheck({ status: "ok", commands: ["node"] }, "zsh")).toEqual({ ok: true, lines: [] });
	});

	it("renders nothing when skipped", () => {
		const skipped: ServiceShellPathDriftCheck = { status: "skipped", reason: "no-commands" };
		expect(formatServiceShellPathDriftCheck(skipped, "zsh")).toEqual({ ok: true, lines: [] });
	});

	it("renders the missing commands and the login-file fix", () => {
		const result = formatServiceShellPathDriftCheck(
			{ status: "path-drift", missing: ["pi-web-server"], present: [] },
			"zsh",
		);
		expect(result.ok).toBe(false);
		expect(result.lines[0]).toBe("✗ zsh login-shell PATH drift");
		expect(result.lines.some((line) => line.includes("pi-web-server"))).toBe(true);
		expect(result.lines.some((line) => line.includes("~/.zprofile"))).toBe(true);
		expect(result.lines.some((line) => line.includes("127"))).toBe(true);
	});
});
