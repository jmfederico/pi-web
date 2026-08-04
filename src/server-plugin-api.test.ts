import { readFile } from "node:fs/promises";
import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  JsonObject,
  PiWebServerPlugin,
  ProjectInput,
  ProviderRequestContext,
  ServerPluginActivation,
  ServerPluginActivationContext,
  ServerPluginExecFileRequest,
  ServerPluginExecFileResult,
  WorkspaceProvider,
} from "@jmfederico/pi-web/server-plugin-api";

const project: ProjectInput = { id: "project-1", name: "Project", path: "/repo" };
const commandResult: ServerPluginExecFileResult = {
  exitCode: 0,
  signal: null,
  stdout: "ok",
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
};

describe("public server plugin API", () => {
  it("supports one lifecycle-owned workspace provider with JSON request and removal capabilities", async () => {
    const observedSignals: AbortSignal[] = [];
    const provider: WorkspaceProvider = {
      fallback: false,
      probe(_project, signal) {
        observedSignals.push(signal);
        return Promise.resolve("claim");
      },
      list(_project, signal) {
        observedSignals.push(signal);
        return Promise.resolve([{
          key: "secondary",
          path: "/repo/secondary",
          label: "secondary",
          isMain: false,
          data: { privateRevision: 2 },
          publicMetadata: { changeId: "abc" },
          removal: { actionLabel: "Remove workspace", confirmation: "Remove secondary?" },
        }]);
      },
      request(context) {
        observedSignals.push(context.signal);
        return Promise.resolve({ operation: context.operation, input: context.input });
      },
      prepareRemove(context) {
        observedSignals.push(context.signal);
        return Promise.resolve({ title: "Remove secondary", command: "provider workspace remove secondary" });
      },
    };
    const plugin: PiWebServerPlugin = {
      apiVersion: 1,
      name: "Neutral contract fixture",
      activate: () => ({
        workspaceProvider: provider,
        start: (signal) => { observedSignals.push(signal); },
        stop: (signal) => { observedSignals.push(signal); },
        health: (signal) => {
          observedSignals.push(signal);
          return { status: "healthy", details: { executable: true } };
        },
      }),
    };
    const signal = AbortSignal.timeout(1_000);
    const settings: JsonObject = { mode: "test", nested: [1, true, null] };
    const activation = await plugin.activate({
      apiVersion: 1,
      pluginId: "neutral-fixture",
      packageRoot: "/plugins/neutral-fixture",
      settings,
      signal,
      logger: {
        debug() { /* no-op */ },
        info() { /* no-op */ },
        warn() { /* no-op */ },
        error() { /* no-op */ },
      },
      execFile: () => Promise.resolve(commandResult),
    });

    await exerciseActivation(activation, project, signal);

    expect(observedSignals).toHaveLength(7);
    expect(observedSignals.every((observed) => observed === signal)).toBe(true);
  });

  it("keeps host frameworks and concrete services out of the declaration surface", async () => {
    expectTypeOf<keyof ServerPluginActivationContext>().toEqualTypeOf<
      "apiVersion" | "pluginId" | "packageRoot" | "logger" | "settings" | "execFile" | "signal"
    >();
    expectTypeOf<keyof WorkspaceProvider>().toEqualTypeOf<
      "fallback" | "probe" | "list" | "request" | "prepareRemove"
    >();
    expectTypeOf<keyof ServerPluginExecFileRequest>().toEqualTypeOf<
      "file" | "args" | "cwd" | "env" | "unsetEnv" | "timeoutMs" | "signal"
    >();

    const source = await readFile("src/server-plugin-api.ts", "utf8");
    expect(source).not.toMatch(/\b(?:Fastify|WorkspaceService|ProjectService|TerminalService|SessionDaemonClient)\b/u);
    expect(source).not.toMatch(/event\s*bus|service\s*locator|registerRoute/iu);
    expect(source).not.toMatch(/^import\s/mu);
  });
});

async function exerciseActivation(activation: ServerPluginActivation, input: ProjectInput, signal: AbortSignal): Promise<void> {
  await activation.start?.(signal);
  const provider = activation.workspaceProvider;
  if (provider === undefined) throw new Error("Expected fixture workspace provider");
  await provider.probe(input, signal);
  const [workspace] = await provider.list(input, signal);
  if (workspace === undefined) throw new Error("Expected fixture workspace");
  const request: ProviderRequestContext = { project: input, workspace, operation: "status", input: { paths: [] }, signal };
  await provider.request?.(request);
  await provider.prepareRemove?.({ project: input, workspace, signal });
  await activation.health?.(signal);
  await activation.stop?.(signal);
}
