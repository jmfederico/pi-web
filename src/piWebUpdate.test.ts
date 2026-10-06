import { basename, dirname, normalize, join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runPiWebUpdate, type PiWebUpdateDependencies } from "./piWebUpdate.js";
import type { PiWebInstallationInfo } from "./shared/apiTypes.js";

function fixture(installation: PiWebInstallationInfo = { kind: "docker", dockerMode: "runtime" }, interactive = true, platform: NodeJS.Platform = "linux") {
  const environment: NodeJS.ProcessEnv = { PATH: "/tools/bin" };
  const deps = {
    env: environment,
    nodeExecutable: "/tools/node",
    platform,
    home: "/home/test",
    userId: 501,
    cwd: "/project with spaces",
    uniqueId: vi.fn(() => "unique-id"),
    exists: vi.fn((path: string) => !path.includes("ui-dev")),
    mkdir: vi.fn<PiWebUpdateDependencies["mkdir"]>(() => Promise.resolve()),
    writeFile: vi.fn<PiWebUpdateDependencies["writeFile"]>(() => Promise.resolve()),
    removeFile: vi.fn<PiWebUpdateDependencies["removeFile"]>(() => Promise.resolve()),
    piCliPath: "/owned/pi/dist/cli.js",
    interactive,
    agentDir: vi.fn(() => Promise.resolve("/profiles/active agent")),
    detectInstallation: vi.fn(() => Promise.resolve(installation)),
    realpath: vi.fn((path: string) => Promise.resolve(normalize(path))),
    capture: vi.fn<PiWebUpdateDependencies["capture"]>((command) => Promise.resolve(command.executable === "npm" ? "/opt/node/lib/node_modules" : command.executable === "systemctl" ? "loaded" : "")),
    run: vi.fn<PiWebUpdateDependencies["run"]>(() => Promise.resolve()),
    confirm: vi.fn(() => Promise.resolve(true)),
    log: vi.fn(),
  } satisfies PiWebUpdateDependencies;
  return deps;
}
const globalInstall: PiWebInstallationInfo = {
  kind: "npm-global", path: "/opt/node/lib/node_modules/@jmfederico/pi-web", npmRoot: "/opt/node/lib/node_modules",
};
const piInstall: PiWebInstallationInfo = {
  kind: "pi-package", path: "/profiles/active agent/npm/node_modules/@jmfederico/pi-web", scope: "user", source: "npm:@jmfederico/pi-web",
};
const localInstall: PiWebInstallationInfo = { kind: "local", path: "/workspace/pi-web" };

function configureLocalCheckout(deps: ReturnType<typeof fixture>, status = "", branch = "main", upstream = "origin/main") {
  deps.capture.mockImplementation((command) => {
    if (command.executable === "systemctl") return Promise.resolve("loaded");
    if (command.executable !== "git") return Promise.resolve("");
    if (command.args.includes("--show-toplevel")) return Promise.resolve("/workspace/pi-web");
    if (command.args.includes("--porcelain=v1")) return Promise.resolve(status);
    if (command.args.includes("--short")) return Promise.resolve(branch);
    if (command.args.includes("@{upstream}")) return Promise.resolve(upstream);
    return Promise.resolve("");
  });
}

describe("runPiWebUpdate", () => {
  it.each([["--force"], ["--yes", "--yes"], ["latest"], ["--help", "--yes"], ["--dev"], ["--all"]])("rejects invalid arguments %j before inspecting or changing anything", async (...args) => {
    const deps = fixture();
    await expect(runPiWebUpdate(args, deps)).rejects.toThrow("Invalid update arguments");
    expect(deps.agentDir).not.toHaveBeenCalled();
    expect(deps.run).not.toHaveBeenCalled();
  });

  it("help does not inspect the installation", async () => {
    const deps = fixture();
    await runPiWebUpdate(["--help"], deps);
    expect(deps.agentDir).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("Usage:"));
  });

  it.each(["runtime", "dev"] as const)("delegates %s Docker update, including inside a session", async (dockerMode) => {
    const deps = fixture({ kind: "docker", dockerMode });
    deps.env = { ...deps.env, ...{ PI_WEB_SESSION: "1" } };
    await runPiWebUpdate([], deps);
    expect(deps.run.mock.calls).toEqual([[{
      executable: "pi-web-docker", args: dockerMode === "dev" ? ["--dev", "update"] : ["update"], env: deps.env,
    }]]);
    expect(deps.confirm).toHaveBeenCalledOnce();
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("interrupt active sessions and terminals"));
    expect(deps.log.mock.invocationCallOrder[0]).toBeLessThan(deps.confirm.mock.invocationCallOrder[0] ?? 0);
    expect(deps.confirm.mock.invocationCallOrder[0]).toBeLessThan(deps.run.mock.invocationCallOrder[0] ?? 0);
  });

  it("does not guess an unknown Docker mode", async () => {
    const deps = fixture({ kind: "docker" });
    await expect(runPiWebUpdate(["--yes"], deps)).rejects.toThrow("mode is unknown");
    expect(deps.run).not.toHaveBeenCalled();
  });

  it("requires --yes without a TTY", async () => {
    const deps = fixture();
    deps.interactive = false;
    await expect(runPiWebUpdate([], deps)).rejects.toThrow("explicit --yes");
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(deps.run).not.toHaveBeenCalled();
    await runPiWebUpdate(["--yes"], deps);
    expect(deps.run).toHaveBeenCalledOnce();
    expect(deps.confirm).not.toHaveBeenCalled();
  });

  it("cancels without mutation", async () => {
    const deps = fixture();
    deps.confirm.mockResolvedValue(false);
    await runPiWebUpdate([], deps);
    expect(deps.run).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith("Update cancelled. Nothing changed.");
  });

  it("only prints instructions for unknown installations", async () => {
    const deps = fixture({ kind: "unknown" });
    await runPiWebUpdate(["--yes"], deps);
    expect(deps.run).not.toHaveBeenCalled();
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("original tooling"));
  });

  it("fast-forwards, installs, and builds the detected local checkout when invoked from another project", async () => {
    const deps = fixture(localInstall);
    configureLocalCheckout(deps);
    expect(deps.cwd).not.toBe(localInstall.path);

    await runPiWebUpdate(["--yes"], deps);

    expect(deps.run.mock.calls.map(([command]) => [command.executable, command.args])).toEqual([
      ["git", ["-C", "/workspace/pi-web", "pull", "--ff-only"]],
      ["npm", ["--prefix", "/workspace/pi-web", "install"]],
      ["npm", ["--prefix", "/workspace/pi-web", "run", "build"]],
      ["/tools/node", [join("/workspace/pi-web", "dist", "cli.js"), "restart"]],
    ]);
    expect(deps.run.mock.calls[0]?.[0].env).toEqual({ PATH: "/tools/bin", GIT_TERMINAL_PROMPT: "0" });
  });

  it("refuses a dirty local checkout before confirmation or mutation", async () => {
    const deps = fixture(localInstall);
    configureLocalCheckout(deps, " M src/cli.ts\\n?? scratch.txt");

    await expect(runPiWebUpdate(["--yes"], deps)).rejects.toThrow("uncommitted or untracked changes");
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(deps.run).not.toHaveBeenCalled();
  });

  it("refuses a local checkout without an upstream branch", async () => {
    const deps = fixture(localInstall);
    configureLocalCheckout(deps, "", "main", "");

    await expect(runPiWebUpdate(["--yes"], deps)).rejects.toThrow("has no upstream branch");
    expect(deps.run).not.toHaveBeenCalled();
  });

  it("does not pull a local checkout when confirmation is declined", async () => {
    const deps = fixture(localInstall);
    configureLocalCheckout(deps);
    deps.confirm.mockResolvedValue(false);

    await runPiWebUpdate([], deps);

    expect(deps.run).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith("Update cancelled. Nothing changed.");
  });

  it.each(["install", "build"])("does not restart when the local %s fails", async (failure) => {
    const deps = fixture(localInstall);
    configureLocalCheckout(deps);
    deps.run.mockImplementation((command) => {
      if (command.executable === "npm" && command.args.includes(failure)) return Promise.reject(new Error(`${failure} failed`));
      return Promise.resolve();
    });

    await expect(runPiWebUpdate(["--yes"], deps)).rejects.toThrow(`${failure} failed`);
    expect(deps.run.mock.calls.some(([command]) => command.args.includes("restart"))).toBe(false);
    if (failure === "install") expect(deps.run.mock.calls.some(([command]) => command.args.includes("build"))).toBe(false);
  });

  it("stops before install when a local checkout cannot fast-forward", async () => {
    const deps = fixture(localInstall);
    configureLocalCheckout(deps);
    deps.run.mockRejectedValueOnce(new Error("non-fast-forward"));

    await expect(runPiWebUpdate(["--yes"], deps)).rejects.toThrow("Could not fast-forward the local checkout");
    expect(deps.run).toHaveBeenCalledOnce();
    expect(deps.run.mock.calls[0]?.[0].args).toEqual(["-C", "/workspace/pi-web", "pull", "--ff-only"]);
  });

  it.each([globalInstall, piInstall])("hands off nested macOS update to a one-shot launchd agent ($kind)", async (installation) => {
    const deps = fixture(installation);
    deps.platform = "darwin";
    deps.env = {
      ...deps.env,
      PI_WEB_SESSION: "1",
      PI_WEB_CONFIG: "relative/config.json",
      PI_WEB_DATA_DIR: "/data/custom",
      HOME: "/home/test",
      SECRET_TOKEN: "do not forward",
    };

    await runPiWebUpdate(["--yes"], deps);

    const handoffPath = join("/home/test", ".pi-web", "update-handoffs", "com.pi-web.update-unique-id.plist");
    expect(deps.run).toHaveBeenCalledWith({
      executable: "launchctl",
      args: ["bootstrap", "gui/501", handoffPath],
      env: {
        PATH: "/tools/bin",
        PI_WEB_CONFIG: "relative/config.json",
        PI_WEB_DATA_DIR: "/data/custom",
        HOME: "/home/test",
      },
    });
    expect(deps.writeFile).toHaveBeenCalledWith(handoffPath, expect.stringContaining("<key>RunAtLoad</key>"));
    const plist = deps.writeFile.mock.calls[0]?.[1] ?? "";
    expect(plist).toContain(`<string>${deps.nodeExecutable}</string>`);
    expect(plist).toContain(`<string>${join(installation.path ?? "", "dist", "cli.js")}</string>`);
    expect(plist).toContain("<string>update</string>");
    expect(plist).toContain("<string>--yes</string>");
    expect(plist).toContain("<key>KeepAlive</key>\n  <false/>");
    expect(plist).not.toContain("PI_WEB_SESSION");
    expect(plist).not.toContain("SECRET_TOKEN");
    expect(deps.removeFile).toHaveBeenCalledWith(handoffPath);
    expect(deps.run).toHaveBeenCalledOnce();
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("completion is not verified"));
  });

  it("does not create a macOS handoff when confirmation is declined", async () => {
    const deps = fixture(piInstall);
    deps.platform = "darwin";
    deps.env = { ...deps.env, PI_WEB_SESSION: "1" };
    deps.confirm.mockResolvedValue(false);

    await runPiWebUpdate([], deps);

    expect(deps.mkdir).not.toHaveBeenCalled();
    expect(deps.writeFile).not.toHaveBeenCalled();
    expect(deps.run).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith("Update cancelled. Nothing changed.");
  });

  it("refuses a nested macOS handoff when launchd rejects the bootstrap", async () => {
    const deps = fixture(piInstall);
    deps.platform = "darwin";
    deps.env = { ...deps.env, PI_WEB_SESSION: "1" };
    deps.run.mockRejectedValue(new Error("bootstrap failed"));

    await expect(runPiWebUpdate(["--yes"], deps)).rejects.toThrow("Cannot safely dispatch a detached launchd update");
    expect(deps.writeFile).toHaveBeenCalledOnce();
    expect(deps.removeFile).toHaveBeenCalledWith(expect.stringContaining("update-handoffs"));
    expect(deps.run).toHaveBeenCalledOnce();
  });

  it.each([globalInstall, piInstall])("dispatches nested Linux restart only after successful installation ($kind)", async (installation) => {
    const deps = fixture(installation);
    deps.env = { ...deps.env, ...{ PI_WEB_SESSION: "1", PI_WEB_CONFIG: "relative/config.json", PI_WEB_DATA_DIR: "/data/custom", PI_WEB_SESSIOND_SOCKET: "/custom.sock", HOME: "/home/test", XDG_RUNTIME_DIR: "/run/user/500", SECRET_TOKEN: "do not forward" } };
    await runPiWebUpdate([], deps);
    const probe = deps.capture.mock.calls.find(([command]) => command.executable === "systemd-run")?.[0];
    expect(probe?.args).toEqual(expect.arrayContaining(["--user", "--collect", "--wait", "--unit=pi-web-update-restart-unique-id-preflight", "--eval", "process.exit(0)"]));
    expect(deps.capture.mock.invocationCallOrder.at(-1)).toBeLessThan(deps.run.mock.invocationCallOrder[0] ?? 0);
    const restart = deps.run.mock.calls[1]?.[0];
    expect(restart?.executable).toBe("systemd-run");
    expect(restart?.args).toEqual(expect.arrayContaining(["--user", "--collect", "--expand-environment=no", "--working-directory=/project with spaces", "--setenv=PI_WEB_CONFIG", "--setenv=PI_WEB_DATA_DIR", "--setenv=PI_WEB_SESSIOND_SOCKET", "--setenv=HOME", "--setenv=XDG_RUNTIME_DIR", "--unit=pi-web-update-restart-unique-id"]));
    expect(restart?.env).toEqual(deps.env);
    expect(restart?.args.slice(-4)).toEqual(["--", "/tools/node", join(installation.path ?? "", "dist", "cli.js"), "restart"]);
    expect(restart?.args).not.toContain("--wait");
    expect(restart?.args).not.toContain("--scope");
    expect(restart?.args).not.toContain("--setenv=SECRET_TOKEN");
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("not verified complete"));
    const planIndex = deps.log.mock.calls.findIndex(([line]) => String(line).startsWith("Install:"));
    expect(deps.log.mock.invocationCallOrder[planIndex]).toBeLessThan(deps.confirm.mock.invocationCallOrder[0] ?? 0);
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining(installation.path ?? ""));
  });

  it("refuses before installation when detached dispatch preflight fails", async () => {
    const deps = fixture(piInstall);
    deps.env = { ...deps.env, ...{ PI_WEB_SESSION: "1" } };
    deps.capture.mockImplementation((command) => command.executable === "systemd-run" ? Promise.reject(new Error("no user bus")) : Promise.resolve("loaded"));
    await expect(runPiWebUpdate(["--yes"], deps)).rejects.toThrow("nothing changed");
    expect(deps.run).not.toHaveBeenCalled();
    expect(deps.confirm).not.toHaveBeenCalled();
  });

  it.each(["missing", "partial", "not-loaded"])("refuses native update with %s services before mutation", async (state) => {
    const deps = fixture(piInstall);
    if (state === "not-loaded") deps.capture.mockResolvedValue("not-found");
    else deps.exists.mockImplementation((path) => state === "partial" && path.includes("sessiond"));
    await expect(runPiWebUpdate(["--yes"], deps)).rejects.toThrow("nothing changed");
    expect(deps.run).not.toHaveBeenCalled();
  });

  it("never dispatches nested restart after install failure", async () => {
    const deps = fixture(globalInstall);
    deps.env = { ...deps.env, ...{ PI_WEB_SESSION: "1" } };
    deps.run.mockRejectedValueOnce(new Error("install failed"));
    await expect(runPiWebUpdate(["--yes"], deps)).rejects.toThrow("install failed");
    expect(deps.run).toHaveBeenCalledOnce();
    expect(deps.run.mock.calls[0]?.[0].executable).toBe("npm");
  });

  it("reports dispatch failure after install without claiming restart success", async () => {
    const deps = fixture(piInstall);
    deps.env = { ...deps.env, ...{ PI_WEB_SESSION: "1" } };
    deps.run.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("dispatch failed"));
    await expect(runPiWebUpdate(["--yes"], deps)).rejects.toThrow("dispatch failed");
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining("Restart dispatched"));
  });

  it("cancels nested update after preflight without installing or dispatching restart", async () => {
    const deps = fixture(piInstall);
    deps.env = { ...deps.env, ...{ PI_WEB_SESSION: "1" } };
    deps.confirm.mockResolvedValue(false);
    await runPiWebUpdate([], deps);
    expect(deps.capture).toHaveBeenCalledWith(expect.objectContaining({ executable: "systemd-run" }));
    expect(deps.run).not.toHaveBeenCalled();
  });

  it("pins global npm to the detected installation and restarts that CLI only afterwards", async () => {
    const deps = fixture(globalInstall);
    await runPiWebUpdate(["--yes"], deps);
    const npmPrefix = basename(dirname(globalInstall.npmRoot ?? "")) === "lib" ? dirname(dirname(globalInstall.npmRoot ?? "")) : dirname(globalInstall.npmRoot ?? "");
    expect(deps.capture).toHaveBeenCalledWith({ executable: "npm", args: ["root", "--global", "--prefix", npmPrefix], env: deps.env });
    expect(deps.run.mock.calls.map(([command]) => [command.executable, command.args])).toEqual([
      ["npm", ["install", "--global", "--prefix", resolve(npmPrefix), "@jmfederico/pi-web@latest", "--allow-scripts=node-pty"]],
      ["/tools/node", [join("/opt/node/lib/node_modules/@jmfederico/pi-web", "dist", "cli.js"), "restart"]],
    ]);
  });

  it("refuses a changed npm root rather than updating another global installation", async () => {
    const deps = fixture(globalInstall);
    deps.capture.mockResolvedValue("/other/node_modules");
    await expect(runPiWebUpdate(["--yes"], deps)).rejects.toThrow("does not match");
    expect(deps.run).not.toHaveBeenCalled();
  });

  it("refuses a package nested inside a global package", async () => {
    const deps = fixture({ ...globalInstall, path: join(globalInstall.path ?? "", "nested") });
    await expect(runPiWebUpdate(["--yes"], deps)).rejects.toThrow("does not match");
    expect(deps.run).not.toHaveBeenCalled();
  });

  it("updates the explicit Pi package with this installation's Pi, active profile, and project scope disabled", async () => {
    const deps = fixture(piInstall);
    await runPiWebUpdate(["--yes"], deps);
    expect(deps.detectInstallation).toHaveBeenCalledWith("/profiles/active agent");
    expect(deps.run.mock.calls[0]).toEqual([{
      executable: "/tools/node", args: ["/owned/pi/dist/cli.js", "update", "--no-approve", "--extension", "npm:@jmfederico/pi-web"],
      env: { PATH: "/tools/bin", PI_CODING_AGENT_DIR: "/profiles/active agent" },
    }]);
    expect(deps.run.mock.calls[1]?.[0].args).toEqual([join(piInstall.path ?? "", "dist", "cli.js"), "restart"]);
  });

  it.each([{ scope: "project" as const }, { source: "/local/checkout" }, { source: "" }])("refuses unsafe Pi package metadata %j", async (override) => {
    const deps = fixture({ ...piInstall, ...override });
    await expect(runPiWebUpdate(["--yes"], deps)).rejects.toThrow("Only user-scope remote Pi packages");
    expect(deps.run).not.toHaveBeenCalled();
  });

  it.each([globalInstall, piInstall])("never restarts after an install failure ($kind)", async (installation) => {
    const deps = fixture(installation);
    deps.run.mockRejectedValueOnce(new Error("install failed"));
    await expect(runPiWebUpdate(["--yes"], deps)).rejects.toThrow("install failed");
    expect(deps.run).toHaveBeenCalledOnce();
  });

  it("does not silently succeed when restart fails", async () => {
    const deps = fixture(piInstall);
    deps.run.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("restart failed"));
    await expect(runPiWebUpdate(["--yes"], deps)).rejects.toThrow("restart failed");
  });

  it("fails closed if the active profile cannot be resolved", async () => {
    const deps = fixture(piInstall);
    deps.agentDir.mockRejectedValue(new Error("invalid active profile"));
    await expect(runPiWebUpdate(["--yes"], deps)).rejects.toThrow("invalid active profile");
    expect(deps.detectInstallation).not.toHaveBeenCalled();
    expect(deps.run).not.toHaveBeenCalled();
  });
});
