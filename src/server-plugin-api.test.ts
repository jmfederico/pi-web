import { readFile } from "node:fs/promises";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  PI_WEB_HOST_PI_SESSIONS_CAPABILITY,
  PI_WEB_HOST_WORKSPACES_CAPABILITY,
} from "./server-plugin-api.js";
import type {
  JsonObject,
  PiWebHostPiSessionRun,
  PiWebHostPiSessionRunCompletion,
  PiWebHostPiSessionRunInput,
  PiWebHostPiSessionsV1,
  PiWebHostWorkspaceAuthority,
  PiWebHostWorkspaceSelection,
  PiWebHostWorkspacesV1,
  PluginCapability,
  PluginCapabilityProvision,
  ServerPluginCapabilityResolver,
  ServerPluginPeer,
  ServerPluginPeerChannel,
  ServerPluginPeerChannelCloseContext,
  ServerPluginPeerChannelOpenContext,
  ServerPluginPeerRequestContext,
  ServerPluginPeerWorkspace,
  PiWebServerPlugin,
  ProjectInput,
  ProviderRemoveContext,
  ProviderWorkspace,
  ServerPluginActivation,
  ServerPluginActivationContext,
  ServerPluginExecFileRequest,
  ServerPluginExecFileResult,
  ServerPluginLogger,
  ServerPluginNoticeInput,
  ServerPluginStartContext,
  ServerPluginNoticeReporterV1,
  ServerPluginNoticeScope,
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

interface FixtureCapability {
  readonly label: string;
}

const dependencyCapability = Object.freeze({
  pluginId: "fixture.provider",
  id: "service",
  version: 1,
  parse(value: unknown): FixtureCapability {
    if (typeof value !== "object" || value === null || !("label" in value)) {
      throw new Error("Fixture capability is invalid");
    }
    const label: unknown = value.label;
    if (typeof label !== "string") throw new Error("Fixture capability is invalid");
    return Object.freeze({ label });
  },
}) satisfies PluginCapability<FixtureCapability, 1>;

const providedCapability = Object.freeze({
  pluginId: "neutral-fixture",
  id: "snapshot",
  version: 2,
  parse: dependencyCapability.parse,
}) satisfies PluginCapability<FixtureCapability, 2>;

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
  it("supports lifecycle-owned providers, peers, and typed capability composition", async () => {
    const observedSignals: AbortSignal[] = [];
    const observedLifetimes: AbortSignal[] = [];
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
      prepareRemove(context) {
        observedSignals.push(context.signal);
        return Promise.resolve({ title: "Remove secondary", command: "provider workspace remove secondary" });
      },
    };
    const plugin: PiWebServerPlugin = {
      apiVersion: 3,
      name: "Neutral contract fixture",
      requires: [dependencyCapability],
      activate: ({ lifetimeSignal }) => {
        observedLifetimes.push(lifetimeSignal);
        return {
          workspaceProvider: provider,
          peer: {
            request: (context) => {
              observedSignals.push(context.signal);
              return { operation: context.operation, workspaceId: context.workspace.id };
            },
          },
          provides: [{ capability: providedCapability, value: { label: "snapshot" } }],
          start: ({ capabilities, signal }) => {
            observedSignals.push(signal);
            if (capabilities.resolve(dependencyCapability).label !== "dependency") {
              throw new Error("Expected resolved fixture dependency");
            }
          },
          dispose: (signal) => { observedSignals.push(signal); },
          health: (signal) => {
            observedSignals.push(signal);
            return { status: "healthy", details: { executable: true } };
          },
        };
      },
    };
    const signal = AbortSignal.timeout(1_000);
    const settings: JsonObject = { mode: "test", nested: [1, true, null] };
    const lifetimeController = new AbortController();
    const activation = await plugin.activate({
      apiVersion: 3,
      pluginId: "neutral-fixture",
      packageRoot: "/plugins/neutral-fixture",
      dataDirectory: "/data/plugin-data/neutral-fixture",
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
      lifetimeSignal: lifetimeController.signal,
    });

    await exerciseActivation(activation, project, signal);

    expect(observedSignals).toHaveLength(7);
    expect(observedSignals.every((observed) => observed === signal)).toBe(true);
    expect(observedLifetimes).toEqual([lifetimeController.signal]);
  });

  it("exports the exact frozen workspaces v1 token and snapshots resolved authority", async () => {
    const sourceProject = { id: "project-1", name: "Project", path: "/repo", createdAt: "private" };
    const sourceWorkspace = {
      id: "workspace-1",
      projectId: "project-1",
      path: "/repo/worktree",
      label: "Worktree",
      isMain: false,
      provider: {
        pluginId: "workspace-provider",
        capabilities: { remove: true },
        metadata: { revision: 1, nested: [true] },
      },
      privateData: { secret: true },
      removal: { precondition: "host-only" },
    };
    const resolveAuthority = vi.fn((selectionInput: PiWebHostWorkspaceSelection) => {
      void selectionInput;
      return Promise.resolve({ project: sourceProject, workspace: sourceWorkspace });
    });
    const source = { version: 1 as const, resolve: resolveAuthority };

    const workspaces = PI_WEB_HOST_WORKSPACES_CAPABILITY.parse(source);
    Reflect.set(source, "resolve", () => Promise.reject(new Error("mutated resolver was used")));
    const selection = { projectId: "project-1", workspaceId: "workspace-1" };
    const authority = await workspaces.resolve(selection);
    sourceProject.name = "Mutated";
    sourceWorkspace.label = "Mutated";
    sourceWorkspace.provider.metadata.revision = 2;

    expect(PI_WEB_HOST_WORKSPACES_CAPABILITY).toMatchObject({
      pluginId: "pi-web.host",
      id: "workspaces",
      version: 1,
    });
    expect(Object.isFrozen(PI_WEB_HOST_WORKSPACES_CAPABILITY)).toBe(true);
    expect(resolveAuthority).toHaveBeenCalledWith(selection);
    expect(Object.isFrozen(resolveAuthority.mock.calls[0]?.[0])).toBe(true);
    expect(authority).toEqual({
      project: { id: "project-1", name: "Project", path: "/repo" },
      workspace: {
        id: "workspace-1",
        projectId: "project-1",
        path: "/repo/worktree",
        label: "Worktree",
        isMain: false,
        provider: {
          pluginId: "workspace-provider",
          capabilities: { remove: true },
          metadata: { revision: 1, nested: [true] },
        },
      },
    });
    expect(Object.isFrozen(authority)).toBe(true);
    expect(Object.isFrozen(authority.project)).toBe(true);
    expect(Object.isFrozen(authority.workspace)).toBe(true);
    expect(Object.isFrozen(authority.workspace.provider)).toBe(true);
    expect(Object.isFrozen(authority.workspace.provider?.metadata)).toBe(true);
    expect(() => PI_WEB_HOST_WORKSPACES_CAPABILITY.parse({ version: 1 }))
      .toThrow("must expose resolve");
    await expect(Reflect.apply(workspaces.resolve, workspaces, [{
      ...selection,
      path: "/caller/path",
    }])).rejects.toThrow("Unsupported PI WEB host workspaces capability v1 selection field: path");
    await expect(PI_WEB_HOST_WORKSPACES_CAPABILITY.parse({
      version: 1,
      resolve: () => ({ project: sourceProject, workspace: { ...sourceWorkspace, projectId: "other" } }),
    }).resolve(selection)).rejects.toThrow("mismatched project and workspace scopes");
    await expect(PI_WEB_HOST_WORKSPACES_CAPABILITY.parse({
      version: 1,
      resolve: () => ({
        project: { ...sourceProject, id: "other-project" },
        workspace: { ...sourceWorkspace, id: "other-workspace", projectId: "other-project" },
      }),
    }).resolve(selection)).rejects.toThrow("authority outside the requested selection");
  });

  it("exports the exact frozen PI sessions v1 token and snapshots bounded run handles", async () => {
    let resolveCompletion!: (value: PiWebHostPiSessionRunCompletion) => void;
    const sourceCompletion = new Promise<PiWebHostPiSessionRunCompletion>((resolve) => { resolveCompletion = resolve; });
    const run = vi.fn((runInput: PiWebHostPiSessionRunInput) => {
      void runInput;
      return Promise.resolve({
        sessionId: "session-1",
        completion: sourceCompletion,
        runtime: { private: true },
      });
    });
    const source = { version: 1 as const, create: () => ({ sessionId: "created" }), run };
    const sessions = PI_WEB_HOST_PI_SESSIONS_CAPABILITY.parse(source);
    Reflect.set(source, "run", () => Promise.reject(new Error("mutated run was used")));

    const input = { projectId: "project-1", workspaceId: "workspace-1", prompt: "Do the bounded work" };
    const handle = await sessions.run(input);
    resolveCompletion({ status: "failed", error: "model unavailable" });
    const completion = await handle.completion;

    expect(PI_WEB_HOST_PI_SESSIONS_CAPABILITY).toMatchObject({
      pluginId: "pi-web.host",
      id: "pi-sessions",
      version: 1,
    });
    expect(Object.isFrozen(PI_WEB_HOST_PI_SESSIONS_CAPABILITY)).toBe(true);
    expect(run).toHaveBeenCalledWith(input);
    expect(Object.isFrozen(run.mock.calls[0]?.[0])).toBe(true);
    expect(handle.sessionId).toBe("session-1");
    expect(handle.completion).toBeInstanceOf(Promise);
    expect(handle).not.toHaveProperty("runtime");
    expect(Object.isFrozen(handle)).toBe(true);
    expect(completion).toEqual({ status: "failed", error: "model unavailable" });
    expect(Object.isFrozen(completion)).toBe(true);

    expect(() => PI_WEB_HOST_PI_SESSIONS_CAPABILITY.parse({ version: 1 }))
      .toThrow("must expose create and run");
    await expect(Reflect.apply(sessions.run, sessions, [{ ...input, path: "/caller/path" }]))
      .rejects.toThrow("Unsupported PI WEB host PI sessions capability v1 run input field: path");
    await expect(sessions.run({ ...input, projectId: "x".repeat(513) }))
      .rejects.toThrow("projectId must be at most 512 characters");
    await expect(sessions.run({ ...input, prompt: "😀".repeat(16_385) }))
      .rejects.toThrow("prompt must be at most 65536 UTF-8 bytes");
    await expect(PI_WEB_HOST_PI_SESSIONS_CAPABILITY.parse({
      version: 1,
      create: () => ({ sessionId: "created" }),
      run: () => ({ sessionId: "session-2", completion: { status: "completed" } }),
    }).run(input)).rejects.toThrow("run must expose completion");
    await expect(PI_WEB_HOST_PI_SESSIONS_CAPABILITY.parse({
      version: 1,
      create: () => ({ sessionId: "created" }),
      run: () => ({ sessionId: "session-2", completion: Promise.resolve({ status: "unknown" }) }),
    }).run(input).then(({ completion: invalidCompletion }) => invalidCompletion))
      .rejects.toThrow("completion status is invalid");
  });

  it("snapshots prompt-free creation", async () => {
    const selection = { projectId: "project", workspaceId: "workspace" };
    const create = vi.fn((input: PiWebHostWorkspaceSelection) => {
      void input;
      return Promise.resolve({ sessionId: "created", runtime: "private" });
    });
    const run = () => Promise.resolve({ sessionId: "run", completion: Promise.resolve({ status: "completed" }) });
    const source = { version: 1, create, run };
    const sessions = PI_WEB_HOST_PI_SESSIONS_CAPABILITY.parse(source);
    Reflect.set(source, "create", () => { throw new Error("mutated"); });
    const result = await sessions.create(selection);
    expect(result).toEqual({ sessionId: "created" });
    expect(Object.isFrozen(result)).toBe(true);
    expect(create).toHaveBeenCalledWith(selection);
    expect(Object.isFrozen(create.mock.calls[0]?.[0])).toBe(true);
    await expect(Reflect.apply(sessions.create, sessions, [{ ...selection, prompt: "unexpected" }])).rejects.toThrow("Unsupported");
    await expect(sessions.create({ ...selection, workspaceId: "" })).rejects.toThrow();
    await expect(PI_WEB_HOST_PI_SESSIONS_CAPABILITY.parse({ version: 1, run, create: () => ({ sessionId: "" }) }).create(selection)).rejects.toThrow("sessionId");
  });

  it.each([
    { version: 1, run: (): undefined => undefined },
    { version: 1, create: (): undefined => undefined },
    { version: 1, create: true, run: (): undefined => undefined },
    { version: 1, create: (): undefined => undefined, run: true },
    { version: 2, create: (): undefined => undefined, run: (): undefined => undefined },
  ])("rejects incomplete or incompatible session capabilities before use: %o", (value) => {
    expect(() => PI_WEB_HOST_PI_SESSIONS_CAPABILITY.parse(value)).toThrow("must expose create and run");
  });

  it("keeps host inputs readonly and concrete services out of the declaration surface", async () => {
    expectTypeOf<keyof ServerPluginActivationContext>().toEqualTypeOf<
      "apiVersion" | "pluginId" | "packageRoot" | "dataDirectory" | "logger" | "settings" | "notices" | "execFile" | "signal" | "lifetimeSignal"
    >();
    expectTypeOf<keyof ServerPluginNoticeReporterV1>().toEqualTypeOf<"version" | "record">();
    expectTypeOf<keyof ServerPluginNoticeInput>().toEqualTypeOf<"severity" | "message" | "scope" | "context">();
    expectTypeOf<keyof PiWebServerPlugin>().toEqualTypeOf<"apiVersion" | "name" | "requires" | "activate">();
    expectTypeOf<keyof PluginCapability>().toEqualTypeOf<"pluginId" | "id" | "version" | "parse">();
    expectTypeOf<keyof PluginCapabilityProvision>().toEqualTypeOf<"capability" | "value">();
    expectTypeOf<keyof ServerPluginCapabilityResolver>().toEqualTypeOf<"resolve">();
    expectTypeOf<keyof PiWebHostWorkspaceSelection>().toEqualTypeOf<"projectId" | "workspaceId">();
    expectTypeOf<keyof PiWebHostWorkspaceAuthority>().toEqualTypeOf<"project" | "workspace">();
    expectTypeOf<keyof PiWebHostWorkspacesV1>().toEqualTypeOf<"version" | "resolve">();
    expectTypeOf<keyof PiWebHostPiSessionRunInput>().toEqualTypeOf<"projectId" | "workspaceId" | "prompt">();
    expectTypeOf<keyof PiWebHostPiSessionRun>().toEqualTypeOf<"sessionId" | "completion">();
    expectTypeOf<keyof PiWebHostPiSessionRunCompletion>().toEqualTypeOf<"status">();
    expectTypeOf<keyof Extract<PiWebHostPiSessionRunCompletion, { status: "failed" }>>()
      .toEqualTypeOf<"status" | "error">();
    expectTypeOf<keyof PiWebHostPiSessionsV1>().toEqualTypeOf<"version" | "create" | "run">();
    expectTypeOf<keyof ServerPluginStartContext>().toEqualTypeOf<"capabilities" | "signal">();
    expectTypeOf<keyof ServerPluginActivation>().toEqualTypeOf<"workspaceProvider" | "peer" | "provides" | "start" | "dispose" | "health">();
    expectTypeOf<keyof ServerPluginNoticeScope>().toEqualTypeOf<"projectId" | "workspaceId" | "sessionId">();
    expectTypeOf<keyof WorkspaceProvider>().toEqualTypeOf<
      "fallback" | "probe" | "list" | "prepareRemove"
    >();
    expectTypeOf<keyof ServerPluginPeer>().toEqualTypeOf<"request" | "openChannel">();
    // eslint-disable-next-line @typescript-eslint/no-generated-empty-object-type -- Record<never, never> deliberately probes that an empty scope object satisfies the notice-scope contract.
    type EmptyNoticeScopeIsValid = Record<never, never> extends ServerPluginNoticeScope ? true : false;
    type ProjectNoticeScopeIsValid = { readonly projectId: string } extends ServerPluginNoticeScope ? true : false;
    // eslint-disable-next-line @typescript-eslint/no-generated-empty-object-type -- Record<never, never> deliberately probes that an empty object does not satisfy the peer contract.
    type EmptyPeerIsValid = Record<never, never> extends ServerPluginPeer ? true : false;
    type PeerRequest = NonNullable<ServerPluginPeer["request"]>;
    type PeerChannel = NonNullable<ServerPluginPeer["openChannel"]>;
    type RequestOnlyPeerIsValid = { request: PeerRequest } extends ServerPluginPeer ? true : false;
    type ChannelOnlyPeerIsValid = { openChannel: PeerChannel } extends ServerPluginPeer ? true : false;
    expectTypeOf<EmptyNoticeScopeIsValid>().toEqualTypeOf<false>();
    expectTypeOf<ProjectNoticeScopeIsValid>().toEqualTypeOf<true>();
    expectTypeOf<EmptyPeerIsValid>().toEqualTypeOf<false>();
    expectTypeOf<RequestOnlyPeerIsValid>().toEqualTypeOf<true>();
    expectTypeOf<ChannelOnlyPeerIsValid>().toEqualTypeOf<true>();
    const requestOnly: ServerPluginPeer = { request: () => null };
    const channelOnly: ServerPluginPeer = {
      openChannel: () => ({ receive: () => undefined }),
    };
    expect(typeof requestOnly.request).toBe("function");
    expect(typeof channelOnly.openChannel).toBe("function");
    expectTypeOf<keyof ServerPluginPeerChannel>().toEqualTypeOf<"receive" | "closed" | "close">();
    expectTypeOf<keyof ServerPluginPeerChannelOpenContext>().toEqualTypeOf<"project" | "workspace" | "operation" | "input" | "signal" | "send">();
    expectTypeOf<keyof ServerPluginPeerChannelCloseContext>().toEqualTypeOf<"code" | "reason" | "signal">();
    expectTypeOf<keyof ServerPluginPeerRequestContext>().toEqualTypeOf<
      "project" | "workspace" | "operation" | "input" | "signal"
    >();
    expectTypeOf<keyof ServerPluginExecFileRequest>().toEqualTypeOf<
      "file" | "args" | "cwd" | "env" | "unsetEnv" | "timeoutMs" | "signal"
    >();
    expectTypeOf<ReadonlyKeys<ServerPluginActivationContext>>().toEqualTypeOf<keyof ServerPluginActivationContext>();
    expectTypeOf<ReadonlyKeys<PluginCapability>>().toEqualTypeOf<keyof PluginCapability>();
    expectTypeOf<ReadonlyKeys<PluginCapabilityProvision>>().toEqualTypeOf<keyof PluginCapabilityProvision>();
    expectTypeOf<ReadonlyKeys<ServerPluginCapabilityResolver>>().toEqualTypeOf<keyof ServerPluginCapabilityResolver>();
    expectTypeOf<ReadonlyKeys<PiWebHostWorkspaceSelection>>().toEqualTypeOf<keyof PiWebHostWorkspaceSelection>();
    expectTypeOf<ReadonlyKeys<PiWebHostWorkspaceAuthority>>().toEqualTypeOf<keyof PiWebHostWorkspaceAuthority>();
    expectTypeOf<ReadonlyKeys<PiWebHostWorkspacesV1>>().toEqualTypeOf<keyof PiWebHostWorkspacesV1>();
    expectTypeOf<ReadonlyKeys<PiWebHostPiSessionRunInput>>().toEqualTypeOf<keyof PiWebHostPiSessionRunInput>();
    expectTypeOf<ReadonlyKeys<PiWebHostPiSessionRun>>().toEqualTypeOf<keyof PiWebHostPiSessionRun>();
    expectTypeOf<ReadonlyKeys<PiWebHostPiSessionRunCompletion>>().toEqualTypeOf<keyof PiWebHostPiSessionRunCompletion>();
    expectTypeOf<ReadonlyKeys<Extract<PiWebHostPiSessionRunCompletion, { status: "failed" }>>>()
      .toEqualTypeOf<"status" | "error">();
    expectTypeOf<ReadonlyKeys<PiWebHostPiSessionsV1>>().toEqualTypeOf<keyof PiWebHostPiSessionsV1>();
    expectTypeOf<ReadonlyKeys<ServerPluginStartContext>>().toEqualTypeOf<keyof ServerPluginStartContext>();
    expectTypeOf<ReadonlyKeys<ServerPluginLogger>>().toEqualTypeOf<keyof ServerPluginLogger>();
    expectTypeOf<ReadonlyKeys<ServerPluginNoticeReporterV1>>().toEqualTypeOf<keyof ServerPluginNoticeReporterV1>();
    expectTypeOf<ReadonlyKeys<ServerPluginNoticeInput>>().toEqualTypeOf<keyof ServerPluginNoticeInput>();
    expectTypeOf<ReadonlyKeys<ServerPluginNoticeScope>>().toEqualTypeOf<keyof ServerPluginNoticeScope>();
    expectTypeOf<ReadonlyKeys<ProjectInput>>().toEqualTypeOf<keyof ProjectInput>();
    expectTypeOf<ReadonlyKeys<ProviderRemoveContext>>().toEqualTypeOf<keyof ProviderRemoveContext>();
    expectTypeOf<ReadonlyKeys<ServerPluginPeerRequestContext>>().toEqualTypeOf<keyof ServerPluginPeerRequestContext>();
    expectTypeOf<ReadonlyKeys<ServerPluginPeerChannelOpenContext>>().toEqualTypeOf<keyof ServerPluginPeerChannelOpenContext>();
    expectTypeOf<ReadonlyKeys<ServerPluginPeerChannelCloseContext>>().toEqualTypeOf<keyof ServerPluginPeerChannelCloseContext>();
    expectTypeOf<ReadonlyKeys<ServerPluginPeerWorkspace>>().toEqualTypeOf<keyof ServerPluginPeerWorkspace>();
    expectTypeOf<ReadonlyKeys<WorkspaceRemovalPresentation>>().toEqualTypeOf<keyof WorkspaceRemovalPresentation>();
    expectTypeOf<keyof WorkspaceRemovalPresentation>().toEqualTypeOf<"actionLabel" | "confirmation">();
    expectTypeOf<WritableKeys<ProviderWorkspace>>().toEqualTypeOf<keyof ProviderWorkspace>();
    expectTypeOf<WritableKeys<WorkspaceRemovePlan>>().toEqualTypeOf<keyof WorkspaceRemovePlan>();
    expectTypeOf<WritableKeys<ServerPluginActivation>>().toEqualTypeOf<keyof ServerPluginActivation>();

    const [source, browserSource] = await Promise.all([
      readFile("src/server-plugin-api.ts", "utf8"),
      readFile("src/plugin-api.ts", "utf8"),
    ]);
    expect(source).not.toMatch(/\b(?:BackgroundService|Fastify|WorkspaceService|ProjectService|TerminalService|PiSessionService|SessionManager|SessionDaemonClient)\b/u);
    expect(source).not.toMatch(/event\s*bus|service\s*locator|registerRoute/iu);
    expect(source).toContain('from "./shared/pluginApiTypes.js";');
    expect(source).not.toContain("./shared/apiTypes.js");
    expect(browserSource).not.toMatch(/PI_WEB_HOST_(?:STATE|WORKSPACES|PI_SESSIONS)_CAPABILITY|PiWebHost(?:State|Workspace|Workspaces|PiSession|PiSessions)/u);
  });
});

async function exerciseActivation(activation: ServerPluginActivation, input: ProjectInput, signal: AbortSignal): Promise<void> {
  await activation.start?.({
    capabilities: { resolve: <Value>(capability: PluginCapability<Value>) => capability.parse({ label: "dependency" }) },
    signal,
  });
  const provider = activation.workspaceProvider;
  if (provider === undefined) throw new Error("Expected fixture workspace provider");
  await provider.probe(input, signal);
  const [workspace] = await provider.list(input, signal);
  if (workspace === undefined) throw new Error("Expected fixture workspace");
  await provider.prepareRemove?.({ project: input, workspace, signal });
  await activation.peer?.request?.({
    project: input,
    workspace: {
      id: "workspace-1",
      projectId: input.id,
      path: workspace.path,
      label: workspace.label,
      isMain: workspace.isMain,
      provider: {
        pluginId: "neutral-fixture",
        capabilities: { remove: false },
      },
    },
    operation: "status",
    input: null,
    signal,
  });
  await activation.health?.(signal);
  await activation.dispose?.(signal);
}
