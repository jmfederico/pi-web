// @vitest-environment happy-dom
import { installNativeDialogFake } from "./nativeDialog.testSupport";
installNativeDialogFake();
import { installPopoverFake } from "./anchoredPopup.testSupport";
installPopoverFake();

import { afterEach, expect, it, vi } from "vitest";
import { api, trustApi, workspacesApi, type Project, type Workspace } from "../api";
import { localization } from "../localization/browser";
import { projectWorkspaceMessages as messages } from "../projectWorkspaceMessages";
import { ProjectDialog } from "./ProjectDialog";
import { ProjectList } from "./ProjectList";
import { WorkspaceList } from "./WorkspaceList";
import { deepActiveElement, pressKey, requiredElement, settleRenderedDialog } from "./modalSurfaceTestSupport";

let release: (() => void) | undefined;
afterEach(async () => {
  document.body.replaceChildren();
  release?.();
  release = undefined;
  await localization.setPreferences({ language: "en", formatLocale: "en" });
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const project: Project = { id: "project", name: "User <b>project</b>", path: "/work/user-project", createdAt: "" };
const workspace: Workspace = { id: "workspace", projectId: project.id, label: "User <b>workspace</b>", path: "/work/user-workspace", isMain: true, effectiveConfig: {} };

it("changes project registration language without losing the path, focus or trust decision", async () => {
  const folders = vi.spyOn(api, "projectDirectories").mockResolvedValue([{ path: "/work/unchanged", kind: "other" }]);
  const trust = vi.spyOn(trustApi, "projectTrust").mockResolvedValue({ path: "/work/unchanged", decision: false, trusted: false });
  release = localization.registerCatalog({ id: "project-test", namespace: "core.projectWorkspace", locale: "de", load: () => Promise.resolve({
    addProject: "Projekt hinzufügen", trustProject: "Diesem Projekt vertrauen", remoteFolders: "Ordner auf {machine}. Nicht auf dem Browsergerät.",
  }) });
  const dialog = new ProjectDialog();
  dialog.machineId = "remote-user-id";
  dialog.onSubmit = vi.fn();
  document.body.append(dialog);
  await settleRenderedDialog(dialog);
  const input = requiredElement(dialog.shadowRoot?.querySelector<HTMLInputElement>("input.ui-input"), "path");
  input.value = "/work/unchanged";
  input.dispatchEvent(new Event("input"));
  await vi.waitFor(() => { expect(dialog.shadowRoot?.querySelector<HTMLInputElement>("input[aria-describedby^=project-trust-help]")?.disabled).toBe(false); });
  await settleRenderedDialog(dialog);
  const checkbox = requiredElement(dialog.shadowRoot?.querySelector<HTMLInputElement>("input[aria-describedby^=project-trust-help]"), "trust");
  checkbox.checked = true;
  checkbox.dispatchEvent(new Event("change"));
  input.focus();
  const folderCalls = folders.mock.calls.length;
  const trustCalls = trust.mock.calls.length;
  for (const language of ["de", "en-XA", "ar-XB"]) {
    await localization.setPreferences({ language, formatLocale: "de-DE" });
    await settleRenderedDialog(dialog);
    expect(dialog.shadowRoot?.querySelector(".ui-dialog-title")?.textContent).toBe(messages.t("addProject"));
    expect(dialog.shadowRoot?.querySelector("#project-machine-help")?.textContent).toContain("remote-user-id");
    expect(dialog.shadowRoot?.querySelector(".suggestions")?.textContent).toContain("/work/unchanged");
    expect(input.value).toBe("/work/unchanged");
    expect(input.dir).toBe("ltr");
    expect(checkbox.checked).toBe(true);
    expect(deepActiveElement()).toBe(input);
    expect(dialog.onSubmit).not.toHaveBeenCalled();
  }
  expect(folders).toHaveBeenCalledTimes(folderCalls);
  expect(trust).toHaveBeenCalledTimes(trustCalls);
  pressKey(input, "Enter");
  expect(dialog.onSubmit).toHaveBeenCalledExactlyOnceWith("/work/unchanged", true, { trusted: true, changed: true });
});

it("reformats existing lookup failures live, preserves backend diagnostics and retries normally", async () => {
  vi.spyOn(api, "projectDirectories").mockRejectedValue(new Error("backend folders"));
  const trust = vi.spyOn(trustApi, "projectTrust").mockRejectedValue(new Error("Unchanged <b>diagnostic</b>"));
  const dialog = new ProjectDialog();
  document.body.append(dialog);
  await settleRenderedDialog(dialog);
  const input = requiredElement(dialog.shadowRoot?.querySelector<HTMLInputElement>("input.ui-input"), "path");
  input.value = "/work/project";
  input.dispatchEvent(new Event("input"));
  await vi.waitFor(() => { expect(dialog.shadowRoot?.querySelector("#project-trust-error")).not.toBeNull(); });
  await localization.setPreferences({ language: "ar-XB", formatLocale: "en" });
  await settleRenderedDialog(dialog);
  expect(dialog.shadowRoot?.querySelector("#project-trust-error")?.textContent).toBe(messages.t("trustError", { error: "Unchanged <b>diagnostic</b>" }));
  expect(dialog.shadowRoot?.querySelector("#project-trust-error b")).toBeNull();
  expect(dialog.shadowRoot?.querySelector("#project-folder-error")?.textContent).toBe(messages.t("folderError"));
  trust.mockResolvedValue({ path: "/work/project", decision: true, trusted: true });
  requiredElement([...dialog.shadowRoot?.querySelectorAll<HTMLButtonElement>("button") ?? []].find((button) => button.textContent === messages.t("retryTrust")), "retry trust").click();
  await vi.waitFor(() => { expect(dialog.shadowRoot?.querySelector("#project-trust-error")).toBeNull(); });
  expect(dialog.shadowRoot?.querySelector<HTMLInputElement>("input[aria-describedby^=project-trust-help]")?.checked).toBe(true);
});

it("updates project lists and confirmations while preserving row identity, focus and actions", async () => {
  vi.spyOn(workspacesApi, "workspaces").mockResolvedValue([]);
  release = localization.registerCatalog({ id: "project-test", namespace: "core.projectWorkspace", locale: "de", load: () => Promise.resolve({
    projects: "Projekte", actionsFor: "Aktionen für {name}", close: "Schließen", confirmClose: "{name} schließen? Der Ordner bleibt unverändert.",
  }) });
  const list = new ProjectList();
  list.projects = [project];
  list.collapsible = true;
  list.onSelect = vi.fn();
  list.onClose = vi.fn();
  const confirm = vi.fn().mockReturnValue(true);
  vi.stubGlobal("confirm", confirm);
  document.body.append(list);
  await list.updateComplete;
  const row = requiredElement(list.shadowRoot?.querySelector<HTMLElement>("[data-project-id]"), "project row");
  requiredElement(row.querySelector<HTMLButtonElement>(".action-menu-toggle"), "actions").click();
  await list.updateComplete;
  const close = requiredElement(list.shadowRoot?.querySelector<HTMLButtonElement>(".action-menu-panel button"), "close");
  close.focus();
  for (const language of ["de", "en-XA", "ar-XB"]) {
    await localization.setPreferences({ language, formatLocale: "ar-EG" });
    await list.updateComplete;
    expect(list.shadowRoot?.querySelector("[data-project-id]")).toBe(row);
    expect(list.shadowRoot?.querySelector(".section-name")?.textContent).toContain(messages.t("projects"));
    expect(list.shadowRoot?.querySelector(".section-count")?.textContent).toBe(localization.number(1));
    expect(row.textContent).toContain(project.name);
    expect(row.querySelector("b")).toBeNull();
    expect(row.querySelector("bdi[dir=ltr]")?.textContent).toBe(project.path);
    expect(row.querySelector(".action-menu-toggle")?.getAttribute("aria-label")).toBe(messages.t("actionsFor", { name: project.name }));
    expect(close.textContent).toBe(messages.t("close"));
    expect(deepActiveElement()).toBe(close);
    expect(list.onSelect).not.toHaveBeenCalled();
    expect(list.onClose).not.toHaveBeenCalled();
  }
  close.click();
  expect(confirm).toHaveBeenCalledExactlyOnceWith(messages.t("confirmClose", { name: project.name }));
  expect(list.onClose).toHaveBeenCalledExactlyOnceWith(project);
});

it("updates workspace details, main designation and copy status without changing provider content or actions", async () => {
  const trust = vi.spyOn(trustApi, "workspaceTrust").mockResolvedValue({ path: workspace.path, decision: true, trusted: true });
  vi.stubGlobal("isSecureContext", true);
  const clipboard = vi.fn<Clipboard["writeText"]>().mockResolvedValue(undefined);
  vi.spyOn(navigator, "clipboard", "get").mockReturnValue({ writeText: clipboard, read: vi.fn(), readText: vi.fn(), write: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() });
  const list = new WorkspaceList();
  list.workspaces = [{ ...workspace, isMain: false, provider: { pluginId: "provider", capabilities: { remove: true } }, removal: { actionLabel: "Provider-owned action", confirmation: "Provider confirmation", precondition: "v1" } }];
  list.collapsible = true;
  list.onSelect = vi.fn();
  list.onDelete = vi.fn();
  document.body.append(list);
  await list.updateComplete;
  requiredElement(list.shadowRoot?.querySelector<HTMLButtonElement>(".action-menu-toggle"), "actions").click();
  await vi.waitFor(() => { expect(list.shadowRoot?.querySelector<HTMLInputElement>("input[type=checkbox]")?.disabled).toBe(false); });
  const copy = requiredElement(list.shadowRoot?.querySelector<HTMLButtonElement>(".detail-copy"), "copy");
  copy.click();
  await vi.waitFor(() => { expect(copy.title).toBe(messages.t("copied")); });
  for (const language of ["en-XA", "ar-XB"]) {
    await localization.setPreferences({ language, formatLocale: "ar-EG" });
    await list.updateComplete;
    expect(list.shadowRoot?.querySelector(".section-name")?.textContent).toContain(messages.t("workspaces"));
    expect(list.shadowRoot?.querySelector(".section-count")?.textContent).toBe(localization.number(1));
    expect(list.shadowRoot?.querySelector(".workspace-menu-panel")?.textContent).toContain("Provider-owned action");
    expect(list.shadowRoot?.querySelector("bdi[dir=ltr]")?.textContent).toBe(workspace.path);
    expect(copy.title).toBe(messages.t("copied"));
    expect(list.shadowRoot?.querySelector("b")).toBeNull();
    expect(list.onSelect).not.toHaveBeenCalled();
    expect(list.onDelete).not.toHaveBeenCalled();
  }
  expect(trust).toHaveBeenCalledOnce();
  expect(clipboard).toHaveBeenCalledExactlyOnceWith(workspace.label);
  list.workspaces = [workspace];
  await list.updateComplete;
  expect(list.shadowRoot?.querySelector(".workspace-primary-label")?.textContent).toBe(messages.t("mainLabel", { label: workspace.label }));
});

it("releases locale listeners on disconnection", async () => {
  const subscribe = vi.spyOn(localization, "subscribe");
  const list = new WorkspaceList();
  document.body.append(list);
  await list.updateComplete;
  expect(subscribe).toHaveBeenCalledOnce();
  list.remove();
  const update = vi.spyOn(list, "requestUpdate");
  await localization.setPreferences({ language: "ar-XB", formatLocale: "en" });
  expect(update).not.toHaveBeenCalled();
});
