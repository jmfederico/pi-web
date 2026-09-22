import { describe, expectTypeOf, it } from "vitest";
import type {
  DeleteWorkspaceFileResponse,
  FileContentResponse,
  FileTreeResponse,
  MoveWorkspaceFileOptions,
  MoveWorkspaceFileResponse,
  PiWebPlugin,
  PluginActivationContext,
  PluginActivationResult,
  PluginCapability,
  PluginCapabilityProvision,
  PluginCapabilityResolver,
  PluginContributions,
  PluginStartContext,
  PluginSelectedSession,
  PluginRuntimeState,
  Workspace,
  PluginPeerChannel,
  PluginPeerChannelOptions,
  PluginPeerRequestOptions,
  PluginPeer,
  WorkspaceContext,
  WorkspaceFiles,
  WorkspaceFilesCapabilityV1,
  WorkspaceFilesContextValue,
  WorkspaceInvalidation,
  WorkspacePanelContext,
  WorkspacePanelContribution,
  WorkspacePanelFiles,
  WorkspacePanelNavigationV1,
  WorkspaceProviderCapabilities,
  WorkspaceProviderMetadata,
  WorkspaceRemovalPresentation,
  WriteWorkspaceFileOptions,
  WriteWorkspaceFileResponse,
} from "@jmfederico/pi-web/plugin-api";

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
type IsOptional<Value, Key extends keyof Value> = Pick<Value, Key> extends Required<Pick<Value, Key>> ? false : true;

interface ExistingV2WorkspaceFiles {
  readFile(path: string): Promise<FileContentResponse>;
  listFiles(path: string): Promise<FileTreeResponse>;
  writeFile(path: string, content: string | Uint8Array, options?: WriteWorkspaceFileOptions): Promise<WriteWorkspaceFileResponse>;
  deleteFile(path: string): Promise<DeleteWorkspaceFileResponse>;
  moveFile(fromPath: string, toPath: string, options?: MoveWorkspaceFileOptions): Promise<MoveWorkspaceFileResponse>;
}

// These declarations intentionally exercise the source patterns used by v2
// adapters and test fakes. A union alias here produces TS2312/TS2422.
interface ExtendedWorkspaceFiles extends WorkspaceFiles { readonly adapterName?: string; }
interface ExtendedWorkspacePanelFiles extends WorkspacePanelFiles { readonly panelName?: string; }
declare class ImplementedWorkspaceFiles implements WorkspaceFiles {
  readFile: WorkspaceFiles["readFile"];
  listFiles: WorkspaceFiles["listFiles"];
  writeFile: WorkspaceFiles["writeFile"];
  deleteFile: WorkspaceFiles["deleteFile"];
  moveFile: WorkspaceFiles["moveFile"];
}
declare class ImplementedWorkspacePanelFiles implements WorkspacePanelFiles {
  readFile: WorkspacePanelFiles["readFile"];
  listFiles: WorkspacePanelFiles["listFiles"];
  writeFile: WorkspacePanelFiles["writeFile"];
  deleteFile: WorkspacePanelFiles["deleteFile"];
  moveFile: WorkspacePanelFiles["moveFile"];
}

describe("public browser plugin API", () => {
  it("exposes a minimal selected-session snapshot", () => {
    expectTypeOf<PluginRuntimeState["selectedSession"]>().toEqualTypeOf<PluginSelectedSession | undefined>();
    expectTypeOf<keyof PluginSelectedSession>().toEqualTypeOf<"id" | "cwd" | "name" | "archived" | "pending">();
  });

  it("keeps host-owned activation and workspace snapshots readonly", () => {
    expectTypeOf<keyof PluginActivationResult>().toEqualTypeOf<"contributions" | "provides" | "start" | "dispose">();
    expectTypeOf<ReadonlyKeys<PluginActivationContext>>().toEqualTypeOf<keyof PluginActivationContext>();
    expectTypeOf<ReadonlyKeys<Workspace>>().toEqualTypeOf<keyof Workspace>();
    expectTypeOf<ReadonlyKeys<WorkspaceProviderMetadata>>().toEqualTypeOf<keyof WorkspaceProviderMetadata>();
    expectTypeOf<ReadonlyKeys<WorkspaceProviderCapabilities>>().toEqualTypeOf<keyof WorkspaceProviderCapabilities>();
    expectTypeOf<keyof WorkspaceProviderCapabilities>().toEqualTypeOf<"remove">();
    expectTypeOf<ReadonlyKeys<WorkspaceRemovalPresentation>>().toEqualTypeOf<keyof WorkspaceRemovalPresentation>();
  });

  it("keeps the removal precondition internal and contribution results writable", () => {
    expectTypeOf<keyof WorkspaceRemovalPresentation>().toEqualTypeOf<"actionLabel" | "confirmation">();
    expectTypeOf<WritableKeys<PluginActivationResult>>().toEqualTypeOf<keyof PluginActivationResult>();
    expectTypeOf<WritableKeys<PluginContributions>>().toEqualTypeOf<keyof PluginContributions>();
  });

  it("exposes the v4 dependency-ready browser lifecycle and shared capability contracts", () => {
    expectTypeOf<PiWebPlugin["apiVersion"]>().toEqualTypeOf<4>();
    expectTypeOf<PluginActivationContext["apiVersion"]>().toEqualTypeOf<4>();
    expectTypeOf<keyof PiWebPlugin>().toEqualTypeOf<"apiVersion" | "name" | "requires" | "activate">();
    expectTypeOf<keyof PluginCapability>().toEqualTypeOf<"pluginId" | "id" | "version" | "parse">();
    expectTypeOf<keyof PluginCapabilityProvision>().toEqualTypeOf<"capability" | "value">();
    expectTypeOf<keyof PluginCapabilityResolver>().toEqualTypeOf<"resolve">();
    expectTypeOf<keyof PluginStartContext>().toEqualTypeOf<"capabilities" | "signal">();
    expectTypeOf<ReadonlyKeys<PluginActivationContext>>().toEqualTypeOf<keyof PluginActivationContext>();
    expectTypeOf<ReadonlyKeys<PluginCapability>>().toEqualTypeOf<keyof PluginCapability>();
    expectTypeOf<ReadonlyKeys<PluginCapabilityProvision>>().toEqualTypeOf<keyof PluginCapabilityProvision>();
    expectTypeOf<ReadonlyKeys<PluginCapabilityResolver>>().toEqualTypeOf<keyof PluginCapabilityResolver>();
    expectTypeOf<ReadonlyKeys<PluginStartContext>>().toEqualTypeOf<keyof PluginStartContext>();
  });

  it("adds a discriminated workspace-files capability without breaking the existing v2 structural surface", () => {
    expectTypeOf<ExistingV2WorkspaceFiles>().toExtend<WorkspaceFiles>();
    expectTypeOf<ExtendedWorkspaceFiles>().toExtend<WorkspaceFiles>();
    expectTypeOf<ExtendedWorkspacePanelFiles>().toExtend<WorkspacePanelFiles>();
    expectTypeOf<ImplementedWorkspaceFiles>().toExtend<WorkspaceFiles>();
    expectTypeOf<ImplementedWorkspacePanelFiles>().toExtend<WorkspacePanelFiles>();
    expectTypeOf<Extract<WorkspaceFilesContextValue, { readonly capabilityVersion: 1 }>>()
      .toEqualTypeOf<WorkspaceFilesCapabilityV1>();
    expectTypeOf<WorkspaceFilesCapabilityV1["capabilityVersion"]>().toEqualTypeOf<1>();
    expectTypeOf<ReadonlyKeys<Pick<WorkspaceFilesCapabilityV1, "capabilityVersion" | "defaultUploadFolder" | "maxInlinePreviewBytes">>>().toEqualTypeOf<"capabilityVersion" | "defaultUploadFolder" | "maxInlinePreviewBytes">();
  });

  it("exposes only package peers and models their capabilities as valid detectable combinations", () => {
    type PeerIsOptional = IsOptional<WorkspaceContext, "peer">;
    type PeerRequestIsOptional = IsOptional<PluginPeer, "request">;
    type PeerChannelIsOptional = IsOptional<PluginPeer, "openChannel">;
    type PeerRequest = NonNullable<PluginPeer["request"]>;
    type PeerChannel = NonNullable<PluginPeer["openChannel"]>;
    // eslint-disable-next-line @typescript-eslint/no-generated-empty-object-type -- Record<never, never> deliberately probes that an empty object does not satisfy the peer contract.
    type EmptyPeerIsValid = Record<never, never> extends PluginPeer ? true : false;
    type RequestOnlyIsValid = { request: PeerRequest } extends PluginPeer ? true : false;
    type ChannelOnlyIsValid = { openChannel: PeerChannel } extends PluginPeer ? true : false;
    type BothCapabilitiesAreValid = { request: PeerRequest; openChannel: PeerChannel } extends PluginPeer ? true : false;
    expectTypeOf<keyof WorkspaceContext>().toEqualTypeOf<"machine" | "workspace" | "state" | "files" | "peer" | "host">();
    expectTypeOf<keyof PluginPeer>().toEqualTypeOf<"request" | "openChannel">();
    expectTypeOf<PeerIsOptional>().toEqualTypeOf<true>();
    expectTypeOf<PeerRequestIsOptional>().toEqualTypeOf<true>();
    expectTypeOf<PeerChannelIsOptional>().toEqualTypeOf<true>();
    expectTypeOf<EmptyPeerIsValid>().toEqualTypeOf<false>();
    expectTypeOf<RequestOnlyIsValid>().toEqualTypeOf<true>();
    expectTypeOf<ChannelOnlyIsValid>().toEqualTypeOf<true>();
    expectTypeOf<BothCapabilitiesAreValid>().toEqualTypeOf<true>();
    expectTypeOf<PluginPeerRequestOptions["signal"]>().toEqualTypeOf<AbortSignal | undefined>();
    expectTypeOf<ReadonlyKeys<PluginPeerRequestOptions>>().toEqualTypeOf<"signal">();
    expectTypeOf<ReadonlyKeys<PluginPeerChannelOptions>>().toEqualTypeOf<keyof PluginPeerChannelOptions>();
    expectTypeOf<ReadonlyKeys<Pick<PluginPeerChannel, "closed">>>().toEqualTypeOf<"closed">();
  });

  it("adds optional versioned panel navigation without changing browser API v2 compatibility", () => {
    type NavigationIsOptional = IsOptional<WorkspacePanelContext, "navigation">;
    type NavigationAliasesAreOptional = IsOptional<WorkspacePanelContribution, "navigationAliases">;
    expectTypeOf<WorkspacePanelNavigationV1["version"]>().toEqualTypeOf<1>();
    expectTypeOf<ReadonlyKeys<Pick<WorkspacePanelNavigationV1, "version" | "contributionId" | "query">>>()
      .toEqualTypeOf<"version" | "contributionId" | "query">();
    expectTypeOf<NavigationIsOptional>().toEqualTypeOf<true>();
    expectTypeOf<NavigationAliasesAreOptional>().toEqualTypeOf<true>();
  });

  it("keeps invalidation snapshots readonly and one-argument v2 callbacks assignable", () => {
    type ExistingV2InvalidationCallback = (context: WorkspacePanelContext) => void;
    expectTypeOf<ReadonlyKeys<WorkspaceInvalidation>>().toEqualTypeOf<keyof WorkspaceInvalidation>();
    expectTypeOf<ExistingV2InvalidationCallback>().toExtend<NonNullable<WorkspacePanelContribution["onInvalidate"]>>();
  });
});
