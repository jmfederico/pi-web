import { describe, expect, it } from "vitest";
import {
  PI_WEB_DOCKER_USER_COMMANDS,
  parsePiWebDockerArgs,
  piWebDockerCommand,
  piWebDockerCommandPrefix,
  planPiWebDockerDevHostCommand,
  planPiWebDockerRuntimeHostCommand,
  validatePiWebDockerDevRootSafety,
} from "./piWebDockerCommandPlan.js";

describe("pi-web-docker command planning", () => {
  it("plans runtime commands by default", () => {
    expect(parsePiWebDockerArgs(["status"])).toEqual({
      ok: true,
      plan: { mode: "runtime", command: "status", allowRoot: false, args: [] },
    });
  });

  it("emits runtime commands by default and development commands explicitly", () => {
    expect(parsePiWebDockerArgs(["--dev", "restart-sessiond"])).toEqual({
      ok: true,
      plan: { mode: "dev", command: "restart-sessiond", allowRoot: false, args: [] },
    });
    expect(piWebDockerCommandPrefix(undefined)).toBe("pi-web-docker");
    expect(piWebDockerCommandPrefix("runtime")).toBe("pi-web-docker");
    expect(piWebDockerCommandPrefix("dev")).toBe("pi-web-docker --dev");
    expect(piWebDockerCommand(undefined, "status")).toBe("pi-web-docker status");
    expect(piWebDockerCommand("runtime", "update")).toBe("pi-web-docker update");
    expect(piWebDockerCommand("dev", "status")).toBe("pi-web-docker --dev status");
  });

  it("keeps production install out of development mode", () => {
    expect(parsePiWebDockerArgs(["install", "--install-dir", "/srv/pi-web-docker"])).toEqual({
      ok: true,
      plan: { mode: "runtime", command: "install", allowRoot: false, args: ["--install-dir", "/srv/pi-web-docker"] },
    });
    expect(parsePiWebDockerArgs(["--dev", "install"])).toEqual({
      ok: false,
      errors: ["install is only available in runtime mode"],
    });
  });

  it("validates logs and shell targets", () => {
    expect(parsePiWebDockerArgs(["--dev", "logs", "data-init"])).toEqual({
      ok: true,
      plan: { mode: "dev", command: "logs", allowRoot: false, args: ["data-init"], target: "data-init" },
    });
    expect(parsePiWebDockerArgs(["logs", "data-init"])).toEqual({
      ok: false,
      errors: ["logs data-init is only available in development mode"],
    });
    expect(parsePiWebDockerArgs(["shell"])).toEqual({
      ok: true,
      plan: { mode: "runtime", command: "shell", allowRoot: false, args: [], target: "web" },
    });
    expect(parsePiWebDockerArgs(["shell", "data-init"])).toEqual({
      ok: false,
      errors: ["Invalid shell target: data-init"],
    });
  });

  it("treats cli as the pi-web escape hatch", () => {
    expect(parsePiWebDockerArgs(["cli", "config", "show"])).toEqual({
      ok: true,
      plan: { mode: "runtime", command: "cli", allowRoot: false, args: ["config", "show"] },
    });
    expect(parsePiWebDockerArgs(["cli"])).toEqual({ ok: false, errors: ["cli requires pi-web arguments"] });
  });

  it("keeps the canonical user command surface parseable", () => {
    const sampleArgs = new Map<string, string[]>([
      ["install", ["--asset-ref", "release"]],
      ["logs", ["web"]],
      ["shell", ["sessiond"]],
      ["cli", ["config", "show"]],
    ]);

    for (const command of PI_WEB_DOCKER_USER_COMMANDS) {
      const parsed = parsePiWebDockerArgs([command, ...(sampleArgs.get(command) ?? [])]);
      expect(parsed).toMatchObject({ ok: true });
    }
  });

  it("rejects unknown options and unexpected positional arguments", () => {
    expect(parsePiWebDockerArgs(["--prod", "status"])).toEqual({ ok: false, errors: ["Unknown global option: --prod"] });
    expect(parsePiWebDockerArgs(["status", "web"])).toEqual({ ok: false, errors: ["status does not accept positional arguments"] });
    expect(parsePiWebDockerArgs(["restart-sessiond", "web"])).toEqual({ ok: false, errors: ["restart-sessiond does not accept positional arguments"] });
    expect(parsePiWebDockerArgs([])).toEqual({ ok: false, errors: ["Missing command"] });
  });

  it("parses root override as an explicit global option", () => {
    expect(parsePiWebDockerArgs(["--dev", "--allow-root", "status"])).toEqual({
      ok: true,
      plan: { mode: "dev", command: "status", allowRoot: true, args: [] },
    });
  });

  it("plans production host commands through installer or Compose actions", () => {
    expect(runtimeHostPlan(["install", "--asset-ref", "release"])).toEqual({
      kind: "installer",
      action: "install",
      args: ["--asset-ref", "release"],
      useRuntimeRootAsInstallDir: false,
    });
    expect(runtimeHostPlan(["update"])).toEqual({ kind: "installer", action: "update", args: [], useRuntimeRootAsInstallDir: true });
    expect(runtimeHostPlan(["start"])).toEqual({ kind: "compose", args: ["up", "-d"] });
    expect(runtimeHostPlan(["stop"])).toEqual({ kind: "compose", args: ["down"] });
    expect(runtimeHostPlan(["restart"])).toEqual({ kind: "compose", args: ["restart", "web", "sessiond"] });
    expect(runtimeHostPlan(["status"])).toEqual({ kind: "compose", args: ["ps"] });
    expect(runtimeHostPlan(["logs", "web"])).toEqual({ kind: "compose", args: ["logs", "-f", "web"] });
    expect(runtimeHostPlan(["shell"])).toEqual({ kind: "compose", args: ["exec", "web", "bash"] });
    expect(runtimeHostPlan(["cli", "config", "show"])).toEqual({ kind: "compose", args: ["exec", "web", "pi-web", "config", "show"] });
  });

  it("plans development host commands through the generated dev Compose environment", () => {
    expect(devHostPlan(["--dev", "start"])).toEqual({ kind: "compose", args: ["up", "-d", "--build"], usesGeneratedEnv: true });
    expect(devHostPlan(["--dev", "status"])).toEqual({ kind: "compose", args: ["ps"], usesGeneratedEnv: true });
    expect(devHostPlan(["--dev", "logs", "data-init"])).toEqual({ kind: "compose", args: ["logs", "-f", "data-init"], usesGeneratedEnv: true });
    expect(devHostPlan(["--dev", "shell"])).toEqual({ kind: "compose", args: ["exec", "web", "bash"], usesGeneratedEnv: true });
    expect(devHostPlan(["--dev", "cli", "config", "show"])).toEqual({ kind: "compose", args: ["exec", "web", "pi-web", "config", "show"], usesGeneratedEnv: true });
    expect(devHostPlan(["--dev", "update"])).toEqual({
      kind: "updateSequence",
      usesGeneratedEnv: true,
      steps: [
        { kind: "gitFastForward", onFailure: "warn" },
        { kind: "compose", args: ["build", "--pull"] },
        { kind: "compose", args: ["up", "-d", "--force-recreate", "--remove-orphans"] },
      ],
    });
  });

  it("keeps development root safety explicit in command planning", () => {
    const parsed = parsePiWebDockerArgs(["--dev", "status"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
    expect(validatePiWebDockerDevRootSafety(parsed.plan, 0)).toBe("refusing to run Docker development mode as root; retry with --allow-root if this is intentional");
    expect(validatePiWebDockerDevRootSafety({ ...parsed.plan, allowRoot: true }, 0)).toBeUndefined();
    expect(validatePiWebDockerDevRootSafety(parsed.plan, 500)).toBeUndefined();
  });

  it("does not apply production host planning to development mode", () => {
    const parsed = parsePiWebDockerArgs(["--dev", "status"]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(planPiWebDockerRuntimeHostCommand(parsed.plan)).toBeUndefined();
  });

  it("does not apply development host planning to production mode", () => {
    const parsed = parsePiWebDockerArgs(["status"]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(planPiWebDockerDevHostCommand(parsed.plan)).toBeUndefined();
  });
});

function runtimeHostPlan(argv: string[]) {
  const parsed = parsePiWebDockerArgs(argv);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
  return planPiWebDockerRuntimeHostCommand(parsed.plan);
}

function devHostPlan(argv: string[]) {
  const parsed = parsePiWebDockerArgs(argv);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
  return planPiWebDockerDevHostCommand(parsed.plan);
}
