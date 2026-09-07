import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const tempRoots: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("server plugin runtime child-process fixtures", () => {
  it("never imports safe-start skips and contains import, activation, start, and stop failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-server-plugin-child-"));
    tempRoots.push(root);
    const eventsPath = join(root, "events.log");
    const poisonMarker = join(root, "poison-imported");
    const modules = new Map<string, string>([
      ["alpha", lifecycleModule("Alpha", eventsPath, "alpha")],
      ["bad-activate", `export default { apiVersion: 1, name: "Bad activate", activate() { throw new Error("activate fixture failed"); } };`],
      ["bad-import", `throw new Error("import fixture failed");`],
      ["bad-start", lifecycleModule("Bad start", eventsPath, "bad-start", { failStart: true })],
      ["poison", `
        import { writeFileSync } from "node:fs";
        writeFileSync(${JSON.stringify(poisonMarker)}, "imported");
        throw new Error("safe-start skip imported");
      `],
      ["zeta", lifecycleModule("Zeta", eventsPath, "zeta", { failStop: true })],
    ]);
    const entries: unknown[] = [];
    for (const [id, source] of modules) {
      const pluginRoot = join(root, id);
      const modulePath = join(pluginRoot, "server.mjs");
      await mkdir(pluginRoot, { recursive: true });
      await writeFile(modulePath, source, "utf8");
      entries.push({
        id,
        packageRoot: pluginRoot,
        serverModule: { path: "server.mjs", filePath: modulePath, revision: "1" },
        source: id === "poison" ? "fixture-local" : "bundled",
        scope: id === "poison" ? "local" : "bundled",
        machineSpecific: false,
        enabled: true,
        settings: {},
        settingsRevision: "settings-1",
      });
    }

    const runnerPath = join(root, "runner.mjs");
    const runtimeUrl = pathToFileURL(resolve("src/server/plugins/serverPluginRuntime.ts")).href;
    await writeFile(runnerPath, `
      import { createServerPluginRuntime } from ${JSON.stringify(runtimeUrl)};
      const snapshot = { plugins: ${JSON.stringify(entries)}, diagnostics: [] };
      const logger = { debug() {}, info() {}, warn() {}, error() {} };
      const runtime = await createServerPluginRuntime({
        catalog: { snapshot: async () => snapshot },
        safeStart: "bundled-only",
        logger,
        lifecycleTimeoutMs: 500,
        enforceRequiredTerminal: false,
      });
      const beforeStop = runtime.healthRecords();
      const providers = runtime.providerContributions().map((item) => item.pluginId);
      await runtime.stop();
      process.stdout.write(JSON.stringify({ beforeStop, afterStop: runtime.healthRecords(), providers }));
    `, "utf8");

    const result = await execFileAsync(process.execPath, ["--import", "tsx", runnerPath], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    const output: unknown = JSON.parse(result.stdout);

    expect(output).toMatchObject({
      beforeStop: [
        { pluginId: "alpha", state: "active" },
        { pluginId: "bad-activate", state: "failed", phase: "activate", message: "activate fixture failed" },
        { pluginId: "bad-import", state: "failed", phase: "import", message: "import fixture failed" },
        { pluginId: "bad-start", state: "failed", phase: "start", message: "start fixture failed" },
        { pluginId: "poison", state: "disabled", message: "disabled by bundled-only safe start" },
        { pluginId: "zeta", state: "active" },
      ],
      providers: ["alpha", "zeta"],
    });
    expect(findRuntimeRecord(output, "afterStop", "zeta")).toMatchObject({
      pluginId: "zeta",
      state: "failed",
      phase: "stop",
      message: "stop fixture failed",
    });
    expect(existsSync(poisonMarker)).toBe(false);
    expect((await readFile(eventsPath, "utf8")).trim().split("\n")).toEqual([
      "start:alpha",
      "start:bad-start",
      "stop:bad-start",
      "start:zeta",
      "stop:zeta",
      "stop:alpha",
    ]);
  });

  it.skipIf(process.platform === "win32")(
    "keeps Terminal's notice reporter active while a later plugin is still stopping",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "pi-web-server-plugin-terminal-stop-child-"));
      tempRoots.push(root);
      const failureMarker = join(root, "fail-terminal-command");
      const runnerPath = join(root, "runner.mjs");
      const runtimeUrl = pathToFileURL(resolve("src/server/plugins/serverPluginRuntime.ts")).href;
      const terminalPluginUrl = pathToFileURL(resolve("pi-web-plugins/terminal/server/server-plugin.ts")).href;
      const terminalModulePath = resolve("pi-web-plugins/terminal/server/server-plugin.ts");
      const commandMarker = `'${failureMarker.replaceAll("'", "'\\''")}'`;
      const command = `while [ ! -f ${commandMarker} ]; do sleep 0.01; done; exit 7`;
      const entries = [
        {
          id: "pi-web.terminal",
          packageRoot: resolve("pi-web-plugins/terminal"),
          browserModule: { path: "browser/pi-web-plugin.js", filePath: resolve("pi-web-plugins/terminal/pi-web-plugin.ts"), revision: "terminal-r1" },
          serverModule: { path: "server-plugin.js", filePath: terminalModulePath, revision: "terminal-r1" },
          source: "bundled",
          scope: "bundled",
          machineSpecific: true,
          enabled: true,
          settings: {},
          settingsRevision: "settings-1",
        },
        {
          id: "stop-blocker",
          packageRoot: root,
          serverModule: { path: "server.mjs", filePath: join(root, "server.mjs"), revision: "blocker-r1" },
          source: "fixture",
          scope: "local",
          machineSpecific: false,
          enabled: true,
          settings: {},
          settingsRevision: "settings-1",
        },
      ];
      await writeFile(runnerPath, `
        import { writeFileSync } from "node:fs";
        import terminalPlugin from ${JSON.stringify(terminalPluginUrl)};
        import { createServerPluginRuntime } from ${JSON.stringify(runtimeUrl)};

        let resolveNotice = () => undefined;
        const noticeObserved = new Promise((resolve) => { resolveNotice = resolve; });
        const blockerPlugin = {
          apiVersion: 1,
          name: "Stop blocker",
          activate() {
            return {
              async stop() {
                writeFileSync(${JSON.stringify(failureMarker)}, "fail");
                await new Promise((resolve, reject) => {
                  const timeout = setTimeout(() => { reject(new Error("Terminal failure notice was not observed")); }, 2_000);
                  noticeObserved.then(() => { clearTimeout(timeout); resolve(); }, reject);
                });
              }
            };
          }
        };
        const notices = [];
        const activity = [];
        const runtime = await createServerPluginRuntime({
          catalog: { snapshot: async () => ({ plugins: ${JSON.stringify(entries)}, diagnostics: [] }) },
          importer: async (url) => url.startsWith(${JSON.stringify(terminalPluginUrl)})
            ? { default: terminalPlugin }
            : { default: blockerPlugin },
          logger: { debug() {}, info() {}, warn() {}, error() {} },
          noticeSink(source, input) {
            notices.push({ source, input });
            resolveNotice();
          },
        });
        const terminal = runtime.requiredTerminalService();
        terminal.bindActivitySink({
          updateTerminal(value) { activity.push({ kind: "update", ...value }); },
          removeTerminal(id, cwd) { activity.push({ kind: "remove", id, cwd }); },
        });
        const run = terminal.runCommand({
          origin: "core",
          projectId: "project-1",
          workspaceId: "workspace-1",
          cwd: process.cwd(),
          title: "Remove workspace",
          command: ${JSON.stringify(command)},
          failureNotice: {
            message: "Workspace removal failed. See terminal output.",
            context: { targetWorkspaceId: "workspace-1" },
          },
        });
        await runtime.stop();
        process.stdout.write(JSON.stringify({ run, notices, activity }));
      `, "utf8");

      const result = await execFileAsync(process.execPath, [
        "--force-node-api-uncaught-exceptions-policy",
        "--import",
        "tsx",
        runnerPath,
      ], {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 10_000,
      });
      const output: unknown = JSON.parse(result.stdout);
      if (!isRecord(output)) throw new Error("Expected Terminal shutdown fixture output");
      const run = output["run"];
      if (!isRecord(run) || typeof run["id"] !== "string") throw new Error("Expected Terminal command run");

      expect(output["notices"]).toEqual([{
        source: "plugin:pi-web.terminal",
        input: {
          severity: "error",
          message: "Workspace removal failed. See terminal output.",
          scope: { projectId: "project-1" },
          context: { targetWorkspaceId: "workspace-1", commandRunId: run["id"] },
        },
      }]);
      expect(output["activity"]).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "update", id: run["terminalId"], exited: false }),
        expect.objectContaining({ kind: "update", id: run["terminalId"], exited: true }),
      ]));
    },
  );

  it("applies emergency no-server-plugin safe start before a bundled module can import", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-server-plugin-emergency-child-"));
    tempRoots.push(root);
    const markerPath = join(root, "bundled-imported");
    const pluginRoot = join(root, "bundled-poison");
    const modulePath = join(pluginRoot, "server.mjs");
    await mkdir(pluginRoot, { recursive: true });
    await writeFile(modulePath, `
      import { writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(markerPath)}, "imported");
      process.exit(97);
    `, "utf8");
    const runnerPath = join(root, "runner.mjs");
    const runtimeUrl = pathToFileURL(resolve("src/server/plugins/serverPluginRuntime.ts")).href;
    await writeFile(runnerPath, `
      import { createServerPluginRuntime } from ${JSON.stringify(runtimeUrl)};
      const logger = { debug() {}, info() {}, warn() {}, error() {} };
      const runtime = await createServerPluginRuntime({
        catalog: { snapshot: async () => { throw new Error("safe start must bypass catalog discovery"); } },
        safeStart: "none",
        logger,
      });
      process.stdout.write(JSON.stringify(runtime.healthRecords()));
    `, "utf8");

    const result = await execFileAsync(process.execPath, ["--import", "tsx", runnerPath], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    const records: unknown = JSON.parse(result.stdout);

    expect(records).toEqual([]);
    expect(existsSync(markerPath)).toBe(false);
  });
});

function findRuntimeRecord(output: unknown, key: string, pluginId: string): Record<string, unknown> | undefined {
  if (!isRecord(output)) return undefined;
  const records = output[key];
  if (!Array.isArray(records)) return undefined;
  for (const candidate of records) {
    const record: unknown = candidate;
    if (isRecord(record) && record["pluginId"] === pluginId) return record;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function lifecycleModule(
  name: string,
  eventsPath: string,
  id: string,
  options: { failStart?: boolean; failStop?: boolean } = {},
): string {
  return `
    import { appendFileSync } from "node:fs";
    const record = (event) => appendFileSync(${JSON.stringify(eventsPath)}, event + "\\n");
    export default {
      apiVersion: 1,
      name: ${JSON.stringify(name)},
      activate() {
        return {
          workspaceProvider: {
            async probe() { return "pass"; },
            async list() { return []; }
          },
          start() {
            record(${JSON.stringify(`start:${id}`)});
            ${options.failStart === true ? `throw new Error("start fixture failed");` : ""}
          },
          stop() {
            record(${JSON.stringify(`stop:${id}`)});
            ${options.failStop === true ? `throw new Error("stop fixture failed");` : ""}
          }
        };
      }
    };
  `;
}
