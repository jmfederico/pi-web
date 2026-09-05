import { describe, expectTypeOf, it } from "vitest";
import type {
  DeleteWorkspaceFileResponse,
  FileContentResponse,
  FileTreeResponse,
  MoveWorkspaceFileOptions,
  MoveWorkspaceFileResponse,
  PluginActivationContext,
  PluginActivationResult,
  PluginContributions,
  Workspace,
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
  it("keeps host-owned activation and workspace snapshots readonly", () => {
    expectTypeOf<ReadonlyKeys<PluginActivationContext>>().toEqualTypeOf<keyof PluginActivationContext>();
    expectTypeOf<ReadonlyKeys<Workspace>>().toEqualTypeOf<keyof Workspace>();
    expectTypeOf<ReadonlyKeys<WorkspaceProviderMetadata>>().toEqualTypeOf<keyof WorkspaceProviderMetadata>();
    expectTypeOf<ReadonlyKeys<WorkspaceProviderCapabilities>>().toEqualTypeOf<keyof WorkspaceProviderCapabilities>();
    expectTypeOf<ReadonlyKeys<WorkspaceRemovalPresentation>>().toEqualTypeOf<keyof WorkspaceRemovalPresentation>();
  });

  it("keeps the removal precondition internal and contribution results writable", () => {
    expectTypeOf<keyof WorkspaceRemovalPresentation>().toEqualTypeOf<"actionLabel" | "confirmation">();
    expectTypeOf<WritableKeys<PluginActivationResult>>().toEqualTypeOf<keyof PluginActivationResult>();
    expectTypeOf<WritableKeys<PluginContributions>>().toEqualTypeOf<keyof PluginContributions>();
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
