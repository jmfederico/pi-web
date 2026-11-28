import type { JsonObject, JsonValue, LocalizedMessages, PluginLocalization, PluginPeer, PluginRuntimeContextV5, StylesheetIntegrationCapabilityV1 } from "@jmfederico/pi-web/plugin-api";

import type definitions from "./workflows.messages.js";

export type WorktreeMode = "manual" | "agent";
type DialogContext = Pick<PluginRuntimeContextV5, "state" | "catalog" | "navigate" | "projects" | "refreshAppData" | "refreshProjectWorkspaces">;

/** Plugin-owned UI; all machine operations go through the captured public context. */
export function openWorktreeDialog(context: DialogContext, peer: PluginPeer, initialMode: WorktreeMode, localization: PluginLocalization, messages: LocalizedMessages<typeof definitions>, styles: StylesheetIntegrationCapabilityV1, onClose: () => void): () => void {
  const t = messages.t.bind(messages);
  const project = context.state.selectedProject;
  if (!project) throw new Error(t("noProject"));
  const { id: projectId, name: projectName } = project;
  if (!peer.request) throw new Error(t("noRequests"));
  const request = peer.request.bind(peer);
  let previousFocus = document.activeElement;
  while (previousFocus?.shadowRoot?.activeElement) previousFocus = previousFocus.shadowRoot.activeElement;
  const host = document.createElement("div");
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      dialog { box-sizing:border-box; width:min(480px, calc(100vw - 24px)); max-height:calc(100dvh - 24px); overflow:auto; overflow-wrap:anywhere; color:var(--pi-text); background:var(--pi-surface, var(--pi-bg)); border:1px solid var(--pi-border); border-radius:12px; padding:20px; font:14px var(--pi-font, system-ui); }
      dialog::backdrop { background:rgb(0 0 0 / .55); }
      h2 { margin:0; font-size:20px; } p { margin:8px 0; line-height:1.5; }
      #target, small { color:var(--pi-muted); } #modes { display:flex; flex-wrap:wrap; gap:4px; margin:16px 0 12px; }
      fieldset { min-width:0; padding:0; margin:0; border:0; }
      label { display:block; margin:12px 0 4px; font-weight:600; }
      :where(.ui-input) { box-sizing:border-box; width:100%; min-height:44px; padding:8px 12px; border:1px solid var(--pi-border); border-radius:6px; background:var(--pi-bg); color:inherit; font:var(--pi-control-font-size, 16px)/1.4 var(--pi-font, system-ui, sans-serif); }
      :where(.ui-input:focus-visible) { outline:2px solid var(--pi-accent); outline-offset:1px; }
      input, select { direction:ltr; text-align:start; } textarea { resize:vertical; min-height:96px; unicode-bidi:plaintext; }
      #destination, #default-location, #branch, #starting-point, #folders button { font-family:var(--pi-mono, monospace); }
      #location { margin-top:16px; } #location-heading { margin:0; font-weight:600; }
      #default-location { margin-top:4px; }
      #browse, #change-location { margin-top:8px; } #folders { max-height:128px; overflow:auto; }
      #folders button { display:flex; width:100%; justify-content:flex-start; text-align:start; white-space:normal; overflow-wrap:anywhere; }
      [hidden] { display:none !important; }
      footer { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:8px; margin-top:16px; }
      [role=alert] { color:var(--pi-danger); } small { display:block; margin-top:4px; line-height:1.5; }
      #status:empty { margin:0; }
    </style>
    <dialog aria-labelledby="title" aria-describedby="target">
      <h2 id="title"></h2>
      <p id="target"></p>
      <div id="modes" role="group">
        <button type="button" id="manual-mode" class="ui-button" autofocus></button>
        <button type="button" id="agent-mode" class="ui-button"></button>
      </div>
      <p id="status" role="status"></p>
      <form>
        <fieldset id="manual-fields" disabled hidden>
          <label for="worktree-name"></label>
          <input id="worktree-name" class="ui-input" maxlength="255" spellcheck="false" autocapitalize="off" required>
          <label for="branch"></label>
          <input id="branch" class="ui-input" maxlength="512" spellcheck="false" autocapitalize="off" aria-required="true">
        </fieldset>
        <fieldset id="starting-point-fields" disabled>
          <label for="starting-point"></label>
          <input id="starting-point" class="ui-input" list="branches" value="HEAD" spellcheck="false" autocapitalize="off" required maxlength="512" aria-describedby="starting-point-help">
          <datalist id="branches"></datalist>
          <small id="starting-point-help"></small>
        </fieldset>
        <fieldset id="location-fields" disabled hidden>
          <div id="location" role="group" aria-labelledby="location-heading">
            <p id="location-heading"></p>
            <small id="default-location" dir="ltr"></small>
            <button type="button" id="change-location" class="ui-button" aria-controls="location-editor" aria-expanded="false"></button>
            <div id="location-editor" hidden>
              <label for="destination"></label>
              <input id="destination" class="ui-input" maxlength="4096" spellcheck="false" autocapitalize="off" aria-describedby="destination-help">
              <small id="destination-help"></small>
              <button type="button" id="browse" class="ui-button ui-button--action" aria-controls="folders" aria-expanded="false"></button>
              <div id="folders" class="ui-selection-list" hidden><small id="folder-status" role="status"></small><div id="folder-options"></div></div>
            </div>
          </div>
        </fieldset>
        <fieldset id="agent-fields" disabled hidden>
          <small id="agent-help"></small>
          <small id="main-workspace"></small>
          <small id="folder-hint" hidden></small>
          <label for="description"></label>
          <textarea id="description" class="ui-input" dir="auto" required maxlength="8000" aria-describedby="description-help"></textarea>
          <small id="description-help"></small>
        </fieldset>
        <p id="error" role="alert" hidden></p>
        <footer>
          <button type="button" id="cancel" class="ui-button"></button>
          <button type="button" id="go-to-result" class="ui-button ui-button--action ui-button--primary" hidden></button>
          <button type="submit" class="ui-button ui-button--action ui-button--primary" disabled></button>
        </footer>
      </form>
    </dialog>`;
  function element<T extends Element>(selector: string, constructor: new () => T): T {
    const value = root.querySelector(selector);
    if (!(value instanceof constructor)) throw new Error(`Missing Workflows control: ${selector}`);
    return value;
  }
  const dialog = element("dialog", HTMLDialogElement);
  const manual = element("#manual-mode", HTMLButtonElement);
  const agent = element("#agent-mode", HTMLButtonElement);
  const manualFields = element("#manual-fields", HTMLFieldSetElement);
  const startingPointFields = element("#starting-point-fields", HTMLFieldSetElement);
  const locationFields = element("#location-fields", HTMLFieldSetElement);
  const agentFields = element("#agent-fields", HTMLFieldSetElement);
  const worktreeName = element("#worktree-name", HTMLInputElement);
  const destination = element("#destination", HTMLInputElement);
  const locationEditor = element("#location-editor", HTMLDivElement);
  const locationPreview = element("#default-location", HTMLElement);
  const changeLocation = element("#change-location", HTMLButtonElement);
  const branch = element("#branch", HTMLInputElement);
  const startingPoint = element("#starting-point", HTMLInputElement);
  const description = element("#description", HTMLTextAreaElement);
  const browse = element("#browse", HTMLButtonElement);
  const folders = element("#folders", HTMLDivElement);
  const folderOptions = element("#folder-options", HTMLDivElement);
  const folderHint = element("#folder-hint", HTMLElement);
  const submit = element("button[type=submit]", HTMLButtonElement);
  const cancel = element("#cancel", HTMLButtonElement);
  const go = element("#go-to-result", HTMLButtonElement);
  const error = element("#error", HTMLParagraphElement);
  const controller = new AbortController();
  let mode = initialMode;
  let ready = false;
  let supportsManual = false;
  let busy = false;
  let finished = false;
  let resultTarget: { kind: "worktree"; path: string } | { kind: "conversation"; workspaceId: string; sessionId: string } | undefined;
  let workspacePath: string | undefined;
  let defaultParent: string | undefined;
  let configuredParent: string | undefined;
  let editingLocation = false;
  let customLocation = false;
  let customBranch = false;
  let statusText = () => t("loading");
  let errorText = () => "";
  let navigationError = () => "";
  let folderStatus = () => "";
  let folderQuery = 0;

  function render() {
    host.lang = localization.language;
    host.dir = localization.direction;
    const labels: [string, string][] = [
      ["#title", t("title")], ["#target", t("target", { project: projectName })],
      ["#manual-mode", t("manual")], ["#agent-mode", t("agent")],
      ["label[for=worktree-name]", t("worktreeName")], ["#location-heading", t("location")],
      ["label[for=destination]", t("destination")], ["#destination-help", t("destinationHelp")],
      ["label[for=branch]", t("branch")], ["label[for=starting-point]", t("startingPoint")],
      ["#starting-point-help", t("startingPointHelp")], ["#agent-help", t("agentHelp")],
      ["label[for=description]", t("description")], ["#description-help", t("descriptionHelp")],
      ["#main-workspace", workspacePath === undefined ? "" : t("workspace", { path: workspacePath })],
      ["#status", ready && !busy && !finished && mode === "manual" && !supportsManual ? t("manualUnavailable") : statusText()],
      ["#error", [errorText(), navigationError()].filter(Boolean).join("\n")], ["#folder-status", folderStatus()],
    ];
    for (const [selector, value] of labels) element(selector, HTMLElement).textContent = value;
    const confirmed = resultTarget !== undefined;
    const modes = element("#modes", HTMLElement);
    modes.setAttribute("aria-label", t("mode"));
    modes.hidden = confirmed;
    element("#target", HTMLElement).hidden = confirmed;
    dialog.setAttribute("aria-describedby", confirmed ? "status" : "target");
    manual.setAttribute("aria-pressed", String(mode === "manual"));
    agent.setAttribute("aria-pressed", String(mode === "agent"));
    manual.disabled = agent.disabled = busy || finished;
    manualFields.hidden = mode !== "manual" || confirmed;
    manualFields.disabled = !ready || !supportsManual || busy || finished || manualFields.hidden;
    agentFields.hidden = mode !== "agent" || confirmed;
    agentFields.disabled = !ready || busy || finished || agentFields.hidden;
    startingPointFields.hidden = confirmed;
    startingPointFields.disabled = mode === "manual" ? manualFields.disabled : agentFields.disabled;
    locationFields.hidden = manualFields.hidden;
    locationFields.disabled = manualFields.disabled;
    folderHint.hidden = configuredParent === undefined;
    folderHint.textContent = configuredParent === undefined ? "" : t("folderHint", { path: configuredParent });
    const showLocation = ready && supportsManual;
    locationEditor.hidden = !showLocation || (!editingLocation && defaultParent !== undefined);
    locationPreview.hidden = !showLocation || !locationEditor.hidden;
    locationPreview.textContent = destination.value.trim();
    changeLocation.hidden = !showLocation || defaultParent === undefined;
    changeLocation.textContent = t(editingLocation ? "hideLocation" : "changeLocation");
    changeLocation.setAttribute("aria-expanded", String(!locationEditor.hidden));
    browse.hidden = context.projects === undefined;
    browse.textContent = t(folders.hidden === true ? "browse" : "hideFolders");
    browse.setAttribute("aria-expanded", String(folders.hidden === false));
    error.hidden = error.textContent === "";
    submit.hidden = finished;
    submit.disabled = mode === "manual" ? manualFields.disabled : agentFields.disabled;
    submit.textContent = t(mode === "manual" ? "create" : "start");
    cancel.disabled = busy;
    cancel.textContent = t(finished ? "close" : "cancel");
    go.hidden = !confirmed;
    go.disabled = busy;
    go.textContent = t(resultTarget?.kind === "conversation" ? "goToConversation" : "goToWorktree");
  }
  function setMode(next: WorktreeMode) {
    if (mode === next || busy || finished) return;
    mode = next;
    if (ready) errorText = () => "";
    render();
  }
  async function listFolders(query: string) {
    if (!context.projects || folders.hidden === true) return;
    const sequence = ++folderQuery;
    const isCurrent = () => sequence === folderQuery && !controller.signal.aborted;
    folderOptions.replaceChildren();
    folderStatus = () => t("loadingFolders");
    render();
    try {
      const options = await context.projects.suggestDirectories(query);
      if (!isCurrent()) return;
      folderStatus = () => options.length === 0 ? t("noFolders") : "";
      for (const { path } of options) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "ui-button ui-selection-option";
        button.dir = "ltr";
        button.textContent = path;
        button.addEventListener("click", () => {
          customLocation = true;
          const parent = folderPrefix(path);
          destination.value = parent + folderName(worktreeName.value);
          destination.focus();
          void listFolders(parent);
        });
        folderOptions.append(button);
      }
    } catch (cause) {
      if (!isCurrent()) return;
      folderStatus = () => t("folderError", { error: errorMessage(cause) });
    }
    render();
  }
  function errorMessage(cause: unknown): string {
    // Backend errors are never matched by English text.
    return cause instanceof ResponseError ? t(cause.key) : cause instanceof Error ? cause.message : String(cause);
  }
  async function prepare() {
    try {
      const [response, folder] = await Promise.all([
        request("prepare", null, { signal: controller.signal }),
        context.projects?.getWorktreeFolder?.(projectId),
      ]);
      if (controller.signal.aborted) return;
      const result = object(response);
      const refs = result["manual"];
      const startingRefs = refs === null || refs === undefined ? undefined : branchList(object(refs)["startingRefs"]);
      workspacePath = text(result["workspacePath"]);
      const branches = branchList(result["branches"]);
      element("#branches", HTMLDataListElement).replaceChildren(...["HEAD", ...(startingRefs ?? branches)].map(option));
      supportsManual = startingRefs !== undefined;
      defaultParent = folder?.path;
      configuredParent = folder?.configured === true ? folder.path : undefined;
      updateNameDefaults();
      ready = true;
      statusText = () => "";
    } catch (cause) {
      if (controller.signal.aborted) return;
      statusText = () => t("loadFailed");
      errorText = () => errorMessage(cause);
    }
    render();
    if (ready && mode === "manual" && supportsManual && root.activeElement === manual) worktreeName.focus();
  }
  function updateNameDefaults() {
    const name = folderName(worktreeName.value);
    if (!customBranch) branch.value = name.replace(/\s+/gu, "-");
    if (!customLocation && defaultParent !== undefined) destination.value = folderPrefix(defaultParent) + name;
  }
  async function create(path: string, name: string, ref: string) {
    statusText = () => t("creating");
    render();
    let pathOnDisk: string;
    let warning: string | undefined;
    try {
      const result = object(await request("create-worktree", { destination: path, branch: name, base: ref }, { signal: controller.signal }));
      pathOnDisk = text(result["path"]);
      if (typeof result["warning"] === "string") warning = result["warning"];
    } catch (cause) {
      statusText = () => "";
      errorText = () => t("createFailed", { error: errorMessage(cause) });
      return;
    }
    resultTarget = { kind: "worktree", path: pathOnDisk };
    finished = true;
    statusText = () => t("created", { path: pathOnDisk });
    const creationWarning = () => warning === undefined ? "" : t("createWarning", { error: warning });
    errorText = creationWarning;
    if (controller.signal.aborted) return;
    render();
    try {
      await (context.refreshProjectWorkspaces ?? context.refreshAppData)();
    } catch (cause) {
      errorText = () => [creationWarning(), t("refreshFailed", { error: errorMessage(cause) })].filter(Boolean).join("\n");
    }
  }
  async function goToResult() {
    const target = resultTarget;
    const isClosed = () => controller.signal.aborted;
    if (target === undefined || busy || isClosed()) return;
    busy = true;
    navigationError = () => "";
    render();
    try {
      const scope = { machineId: context.catalog.machineId, projectId };
      if (target.kind === "conversation") {
        await context.navigate({ ...scope, workspaceId: target.workspaceId, sessionId: target.sessionId, view: "chat" });
      } else {
        const workspaces = await context.catalog.workspaces.list(projectId, { signal: controller.signal });
        if (isClosed()) return;
        const workspace = workspaces.find((entry) => !entry.isMain && entry.path === target.path);
        if (workspace === undefined) {
          navigationError = () => t("worktreeNotListed");
          return;
        }
        await context.navigate({ ...scope, workspaceId: workspace.id });
      }
      close();
    } catch (cause) {
      navigationError = () => t(target.kind === "conversation" ? "openConversationFailed" : "openWorktreeFailed", { error: errorMessage(cause) });
    } finally {
      busy = false;
      if (!isClosed()) {
        render();
        go.focus();
      }
    }
  }
  async function dispatch(ref: string, purpose: string) {
    statusText = () => t("starting");
    render();
    // Never retry an uncertain dispatch from this dialog.
    finished = true;
    try {
      const result = object(await request("dispatch", {
        base: ref, description: purpose, ...(configuredParent === undefined ? {} : { worktreeParent: configuredParent }),
      }, { signal: controller.signal }));
      resultTarget = { kind: "conversation", workspaceId: text(result["workspaceId"]), sessionId: text(result["sessionId"]) };
      statusText = () => t("started");
    } catch (cause) {
      statusText = () => t("uncertain");
      errorText = () => t("checkSessions", { error: errorMessage(cause) });
    }
  }

  render();
  const releaseStyles = styles.registerRoot(root, { sharedUi: true });
  const unsubscribe = localization.subscribe(render);
  function close() {
    if (controller.signal.aborted) return;
    controller.abort();
    unsubscribe();
    releaseStyles();
    dialog.close();
    host.remove();
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
    onClose();
  }
  manual.addEventListener("click", () => { setMode("manual"); });
  agent.addEventListener("click", () => { setMode("agent"); });
  worktreeName.addEventListener("input", () => {
    updateNameDefaults();
    render();
  });
  branch.addEventListener("input", () => { customBranch = true; });
  changeLocation.addEventListener("click", () => {
    editingLocation = !editingLocation;
    if (!editingLocation) {
      folders.hidden = true;
      ++folderQuery;
    }
    render();
    if (editingLocation) destination.focus();
  });
  browse.addEventListener("click", () => {
    folders.hidden = folders.hidden === false;
    if (folders.hidden) ++folderQuery;
    else void listFolders(browseQuery(!customLocation && defaultParent !== undefined ? folderPrefix(defaultParent) : destination.value));
    render();
  });
  destination.addEventListener("input", () => {
    customLocation = true;
    void listFolders(destination.value);
  });
  cancel.addEventListener("click", close);
  go.addEventListener("click", () => { void goToResult(); });
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); if (!busy) close(); });
  dialog.addEventListener("close", close);
  element("form", HTMLFormElement).addEventListener("submit", (event) => {
    event.preventDefault();
    if (submit.disabled || controller.signal.aborted || busy) return;
    const path = destination.value.trim();
    const name = branch.value.trim();
    const ref = startingPoint.value.trim();
    const purpose = description.value.trim();
    if (ref === "") {
      errorText = () => t("startingPointRequired");
      render();
      startingPoint.focus();
      return;
    }
    if (mode === "manual") {
      if (folderName(worktreeName.value) === "") {
        errorText = () => t("invalidWorktreeName");
        render();
        worktreeName.focus();
        return;
      }
      if (name === "") {
        errorText = () => t("branchRequired");
        render();
        branch.focus();
        return;
      }
      if (path === "" || /[\\/]$/u.test(path)) {
        editingLocation = true;
        errorText = () => t("invalidLocation");
        render();
        destination.focus();
        return;
      }
    } else if (purpose === "") {
      errorText = () => t("required");
      render();
      return;
    }
    busy = true;
    errorText = () => "";
    void (mode === "manual" ? create(path, name, ref) : dispatch(ref, purpose)).finally(() => {
      if (controller.signal.aborted) return;
      busy = false;
      render();
      if (finished) (resultTarget === undefined ? cancel : go).focus();
    });
  });
  document.body.append(host);
  dialog.showModal();
  (mode === "manual" ? manual : agent).focus();
  void prepare();
  return close;
}

function folderName(value: string): string {
  const name = value.trim();
  return name === "." || name === ".." || /[\\/]/u.test(name) ? "" : name;
}

function folderPrefix(path: string): string {
  const separator = path.lastIndexOf("\\") > path.lastIndexOf("/") ? "\\" : "/";
  return path.endsWith(separator) ? path : path + separator;
}

function browseQuery(path: string): string {
  // The suggested parent itself may not exist yet. Start one level up so the
  // user can browse existing siblings, or choose the parent to descend into it.
  const withoutTrailingSeparator = path.replace(/[\\/]+$/u, "");
  if (path === withoutTrailingSeparator || withoutTrailingSeparator.length === 0 || /^[a-z]:$/iu.test(withoutTrailingSeparator)) return path;
  const separator = Math.max(withoutTrailingSeparator.lastIndexOf("/"), withoutTrailingSeparator.lastIndexOf("\\"));
  return withoutTrailingSeparator.slice(0, separator + 1);
}

function option(value: string): HTMLOptionElement {
  const item = document.createElement("option");
  item.value = item.textContent = value;
  return item;
}

class ResponseError extends Error {
  constructor(readonly key: "invalidResponse" | "invalidBranches") { super(key); }
}

function isObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function object(value: JsonValue): JsonObject {
  if (!isObject(value)) throw new ResponseError("invalidResponse");
  return value;
}
function text(value: JsonValue | undefined): string {
  if (typeof value !== "string" || value === "") throw new ResponseError("invalidResponse");
  return value;
}
function branchList(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value) || !value.every((ref) => typeof ref === "string")) throw new ResponseError("invalidBranches");
  return value;
}
