import { readFile } from "node:fs/promises";
import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  JsonObject,
  PairedPluginBackendV1,
  PairedPluginChannel,
  PairedPluginChannelCloseContext,
  PairedPluginChannelOpenContext,
  PairedPluginRequestContext,
  PairedPluginWorkspace,
  PiWebServerPlugin,
  ProjectInput,
  ProviderRemoveContext,
  ProviderRequestContext,
  ProviderWorkspace,
  ServerPluginActivation,
  ServerPluginActivationContext,
  ServerPluginExecFileRequest,
  ServerPluginExecFileResult,
  ServerPluginLogger,
  ServerPluginNoticeInput,
  ServerPluginNoticeReporterV1,
  WorkspaceProvider,
  WorkspaceRemovalPresentation,
  WorkspaceRemovePlan,
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

type IfEqual<Left, Right, Then, Else = never> =
  (<Value>(value: Value) => Value extends Left ? 1 : 2) extends
  (<Value>(value: Value) => Value extends Right ? 1 : 2) ? Then : Else;

type ReadonlyKeys<Value> = {
  [Key in keyof Value]-?: IfEqual<
    { [Property in Key]: Value[Property] },
    { -readonly [Property in Key]: Value[Property] },
    never,
    Key
  >;
}[keyof Value];

type WritableKeys<Value> = Exclude<keyof Value, ReadonlyKeys<Value>>;

describe("public server plugin API", () => {
  it("supports lifecycle-owned workspace providers and direct paired JSON requests", async () => {
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
        pairedBackend: {
          version: 1,
          request: (context) => {
            observedSignals.push(context.signal);
            return { operation: context.operation, workspaceId: context.workspace.id };
          },
        },
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
      notices: { version: 1, record() { /* no-op */ } },
      logger: {
        debug() { /* no-op */ },
        info() { /* no-op */ },
        warn() { /* no-op */ },
        error() { /* no-op */ },
      },
      execFile: () => Promise.resolve(commandResult),
    });

    await exerciseActivation(activation, project, signal);

    expect(observedSignals).toHaveLength(8);
    expect(observedSignals.every((observed) => observed === signal)).toBe(true);
  });

  it("keeps host inputs readonly and concrete services out of the declaration surface", async () => {
    expectTypeOf<keyof ServerPluginActivationContext>().toEqualTypeOf<
      "apiVersion" | "pluginId" | "packageRoot" | "logger" | "settings" | "notices" | "execFile" | "signal"
    >();
    expectTypeOf<keyof ServerPluginNoticeReporterV1>().toEqualTypeOf<"version" | "record">();
    expectTypeOf<keyof ServerPluginNoticeInput>().toEqualTypeOf<"severity" | "message" | "context">();
    expectTypeOf<keyof WorkspaceProvider>().toEqualTypeOf<
      "fallback" | "probe" | "list" | "request" | "prepareRemove"
    >();
    expectTypeOf<keyof PairedPluginBackendV1>().toEqualTypeOf<"version" | "request" | "openChannel">();
    expectTypeOf<keyof PairedPluginChannel>().toEqualTypeOf<"receive" | "closed" | "close">();
    expectTypeOf<keyof PairedPluginChannelOpenContext>().toEqualTypeOf<"project" | "workspace" | "operation" | "input" | "signal" | "send">();
    expectTypeOf<keyof PairedPluginChannelCloseContext>().toEqualTypeOf<"code" | "reason" | "signal">();
    expectTypeOf<keyof PairedPluginRequestContext>().toEqualTypeOf<
      "project" | "workspace" | "operation" | "input" | "signal"
    >();
    expectTypeOf<keyof ServerPluginExecFileRequest>().toEqualTypeOf<
      "file" | "args" | "cwd" | "env" | "unsetEnv" | "timeoutMs" | "signal"
    >();
    expectTypeOf<ReadonlyKeys<ServerPluginActivationContext>>().toEqualTypeOf<keyof ServerPluginActivationContext>();
    expectTypeOf<ReadonlyKeys<ServerPluginLogger>>().toEqualTypeOf<keyof ServerPluginLogger>();
    expectTypeOf<ReadonlyKeys<ServerPluginNoticeReporterV1>>().toEqualTypeOf<keyof ServerPluginNoticeReporterV1>();
    expectTypeOf<ReadonlyKeys<ServerPluginNoticeInput>>().toEqualTypeOf<keyof ServerPluginNoticeInput>();
    expectTypeOf<ReadonlyKeys<ProjectInput>>().toEqualTypeOf<keyof ProjectInput>();
    expectTypeOf<ReadonlyKeys<ProviderRequestContext>>().toEqualTypeOf<keyof ProviderRequestContext>();
    expectTypeOf<ReadonlyKeys<ProviderRemoveContext>>().toEqualTypeOf<keyof ProviderRemoveContext>();
    expectTypeOf<ReadonlyKeys<PairedPluginRequestContext>>().toEqualTypeOf<keyof PairedPluginRequestContext>();
    expectTypeOf<ReadonlyKeys<PairedPluginChannelOpenContext>>().toEqualTypeOf<keyof PairedPluginChannelOpenContext>();
    expectTypeOf<ReadonlyKeys<PairedPluginChannelCloseContext>>().toEqualTypeOf<keyof PairedPluginChannelCloseContext>();
    expectTypeOf<ReadonlyKeys<PairedPluginWorkspace>>().toEqualTypeOf<keyof PairedPluginWorkspace>();
    expectTypeOf<ReadonlyKeys<ProviderRequestContext["workspace"]>>().toEqualTypeOf<keyof ProviderWorkspace>();
    expectTypeOf<ReadonlyKeys<WorkspaceRemovalPresentation>>().toEqualTypeOf<keyof WorkspaceRemovalPresentation>();
    expectTypeOf<keyof WorkspaceRemovalPresentation>().toEqualTypeOf<"actionLabel" | "confirmation">();
    expectTypeOf<WritableKeys<ProviderWorkspace>>().toEqualTypeOf<keyof ProviderWorkspace>();
    expectTypeOf<WritableKeys<WorkspaceRemovePlan>>().toEqualTypeOf<keyof WorkspaceRemovePlan>();
    expectTypeOf<WritableKeys<ServerPluginActivation>>().toEqualTypeOf<keyof ServerPluginActivation>();

    const source = await readFile("src/server-plugin-api.ts", "utf8");
    expect(source).not.toMatch(/\b(?:Fastify|WorkspaceService|ProjectService|TerminalService|SessionDaemonClient)\b/u);
    expect(source).not.toMatch(/event\s*bus|service\s*locator|registerRoute/iu);
    expect(source).toContain('from "./shared/pluginApiTypes.js";');
    expect(source).not.toContain("./shared/apiTypes.js");
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
  await activation.pairedBackend?.request({
    project: input,
    workspace: {
      id: "workspace-1",
      projectId: input.id,
      path: workspace.path,
      label: workspace.label,
      isMain: workspace.isMain,
      provider: {
        pluginId: "neutral-fixture",
        capabilities: { request: true, remove: false },
      },
    },
    operation: "status",
    input: null,
    signal,
  });
  await activation.health?.(signal);
  await activation.stop?.(signal);
}
