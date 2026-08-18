import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pluginRecoveryHelp, runPluginRecoveryCli, type SessionDaemonRestartPlan } from "./pluginRecoveryCli.js";

let tempDir: string;
let configPath: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-web-plugin-recovery-cli-test-"));
  configPath = join(tempDir, "config.json");
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("plugin recovery CLI", () => {
  it("prints focused help without reading config", () => {
    const lines: string[] = [];

    runPluginRecoveryCli(["--help"], dependencies(lines));

    expect(lines.join("\n")).toBe(pluginRecoveryHelp());
    expect(lines.join("\n")).toContain("never contact the session daemon or import plugins");
  });

  it("rejects invalid plugin ids before creating config", async () => {
    expect(() => {
      runPluginRecoveryCli(
        ["disable", "Not/A/Plugin", "--config", configPath],
        dependencies([]),
      );
    }).toThrow("Invalid PI WEB plugin id");
    await expect(readFile(configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("disables through an explicit config path and prints restart guidance", async () => {
    const lines: string[] = [];

    runPluginRecoveryCli(
      ["disable", "broken-provider", `--config=${configPath}`],
      dependencies(lines),
    );

    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
      plugins: { "broken-provider": { enabled: false } },
    });
    expect(lines).toEqual([
      `Disabled server plugin "broken-provider" in ${configPath}.`,
      "Restart the session daemon to apply this change. Active sessions owned by that daemon may stop.",
      "Run:",
      "  fake-service restart sessiond",
    ]);
  });

  it("shows malformed safe start fail-closed, then repairs and clears it offline", async () => {
    const lines: string[] = [];
    const deps = dependencies(lines);
    await writeFile(configPath, `${JSON.stringify({ serverPlugins: { safeStart: "future-level" } })}\n`, "utf8");

    runPluginRecoveryCli(["safe-start", "show", "--config", configPath], deps);
    runPluginRecoveryCli(["safe-start", "set", "bundled-only", "--config", configPath], deps);
    runPluginRecoveryCli(["safe-start", "show", "--config", configPath], deps);
    runPluginRecoveryCli(["safe-start", "clear", "--config", configPath], deps);
    runPluginRecoveryCli(["safe-start", "show", "--config", configPath], deps);

    expect(lines).toContain("Server plugin safe start: none");
    expect(lines.some((line) => line.startsWith("Warning: ") && line.includes("No server plugins will be loaded"))).toBe(true);
    expect(lines).toContain("Server plugin safe start: bundled-only");
    expect(lines).toContain("Server plugin safe start: off");
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({});
  });

  it("disables a plugin beside malformed safe start with sessiond absent and no plugin imports", async () => {
    const markerPath = join(tempDir, "poison-imported");
    const pluginRoot = join(tempDir, "data", "plugins", "poison");
    await mkdir(pluginRoot, { recursive: true });
    await writeFile(configPath, `${JSON.stringify({ serverPlugins: { safeStart: "future-level" } })}\n`, "utf8");
    await writeFile(join(pluginRoot, "package.json"), `${JSON.stringify({
      piWeb: { plugins: [{ id: "poison", serverModule: "server.js" }] },
    })}\n`, "utf8");
    await writeFile(join(pluginRoot, "server.js"), `
      import { writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(markerPath)}, "imported");
      throw new Error("poison module must not import during recovery");
    `, "utf8");

    const result = await promisify(execFile)(process.execPath, [
      "--import",
      "tsx",
      "src/cli.ts",
      "plugins",
      "disable",
      "poison",
      "--config",
      configPath,
      "--restart",
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PI_WEB_DATA_DIR: join(tempDir, "data"),
        PI_WEB_SESSIOND_SOCKET: join(tempDir, "missing-sessiond.sock"),
      },
      encoding: "utf8",
    });

    expect(result.stdout).toContain("Disabled server plugin \"poison\"");
    expect(result.stdout).toContain("Warning: PI WEB config serverPlugins.safeStart");
    expect(result.stdout).toContain("cannot be restarted automatically");
    expect(result.stdout).toContain(`PI_WEB_CONFIG=${JSON.stringify(configPath)}`);
    expect(existsSync(markerPath)).toBe(false);
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
      serverPlugins: { safeStart: "future-level" },
      plugins: { poison: { enabled: false } },
    });
  });

  it("optionally performs an automatic restart after the durable config write", () => {
    const lines: string[] = [];
    const perform = vi.fn(() => {
      expect(readConfigSync(configPath)).toEqual({ serverPlugins: { safeStart: "none" } });
    });

    runPluginRecoveryCli(
      ["safe-start", "set", "none", "--config", configPath, "--restart"],
      dependencies(lines, { kind: "automatic", guidance: "Run:", command: "fake restart", perform }),
    );

    expect(perform).toHaveBeenCalledOnce();
    expect(lines.at(-1)).toBe("Session daemon restart requested. Active sessions owned by that daemon may stop.");
  });

  it("keeps a manual installation recoverable when --restart cannot be performed", () => {
    const lines: string[] = [];

    runPluginRecoveryCli(
      ["disable", "broken", "--config", configPath, "--restart"],
      dependencies(lines, { kind: "manual", guidance: "Restart the manually launched process." }),
    );

    expect(lines).toContain("The session daemon cannot be restarted automatically for this installation.");
    expect(lines).toContain("Restart the manually launched process.");
  });

  it.each([
    ["safe-start", "set", "future"],
    ["safe-start", "show", "--restart"],
    ["disable"],
    ["disable", "broken", "--config", "--restart"],
    ["unknown"],
  ])("rejects invalid command arguments: %s", (...args) => {
    expect(() => {
      runPluginRecoveryCli(args, dependencies([]));
    }).toThrow();
  });
});

function dependencies(
  lines: string[],
  plan: SessionDaemonRestartPlan = { kind: "automatic", guidance: "Run:", command: "fake-service restart sessiond" },
) {
  return {
    writeLine: (line: string) => { lines.push(line); },
    restartPlan: () => plan,
  };
}

function readConfigSync(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}
