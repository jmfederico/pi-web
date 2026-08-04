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
