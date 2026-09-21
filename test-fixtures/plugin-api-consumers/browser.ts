import type {
  JsonValue,
  PluginCapability,
  PluginPeer,
  PiWebPlugin,
  Workspace,
  WorkspaceFiles,
  WorkspaceFilesCapabilityV1,
  WorkspaceFilesContextValue,
  WorkspacePanelContext,
  WorkspacePanelFiles,
} from "@jmfederico/pi-web/plugin-api";

interface FixtureIdentityCapabilityV1 {
  readonly version: 1;
  readonly label: string;
}

const identityCapability: PluginCapability<FixtureIdentityCapabilityV1, 1> = Object.freeze({
  pluginId: "fixture-provider",
  id: "identity",
  version: 1,
  parse(value: unknown): FixtureIdentityCapabilityV1 {
    if (typeof value !== "object" || value === null || Reflect.get(value, "version") !== 1 || typeof Reflect.get(value, "label") !== "string") {
      throw new Error("Invalid fixture identity capability");
    }
    return Object.freeze({ version: 1, label: Reflect.get(value, "label") });
  },
});

const publishedCapability: PluginCapability<FixtureIdentityCapabilityV1, 1> = Object.freeze({
  pluginId: "browser-declaration-fixture",
  id: "identity",
  version: 1,
  parse: identityCapability.parse,
});

const plugin: PiWebPlugin = {
  apiVersion: 4,
  name: "Browser declaration fixture",
  requires: [identityCapability],
  activate: async (context) => ({
    provides: [{ capability: publishedCapability, value: { version: 1, label: context.pluginId } }],
    start: ({ capabilities, signal }) => {
      if (signal.aborted || context.lifetimeSignal.aborted) return;
      capabilities.resolve(identityCapability);
    },
    dispose: (signal) => {
      if (signal.aborted) return;
    },
    contributions: {
      actions: [{
        id: "identity",
        title: context.pluginId,
        enabled: ({ state }) => {
          const session = state.selectedSession;
          return session !== undefined && session.id !== "" && session.cwd !== ""
            && (session.name === undefined || typeof session.name === "string") && !session.archived && !session.pending;
        },
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

async function requestPeer(context: WorkspacePanelContext): Promise<JsonValue | undefined> {
  const peer: PluginPeer | undefined = context.peer;
  if (peer?.request === undefined) return undefined;
  return await peer.request("fixture.summary", null);
}

function openPeerChannel(context: WorkspacePanelContext): void {
  const peer = context.peer;
  if (peer?.openChannel === undefined) return;
  void peer.openChannel("fixture.watch", null, { onData: echoJson });
}

const echoJson = (value: JsonValue): JsonValue => value;
export { capabilityV1, echoJson, identityCapability, openPeerChannel, plugin, publishedCapability, requestPeer };
export type {
  BrowserWorkspace,
  ExtendedWorkspaceFiles,
  ExtendedWorkspacePanelFiles,
  ImplementedWorkspaceFiles,
  ImplementedWorkspacePanelFiles,
};
type BrowserWorkspace = Workspace;
