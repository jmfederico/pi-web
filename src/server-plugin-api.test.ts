import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  createCompanionBackend,
  PI_WEB_HOST_PI_SESSIONS_CAPABILITY,
  PI_WEB_HOST_WORKSPACES_CAPABILITY,
} from "./server-plugin-api.js";
import type { PluginBackend } from "./plugin-api.js";
import type {
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
  ServerPluginPeerV5,
  ServerPluginPeerResourceContextV5,
  ServerPluginResourceResponse,
  ServerPluginPeerChannel,
  ServerPluginPeerChannelCloseContext,
  ServerPluginPeerChannelOpenContext,
  ServerPluginPeerRequestContext,
  ServerPluginPeerRequestContextV5,
  ServerPluginPeerChannelOpenContextV5,
  ServerPluginPeerWorkspace,
  PiWebServerPlugin,
  ProjectInput,
  ProviderRemoveContext,
  ProviderWorkspace,
  ServerPluginActivation,
  ServerPluginActivationContext,
  ServerPluginExecFileRequest,
  ServerPluginLogger,
  ServerPluginNoticeInput,
  ServerPluginStartContext,
  ServerPluginWorkspaceNotifications,
  ServerPluginNoticeReporterV1,
  ServerPluginNoticeScope,
  WorkspaceProvider,
  WorkspaceProviderIntegration,
  WorkspaceRemovalPresentation,
  WorkspaceRemovePlan,
} from "@jmfederico/pi-web/server-plugin-api";

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
  it("discovers a companion backend synchronously and fails closed without a host", () => {
    expectTypeOf<ReturnType<typeof createCompanionBackend>>().toEqualTypeOf<PluginBackend>();
    expect(() => createCompanionBackend({ emit: vi.fn() }, "paired")).toThrow("hosted PI WEB");
    const backend: PluginBackend = { machineId: "local", forScope: () => ({ request: () => Promise.resolve(null) }) };
    const emit = vi.fn((_channel: string, data: unknown) => {
      if (typeof data !== "object" || data === null) throw new Error("Expected discovery");
      const accept: unknown = Reflect.get(data, "accept");
      if (typeof accept !== "function") throw new Error("Expected discovery callback");
      Reflect.apply(accept, undefined, [() => backend]);
    });
    expect(createCompanionBackend({ emit }, "paired")).toBe(backend);
    expect(emit).toHaveBeenCalledWith("pi-web:companion-backend:discover", expect.objectContaining({ pluginId: "paired" }));
    expect(() => createCompanionBackend({ emit: (_channel, data) => {
      if (typeof data !== "object" || data === null) throw new Error("Expected discovery");
      const accept: unknown = Reflect.get(data, "accept");
      if (typeof accept !== "function") throw new Error("Expected discovery callback");
      Reflect.apply(accept, undefined, [() => { throw new Error("Unavailable"); }]);
    } }, "paired")).toThrow("Unavailable");
  });
  it("discriminates legacy v3 and scoped v5 plugin entry points", () => {
    const legacy: PiWebServerPlugin = {
      apiVersion: 3,
      name: "Legacy",
      activate(context) {
        expectTypeOf(context.apiVersion).toEqualTypeOf<3>();
        return { peer: { request({ workspace }) { return workspace.id; } } };
      },
    };
    const modern: PiWebServerPlugin = {
      apiVersion: 5,
      name: "Modern",
      activate(context) {
        expectTypeOf(context.apiVersion).toEqualTypeOf<5>();
        return { peer: { request({ scope }) { return scope.kind; } } };
      },
    };
    expectTypeOf<keyof ServerPluginPeerRequestContextV5>().toEqualTypeOf<"scope" | "operation" | "input" | "signal">();
    expectTypeOf<keyof ServerPluginPeerChannelOpenContextV5>().toEqualTypeOf<"scope" | "operation" | "input" | "signal" | "send">();
    expect([legacy.apiVersion, modern.apiVersion]).toEqual([3, 5]);
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

  it("snapshots optional run settings and rejects invalid thinking before host admission", async () => {
    const run = vi.fn((input: PiWebHostPiSessionRunInput) => Promise.resolve({
      sessionId: "configured", completion: Promise.resolve({ status: "completed" }),
      model: input.model, thinkingLevel: input.thinkingLevel,
    }));
    const sessions = PI_WEB_HOST_PI_SESSIONS_CAPABILITY.parse({
      version: 1, create: () => ({ sessionId: "created" }), run,
    });
    const input = { projectId: "project", workspaceId: "workspace", prompt: "work", model: "provider/model", thinkingLevel: "high" as const };
    const result = await sessions.run(input);
    expect(run).toHaveBeenCalledWith(input);
    expect(result).toMatchObject({ model: input.model, thinkingLevel: "high" });
    await expect(Reflect.apply(sessions.run, sessions, [{ ...input, thinkingLevel: "invalid" }])).rejects.toThrow("thinkingLevel");
    await expect(sessions.run({ ...input, model: "" })).rejects.toThrow("model");
    expect(run).toHaveBeenCalledTimes(1);
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

  it("exposes general-purpose byte resources only on v5 peers", () => {
    type Resource = NonNullable<ServerPluginPeerV5["resource"]>;
    type ResourceOnlyIsValid = { resource: Resource } extends ServerPluginPeerV5 ? true : false;
    // eslint-disable-next-line @typescript-eslint/no-generated-empty-object-type -- Empty peers must remain invalid.
    type EmptyPeerIsValid = Record<never, never> extends ServerPluginPeerV5 ? true : false;
    expectTypeOf<ResourceOnlyIsValid>().toEqualTypeOf<true>();
    expectTypeOf<EmptyPeerIsValid>().toEqualTypeOf<false>();
    expectTypeOf<Extract<keyof ServerPluginPeer, "resource">>().toEqualTypeOf<never>();
    expectTypeOf<ServerPluginPeerResourceContextV5["scope"]>().toEqualTypeOf<ServerPluginPeerRequestContextV5["scope"]>();
    expectTypeOf<ServerPluginPeerResourceContextV5["range"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<ReadonlyKeys<ServerPluginPeerResourceContextV5>>().toEqualTypeOf<keyof ServerPluginPeerResourceContextV5>();
    expectTypeOf<ServerPluginResourceResponse["body"]>().toEqualTypeOf<Uint8Array | AsyncIterable<Uint8Array>>();
    expectTypeOf<ServerPluginResourceResponse["statusCode"]>().toEqualTypeOf<200 | 206 | 416 | undefined>();
  });

  it("keeps host inputs readonly and limits the public declaration surface", () => {
    expectTypeOf<keyof ServerPluginActivationContext>().toEqualTypeOf<
      "apiVersion" | "pluginId" | "packageRoot" | "dataDirectory" | "logger" | "settings" | "resolveProjectSettings" | "workspaceNotifications" | "notices" | "execFile" | "signal" | "lifetimeSignal"
    >();
    expectTypeOf<keyof ServerPluginWorkspaceNotifications>().toEqualTypeOf<"command">();
    expectTypeOf<keyof WorkspaceProviderIntegration>().toEqualTypeOf<"reconcile" | "acceptNotification">();
    expectTypeOf<ReadonlyKeys<ServerPluginWorkspaceNotifications>>().toEqualTypeOf<"command">();
    expectTypeOf<keyof ServerPluginNoticeReporterV1>().toEqualTypeOf<"version" | "record">();
    expectTypeOf<keyof ServerPluginNoticeInput>().toEqualTypeOf<"severity" | "message" | "scope" | "context" | "presentation">();
    expectTypeOf<keyof PiWebServerPlugin>().toEqualTypeOf<"apiVersion" | "name" | "requires" | "activate">();
    expectTypeOf<keyof PluginCapability>().toEqualTypeOf<"pluginId" | "id" | "version" | "parse">();
    expectTypeOf<keyof PluginCapabilityProvision>().toEqualTypeOf<"capability" | "value">();
    expectTypeOf<keyof ServerPluginCapabilityResolver>().toEqualTypeOf<"resolve">();
    expectTypeOf<keyof PiWebHostWorkspaceSelection>().toEqualTypeOf<"projectId" | "workspaceId">();
    expectTypeOf<keyof PiWebHostWorkspaceAuthority>().toEqualTypeOf<"project" | "workspace">();
    expectTypeOf<keyof PiWebHostWorkspacesV1>().toEqualTypeOf<"version" | "resolve">();
    expectTypeOf<keyof PiWebHostPiSessionRunInput>().toEqualTypeOf<"projectId" | "workspaceId" | "prompt" | "model" | "thinkingLevel">();
    expectTypeOf<keyof PiWebHostPiSessionRun>().toEqualTypeOf<"sessionId" | "completion" | "model" | "thinkingLevel">();
    expectTypeOf<keyof PiWebHostPiSessionRunCompletion>().toEqualTypeOf<"status">();
    expectTypeOf<keyof Extract<PiWebHostPiSessionRunCompletion, { status: "failed" }>>()
      .toEqualTypeOf<"status" | "error">();
    expectTypeOf<keyof PiWebHostPiSessionsV1>().toEqualTypeOf<"version" | "create" | "run">();
    expectTypeOf<keyof ServerPluginStartContext>().toEqualTypeOf<"capabilities" | "signal">();
    expectTypeOf<keyof ServerPluginActivation>().toEqualTypeOf<"workspaceProvider" | "peer" | "provides" | "start" | "dispose" | "health">();
    expectTypeOf<keyof ServerPluginNoticeScope>().toEqualTypeOf<"projectId" | "workspaceId" | "sessionId">();
    expectTypeOf<keyof WorkspaceProvider>().toEqualTypeOf<
      "fallback" | "probe" | "list" | "prepareRemove" | "integration"
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
    expectTypeOf<keyof WorkspaceRemovalPresentation>().toEqualTypeOf<"actionLabel" | "confirmation" | "localization">();
    expectTypeOf<WritableKeys<ProviderWorkspace>>().toEqualTypeOf<keyof ProviderWorkspace>();
    expectTypeOf<WritableKeys<WorkspaceRemovePlan>>().toEqualTypeOf<keyof WorkspaceRemovePlan>();
    expectTypeOf<WritableKeys<ServerPluginActivation>>().toEqualTypeOf<keyof ServerPluginActivation>();

  });
});
