import type {
  JsonValue,
  PairedWorkspaceBackendV1,
  PiWebPlugin,
  Workspace,
  WorkspaceBackend,
  WorkspaceFiles,
  WorkspaceFilesCapabilityV1,
  WorkspaceFilesContextValue,
  WorkspacePanelContext,
  WorkspacePanelFiles,
} from "@jmfederico/pi-web/plugin-api";

const plugin: PiWebPlugin = {
  apiVersion: 2,
  name: "Browser declaration fixture",
  activate: (context) => ({
    contributions: {
      actions: [{
        id: "identity",
        title: context.pluginId,
        run: ({ selectWorkspaceTool }) => {
          selectWorkspaceTool(`${context.runtimePluginId}:workspace.fixture`);
        },
      }],
    },
  }),
};

// Keep common browser-v2 adapter and fake patterns compiling against the
// installed declaration, not only against this repository's source graph.
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

function capabilityV1(files: WorkspaceFilesContextValue): WorkspaceFilesCapabilityV1 | undefined {
  return files.capabilityVersion === 1 ? files : undefined;
}

function requestOwnerBackend(backend: WorkspaceBackend): Promise<JsonValue> {
  return backend.request("fixture.owner-summary", null);
}

async function requestPairedBackend(context: WorkspacePanelContext): Promise<JsonValue | undefined> {
  const backend: PairedWorkspaceBackendV1 | undefined = context.pairedBackend;
  if (backend?.requestVersion !== 1) return undefined;
  return await backend.request("fixture.summary", null);
}

function openPairedBackendChannel(context: WorkspacePanelContext): void {
  const backend = context.pairedBackend;
  if (backend?.channelVersion !== 1) return;
  void backend.openChannel("fixture.watch", null, { onData: echoJson });
}

const echoJson = (value: JsonValue): JsonValue => value;
export { capabilityV1, echoJson, openPairedBackendChannel, plugin, requestOwnerBackend, requestPairedBackend };
export type {
  BrowserWorkspace,
  ExtendedWorkspaceFiles,
  ExtendedWorkspacePanelFiles,
  ImplementedWorkspaceFiles,
  ImplementedWorkspacePanelFiles,
};
type BrowserWorkspace = Workspace;
