import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  it.skipIf(process.platform === "win32")(
    "keeps Terminal's notice reporter active while a later plugin is still disposing",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "pi-web-server-plugin-terminal-stop-child-"));
      tempRoots.push(root);
      const failureMarker = join(root, "fail-terminal-command");
      const runnerPath = join(root, "runner.mjs");
      const runtimeUrl = pathToFileURL(resolve("src/server/plugins/serverPluginRuntime.ts")).href;
      const terminalCapabilityUrl = pathToFileURL(resolve("src/server/terminals/requiredTerminalService.ts")).href;
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
        import { REQUIRED_TERMINAL_SERVICE_CAPABILITY } from ${JSON.stringify(terminalCapabilityUrl)};

        let resolveNotice = () => undefined;
        const noticeObserved = new Promise((resolve) => { resolveNotice = resolve; });
        const blockerPlugin = {
          apiVersion: 3,
          name: "Stop blocker",
          activate() {
            return {
              async dispose() {
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
        dataDir: ${JSON.stringify(join(root, "data"))},
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
        const terminal = runtime.resolve(REQUIRED_TERMINAL_SERVICE_CAPABILITY);
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
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
