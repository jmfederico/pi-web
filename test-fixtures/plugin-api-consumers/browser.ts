import type {
  ApplicationPanelContext,
  ApplicationPanelContribution,
  ContributionQueryValue,
  DisplayedMessageActionContext,
  MessageActionContext,
  PluginNavigate,
  PluginNavigationDestination,
  PluginNavigationPatchDestination,
  PluginNavigationOptions,
  PluginRuntimeContext,
  PluginRuntimeContextV5,
  PluginSessionSnapshot,
  QualifiedContributionId,
  SessionLabelContext,
  ContentRenderingCapability,
  ContentRendererInput,
  TranscriptRendererContribution,
  JsonValue,
  PluginCapability,
  StylesheetIntegrationCapabilityV1,
  PluginPeer,
  PiWebPlugin,
  PluginContributions,
  PluginContributionsV5,
  ContentRendererContribution,
  ContentRendererContributionV5,
  ThemeContribution,
  ThemeContributionV5,
  ThemeTokens,
  MessageActionAvailabilityContext,
  MessageActionAvailabilityContextV5,
  Workspace,
  WorkspaceFiles,
  WorkspaceFilesCapabilityV1,
  WorkspaceFilesContextValue,
  WorkspacePanelContext,
  WorkspacePanelContribution,
  WorkspacePanelFiles,
  MaintenanceTerminal,
  TerminalCommandRun,
} from "@jmfederico/pi-web/plugin-api";

export const transcriptToolRenderer: TranscriptRendererContribution = {
  id: "tool", target: "tool",
  resolve(toolName, next) {
    const name: string = toolName;
    if (name !== "read") return next();
    const downstream = next();
    return {
      render(input) {
        const status: "pending" | "running" | "success" | "error" = input.entry.status;
        const sessionId: string = input.scope.sessionId;
        void [status, sessionId, input.entry.args, input.entry.details, input.signal, input.fail];
        // @ts-expect-error Tool targets infer tool input, not custom-message input.
        input.entry.customType;
        // @ts-expect-error Transcript rendering conveys no provenance.
        input.source;
        return downstream?.render(input);
      },
    };
  },
};

export const transcriptMessageRenderer: TranscriptRendererContribution = {
  id: "message", target: "custom-message", customType: "notice",
  render(input) {
    const customType: string = input.entry.customType;
    void [customType, input.entry.content];
    // @ts-expect-error Custom-message targets infer message input, not tool input.
    input.entry.toolName;
    return undefined;
  },
};

export function checkTranscriptContributions(v4: PluginContributions, v5: PluginContributionsV5): void {
  v5.transcriptRenderers = [transcriptToolRenderer, transcriptMessageRenderer];
  // @ts-expect-error Transcript contributions are v5-only.
  v4.transcriptRenderers = [];
}

export function previewSessionAgePolicy(sessions: readonly PluginSessionSnapshot[], cutoff: number) {
  return sessions.filter((session) => {
    if (session.pinned !== false || session.runtime === "busy") return false;
    const timestamp = session.archived ? session.archivedAt : session.modified;
    return timestamp !== null && Date.parse(timestamp) < cutoff;
  });
}

export async function manageSavedSession(context: PluginRuntimeContextV5): Promise<void> {
  const sessions = context.sessions;
  if (sessions === undefined) return; // Hosts predating this optional service.
  const selected = { projectId: "fixture-project", workspaceId: "fixture-workspace", sessionId: "fixture-session" };
  await sessions.get(selected);
  await sessions.pin(selected);
  await sessions.unpin(selected);
  await sessions.archive(selected);
  await sessions.restore(selected);
  await sessions.delete(selected);
  // @ts-expect-error Session paths are resolved by the host, not supplied as authority.
  await sessions.archive({ cwd: "/repo", sessionId: selected.sessionId });
}

// Existing plugins can extend workspace run records and read their identity
// without a maintenance-scope check.
export interface WorkspaceRunExtension extends TerminalCommandRun {
  pluginTag?: string;
}

export async function readWorkspaceCommandIdentity(context: WorkspacePanelContext): Promise<{ projectId: string; workspaceId: string }> {
  const { run } = await context.terminal.runCommand({ title: "Build", command: "npm run build" });
  return { projectId: run.projectId, workspaceId: run.workspaceId };
}

export async function readMaintenanceCommandScope(terminal: MaintenanceTerminal): Promise<"maintenance"> {
  const { run } = await terminal.runCommand({ title: "Update", command: "pi-web update" });
  // @ts-expect-error Machine maintenance output cannot be used as a workspace run.
  const workspaceRun: TerminalCommandRun = run;
  void workspaceRun;
  return run.scope;
}

export function checkPanelContributionIds(application: ApplicationPanelContribution, workspace: WorkspacePanelContribution): void {
  // @ts-expect-error Panel migration aliases are not public API.
  application.routeAliases;
  // @ts-expect-error Panel migration aliases are not public API.
  workspace.routeAliases;
  // @ts-expect-error Query migration aliases are not public API.
  workspace.navigationAliases;
}

export function checkContentRendering(capability: ContentRenderingCapability, input: ContentRendererInput): void {
  const request = { machineId: "local", text: input.text };
  capability.listRenderers({ ...request, language: "diagram", filePath: "graph.diag" });
  capability.renderText({ ...request, allowManualPreview: true });
  capability.renderText({ ...request, controls: "external", rendererId: "plugin:diagram", allowManualPreview: false });
  // @ts-expect-error Embedded controls own selection.
  capability.renderText({ ...request, rendererId: "plugin:diagram" });
  const markdown = { ...request, toSafeHtml: (text: string) => text, allowManualPreview: true };
  capability.renderMarkdown(markdown);
  // @ts-expect-error Intent memory is private Chat policy.
  capability.renderMarkdown({ ...markdown, intentKey: "session" });
  // @ts-expect-error Markdown discovers language from fences.
  capability.renderMarkdown({ ...markdown, language: "diagram" });
  // @ts-expect-error Markdown has no file selector.
  capability.renderMarkdown({ ...markdown, filePath: "graph.md" });
  // @ts-expect-error Renderer input does not claim provenance.
  input.source;
  // @ts-expect-error Source metadata belongs to v5 renderer inputs.
  input.machineId;
}

// Old destination readers must not acquire nullable route fields or query values.
export function readLegacyNavigationDestination(destination: PluginNavigationDestination): {
  machineId: string | undefined;
  projectId: string | undefined;
  workspaceId: string | undefined;
  sessionId: string | undefined;
  view: "navigation" | "chat" | "workspace" | undefined;
  tool: QualifiedContributionId | undefined;
  query: Readonly<Record<string, ContributionQueryValue>> | undefined;
} {
  return {
    machineId: destination.machineId,
    projectId: destination.projectId,
    workspaceId: destination.workspaceId,
    sessionId: destination.sessionId,
    view: destination.view,
    tool: destination.tool,
    query: destination.query,
  };
}

export function checkPluginNavigation(
  context: PluginRuntimeContext | MessageActionContext | DisplayedMessageActionContext | WorkspacePanelContext | ApplicationPanelContext | SessionLabelContext,
  destination: PluginNavigationDestination,
  options: PluginNavigationOptions,
): void {
  const navigate: PluginNavigate = context.navigate;
  const legacyNavigate: (destination: PluginNavigationDestination) => Promise<void> = navigate;
  void legacyNavigate(destination);
  void navigate(destination);
  void navigate(destination, options);
  void context.navigate(destination, { mode: "replace", history: "replace" });
  void context.navigate(destination, { mode: "patch", history: "push" });

  const patch: PluginNavigationPatchDestination = {
    machineId: null, projectId: null, workspaceId: null, sessionId: null, view: null, tool: null,
    query: { file: null, line: 7, tags: ["one", true] },
  };
  void context.navigate(patch, { mode: "patch" });
  void context.navigate(patch, { mode: "patch", history: "replace" });
  // @ts-expect-error Nullable patches cannot be read as legacy destinations.
  readLegacyNavigationDestination(patch);
  // @ts-expect-error Nullable destinations require explicit patch options.
  void context.navigate(patch);
  // @ts-expect-error History alone does not opt into patch mode.
  void context.navigate(patch, { history: "replace" });
  // @ts-expect-error Replace mode rejects nullable destinations.
  void context.navigate(patch, { mode: "replace" });
  // @ts-expect-error Options that might select replace do not authorize nullable fields.
  void context.navigate(patch, options);
  // @ts-expect-error Null query values also require patch mode.
  void context.navigate({ query: { file: null } });
  // @ts-expect-error A whole null query is not a patch destination.
  void context.navigate({ query: null }, { mode: "patch" });
  // @ts-expect-error The destination itself must remain an object.
  void context.navigate(null, { mode: "patch" });
}

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

const stylesheetIntegration: PluginCapability<StylesheetIntegrationCapabilityV1, 1> = {
  pluginId: "pi-web", id: "stylesheet-integration", version: 1,
  parse(value): StylesheetIntegrationCapabilityV1 {
    if (!isStylesheetIntegration(value)) throw new Error("Stylesheet integration unavailable");
    return value;
  },
};

function isStylesheetIntegration(value: unknown): value is StylesheetIntegrationCapabilityV1 {
  return typeof value === "object" && value !== null
    && "registerRoot" in value && typeof value.registerRoot === "function"
    && "subscribe" in value && typeof value.subscribe === "function"
    && "createController" in value && typeof value.createController === "function";
}

export function applySharedUi(styles: StylesheetIntegrationCapabilityV1, root: ShadowRoot): () => void {
  return styles.registerRoot(root, { sharedUi: true });
}

const plugin: PiWebPlugin = {
  apiVersion: 4,
  name: "Browser declaration fixture",
  requires: [identityCapability, stylesheetIntegration],
  activate: async (context) => ({
    provides: [{ capability: publishedCapability, value: { version: 1, label: context.pluginId } }],
    start: ({ capabilities, signal }) => {
      if (signal.aborted || context.lifetimeSignal.aborted) return;
      capabilities.resolve(identityCapability);
      const styles: StylesheetIntegrationCapabilityV1 = capabilities.resolve(stylesheetIntegration);
      void styles.registerRoot;
    },
    dispose: (signal) => {
      if (signal.aborted) return;
    },
    contributions: {
      messageActions: [{
        id: "history",
        title: "Fork from entry",
        run: async ({ message, history }) => {
          // Existing entry callbacks keep their durable identity and void return.
          const entryId: string = message.entryId;
          if (entryId !== "") await history.fork();
        },
      }, {
        target: "display",
        id: "copy",
        title: "Copy displayed text",
        ariaLabel: ({ message }) => `Copy ${message.role} message`,
        visible: ({ message }) => message.text !== "",
        run: async (input) => {
          const entryId: string | undefined = input.message.entryId;
          // @ts-expect-error Display actions cannot mutate history.
          input.history;
          await navigator.clipboard.writeText(input.message.text);
          return {
            title: entryId === undefined ? "Copied streaming text" : "Copied",
            ariaLabel: `Copied ${input.message.role} message`,
            icon: context.html`<span aria-hidden="true">✓</span>`,
          };
        },
      }],
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

// Legacy source contracts stay usable, including imports of ThemeTokens.
export const legacyPalette: ThemeTokens = { "--pi-bg": "#123456", "--pi-text": "#ffffff" };
export const legacyTheme: ThemeContribution = { id: "legacy", name: "Legacy", colorScheme: "dark", tokens: legacyPalette };
export const legacyContributions: PluginContributions = { themes: [legacyTheme] };
export const modernTheme: ThemeContributionV5 = { id: "modern", name: "Modern", colorScheme: "dark", stylesheets: [] };
export const modernContributions: PluginContributionsV5 = { themes: [modernTheme], stylesheets: [], syntaxHighlighters: [] };
export function checkVersionBoundaries(legacy: PluginContributions, modern: PluginContributionsV5,
  renderer: ContentRendererContribution, modernRenderer: ContentRendererContributionV5,
  availability: MessageActionAvailabilityContext, modernAvailability: MessageActionAvailabilityContextV5): void {
  // @ts-expect-error New contribution kinds belong to v5.
  legacy.stylesheets;
  // @ts-expect-error New contribution kinds belong to v5.
  legacy.syntaxHighlighters;
  // @ts-expect-error Stylesheet themes do not extend the v4 theme contract.
  legacyTheme.stylesheets;
  // @ts-expect-error Token palettes are compatibility-only, not a v5 API.
  modernTheme.tokens;
  // @ts-expect-error Dynamic renderer selectors belong to v5.
  renderer.supports;
  // @ts-expect-error Named renderer views belong to v5.
  renderer.title;
  // @ts-expect-error Question metadata belongs to v5 entry callbacks.
  availability.message.isQuestion;
  void modern.stylesheets;
  void modernRenderer.supports;
  void modernAvailability.message.isQuestion;
}

/** The current entry keeps contextual callback typing without manual annotations. */
export const pluginV5: PiWebPlugin = {
  apiVersion: 5,
  name: "V5 consumer",
  activate({ apiVersion, html }) {
    const version: 5 = apiVersion;
    return {
      contributions: {
        actions: [{
          id: "discover",
          title: "Discover",
          async run(context) {
            const projects = await context.catalog.projects.list();
            const project = projects[0];
            if (project === undefined) return;
            const workspaces = await context.catalog.workspaces.list(project.id);
            const workspace = workspaces[0];
            if (workspace === undefined) return;
            await context.catalog.sessions.list({ projectId: project.id, workspaceId: workspace.id });
            await context.backend?.forScope({ kind: "machine" }).request?.("fixture.summary", null);
          },
        }],
        applicationPanels: [{ id: "catalog", title: "Catalog", render: (context) => html`${version}: ${context.catalog.machineId}` }],
      },
    };
  },
};
