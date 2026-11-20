import type { JsonObject, JsonValue, LocalizedMessages, PluginLocalization, PluginPeer, PluginRuntimeContextV5, StylesheetIntegrationCapabilityV1 } from "@jmfederico/pi-web/plugin-api";

import type definitions from "./workflows.messages.js";

type DialogContext = Pick<PluginRuntimeContextV5, "state" | "catalog" | "navigate">;

/** Plugin-owned UI; all machine operations go through the captured public backend. */
export function openWorktreeDialog(context: DialogContext, peer: PluginPeer, localization: PluginLocalization, messages: LocalizedMessages<typeof definitions>, styles: StylesheetIntegrationCapabilityV1, onClose: () => void): () => void {
  const t = messages.t.bind(messages);
  const project = context.state.selectedProject;
  if (!project) throw new Error(t("noProject"));
  if (!peer.request) throw new Error(t("noRequests"));
  const request = peer.request.bind(peer);
  const projectName = project.name;
  const previousFocus = document.activeElement;
  const host = document.createElement("div");
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      dialog { box-sizing:border-box; max-width:calc(100vw - 24px); overflow-wrap:anywhere; color:var(--pi-text, #eee); background:var(--pi-bg, #202124); border:1px solid var(--pi-border, #666); border-radius:12px; padding:24px; width:min(480px, calc(100vw - 64px)); font:14px system-ui; }
      dialog::backdrop { background:rgb(0 0 0 / .55); }
      h2 { margin-top:0; font-size:20px; } p { line-height:1.5; overflow-wrap:anywhere; }
      label { display:block; margin:16px 0 6px; font-weight:600; }
      input, textarea { box-sizing:border-box; width:100%; padding:10px; font:inherit; color:inherit; background:var(--pi-bg, #202124); border:1px solid var(--pi-border, #888); border-radius:6px; }
      textarea { resize:vertical; min-height:100px; }
      footer { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:10px; margin-top:20px; }
      input { direction:ltr; text-align:start; } textarea { unicode-bidi:plaintext; }
      [role=alert] { color:var(--pi-error, #ffaaaa); } small { display:block; margin-top:6px; line-height:1.5; }
    </style>
    <dialog aria-labelledby="title" aria-describedby="target">
      <h2 id="title"></h2>
      <p id="target"></p>
      <p id="status" role="status"></p>
      <form>
        <label for="base"></label>
        <input id="base" name="base" list="branches" required maxlength="512" disabled>
        <datalist id="branches"></datalist>
        <small id="base-help"></small>
        <label for="description"></label>
        <textarea id="description" dir="auto" name="description" required maxlength="8000" disabled aria-describedby="description-help"></textarea>
        <small id="description-help"></small>
        <p id="error" role="alert" hidden></p>
        <footer><button type="button" id="cancel" class="ui-button"></button><button type="submit" class="ui-button ui-button--primary" disabled></button></footer>
      </form>
    </dialog>`;
  function element<T extends Element>(selector: string, constructor: new () => T): T {
    const value = root.querySelector(selector);
    if (!(value instanceof constructor)) throw new Error(`Missing Workflows control: ${selector}`);
    return value;
  }
  const dialog = element("dialog", HTMLDialogElement);
  const form = element("form", HTMLFormElement);
  const base = element("#base", HTMLInputElement);
  const description = element("#description", HTMLTextAreaElement);
  const submit = element("button[type=submit]", HTMLButtonElement);
  const cancel = element("#cancel", HTMLButtonElement);
  const status = element("#status", HTMLParagraphElement);
  const error = element("#error", HTMLParagraphElement);
  const controller = new AbortController();
  let dispatching = false;
  let dispatched: { workspaceId: string; sessionId: string } | undefined;
  let statusText = () => t("loading");
  let errorText = () => "";
  let closeLabel = false;
  function updateText() {
    host.lang = localization.language;
    host.dir = localization.direction;
    const labels: [string, string][] = [
      ["#title", t("title")], ["label[for=base]", t("base")], ["#base-help", t("baseHelp")],
      ["label[for=description]", t("description")], ["#description-help", t("descriptionHelp")],
      ["#target", t("target", { project: projectName })],
    ];
    for (const [selector, value] of labels) element(selector, HTMLElement).textContent = value;
    submit.textContent = t("title");
    cancel.textContent = t(closeLabel ? "close" : "cancel");
    status.textContent = statusText();
    error.textContent = errorText();
  }
  updateText();
  const releaseStyles = styles.registerRoot(root, { sharedUi: true });
  const unsubscribe = localization.subscribe(updateText);
  base.setAttribute("aria-describedby", "base-help");
  function close() {
    if (controller.signal.aborted) return;
    controller.abort();
    unsubscribe();
    releaseStyles();
    host.remove();
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    onClose();
  }
  function showError(value: () => string) { errorText = value; updateText(); error.hidden = false; }
  function setStatus(value: () => string) { statusText = value; updateText(); }
  // Browser-authored protocol failures retain identity; backend errors are never matched by English text.
  function errorMessage(cause: unknown): string { return cause instanceof ResponseError ? t(cause.key) : message(cause); }
  cancel.addEventListener("click", close);
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); if (!dispatching) close(); });
  dialog.addEventListener("close", close);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (submit.disabled || controller.signal.aborted || dispatching) return;
    if (!description.value.trim() || !base.value.trim()) { showError(() => t("required")); return; }
    dispatching = true;
    submit.disabled = true;
    cancel.disabled = true;
    base.disabled = true;
    description.disabled = true;
    error.hidden = true;
    setStatus(() => t("starting"));
    void (async () => {
      try {
        const result = object(await request("dispatch", { base: base.value.trim(), description: description.value.trim() }, { signal: controller.signal }));
        dispatched = { workspaceId: text(result["workspaceId"]), sessionId: text(result["sessionId"]) };
        if (controller.signal.aborted) return;
        setStatus(() => t("opening"));
        await context.navigate({ machineId: context.catalog.machineId, projectId: project.id, workspaceId: dispatched.workspaceId, sessionId: dispatched.sessionId, view: "chat" });
        close();
      } catch (cause) {
        if (controller.signal.aborted) return;
        closeLabel = true;
        setStatus(() => t(dispatched ? "started" : "uncertain"));
        showError(() => dispatched
          ? t("openSession", { error: errorMessage(cause), session: dispatched.sessionId })
          : t("checkSessions", { error: errorMessage(cause) }));
        // Do not retry an uncertain submission automatically or from this dialog.
      } finally { dispatching = false; cancel.disabled = false; }
    })();
  });
  document.body.append(host);
  dialog.showModal();
  void (async () => {
    try {
      const result = object(await request("prepare", null, { signal: controller.signal }));
      const branches = result["branches"];
      if (!Array.isArray(branches) || !branches.every((branch) => typeof branch === "string")) throw new ResponseError("invalidBranches");
      const defaultBase = text(result["defaultBase"]);
      const workspacePath = text(result["workspacePath"]);
      text(result["workspaceId"]);
      if (controller.signal.aborted) return;
      const options = branches.map((branch) => { const option = document.createElement("option"); option.value = branch; return option; });
      element("#branches", HTMLDataListElement).replaceChildren(...options);
      base.value = defaultBase;
      base.disabled = false;
      description.disabled = false;
      submit.disabled = false;
      setStatus(() => t("workspace", { path: workspacePath }));
      description.focus();
    } catch (cause) {
      if (controller.signal.aborted) return;
      setStatus(() => t("loadFailed"));
      showError(() => errorMessage(cause));
    }
  })();
  return close;
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
function message(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause); }
